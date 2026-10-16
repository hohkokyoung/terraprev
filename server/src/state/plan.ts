// A Terraform plan (`terraform show -json plan.out`) → the state before it and the state after it,
// plus what happens to each address. Both sides then go through the same graph, pricing and findings
// as a state file, so a plan preview is just a comparison of two snapshots.
//
// New resources have no ids or ARNs yet: Terraform leaves them out and lists them in after_unknown.
// The graph draws arrows by matching ids, so each unknown identifier gets a placeholder that is
// unique per resource attribute, and every attribute that references it (from the plan's
// configuration) gets the same placeholder. The arrows between new resources then line up.

import type { ChangeAction, TfResource } from '../../../shared/types.ts';
import { IDENTIFIER_KEYS } from '../graph/catalog.ts';
import { sensitiveFromMask } from './redact.ts';
import type { ParsedState } from './load.ts';

export interface ParsedPlan {
  before: ParsedState;
  after: ParsedState;
  /** Address → what the plan does to it. Only managed resources that change. */
  actions: Record<string, ChangeAction>;
  /** Address → names of the top-level attributes that change. */
  changedAttrs: Record<string, string[]>;
  /** Addresses where a cost-relevant attribute is only known after apply. */
  unknownAfterApply: string[];
  /** The aws provider's region, when the configuration sets it to a constant. */
  region?: string;
}

const PLACEHOLDER = '(known after apply: ';
/** Stand-in for a value Terraform only knows after apply. */
export const placeholder = (address: string, attr: string) => `${PLACEHOLDER}${address}.${attr})`;
export const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PLACEHOLDER);

/** Attributes the pricing rules read. Unknown at plan time → that line may be missing or wrong. */
const COST_ATTRS = new Set([
  'instance_type', 'instance_class', 'allocated_storage', 'storage_type', 'memory_size', 'architectures', 'desired_capacity', 'min_size',
  'size', 'type', 'billing_mode', 'read_capacity', 'write_capacity', 'multi_az', 'retention_in_days', 'associate_public_ip_address',
  'load_balancer_type', 'subnets', 'subnet_ids', 'vpc_zone_identifier', 'engine', 'period', 'launch_template', 'block_device_mappings',
]);
/** Attributes that hold a list, so a single reference still fills a list. */
const LIST_ATTR = /(s|_identifier)$/;
/** JSON documents built with jsonencode(): a placeholder would only make them unparseable. */
const SKIP_ATTR = /policy$|^tags(_all)?$/;
const NOT_RESOURCES = new Set(['var', 'local', 'module', 'each', 'count', 'path', 'terraform', 'self']);

export function isPlan(json: any): boolean {
  return !!json && typeof json === 'object' && ('planned_values' in json || 'resource_changes' in json);
}

export function parsePlan(json: any): ParsedPlan {
  if (!isPlan(json)) throw new Error('Not a Terraform plan: expected the output of `terraform show -json <planfile>`');
  const changes: any[] = (json.resource_changes ?? []).filter((rc: any) => rc.mode === 'managed');
  const changeOf = new Map(changes.map((rc) => [rc.address as string, rc]));

  const secrets = new Set<string>();
  const priorRaw = valuesResources(json.prior_state?.values?.root_module);
  const afterRaw = valuesResources(json.planned_values?.root_module);
  for (const r of [...priorRaw, ...afterRaw]) sensitiveFromMask(r.values, r.sensitive_values, secrets);
  for (const rc of changes) {
    sensitiveFromMask(rc.change?.before, rc.change?.before_sensitive, secrets);
    sensitiveFromMask(rc.change?.after, rc.change?.after_sensitive, secrets);
  }

  const config = configIndex(json.configuration?.root_module);
  const refsOf = referenceReader(json.configuration?.root_module);
  const before = priorRaw.map((r) => toResource(r));
  // Planned values carry no depends_on; take it from the prior state, or from the configuration.
  const priorDeps = new Map(before.map((r) => [r.address, r.deps]));
  const after = afterRaw.map((r) => {
    const res = toResource(r);
    const cfg = config.get(configKey(res));
    res.deps = priorDeps.get(res.address) ?? (cfg ? configDeps(cfg, res.module, refsOf) : []);
    return res;
  });

  // ── unknown values ──
  const byAddress = new Map(after.map((r) => [r.address, r]));
  const byBase = new Map<string, TfResource[]>();
  for (const r of after) byBase.set(r.baseAddress, [...(byBase.get(r.baseAddress) ?? []), r]);
  // 1. A resource's own unknown identifiers.
  for (const r of after) {
    const unknown = changeOf.get(r.address)?.change?.after_unknown ?? {};
    for (const key of IDENTIFIER_KEYS) if (unknown[key] === true && r.attrs[key] === undefined) r.attrs[key] = placeholder(r.address, key);
  }
  // 2. Attributes that reference other resources: the referenced value, known or placeholder.
  const unknownAfterApply = new Set<string>();
  for (const r of after) {
    const rc = changeOf.get(r.address);
    const unknown = rc?.change?.after_unknown;
    if (!unknown || typeof unknown !== 'object') continue;
    const cfg = config.get(configKey(r));
    const resolveRef = (ref: Ref, list: boolean): string[] => {
      const targets = ref.index !== undefined
        ? [byAddress.get(`${ref.base}${ref.index}`)].filter(Boolean) as TfResource[]
        : byBase.get(ref.base) ?? [];
      const picked = list || targets.length <= 1 ? targets : [targets.find((t) => t.indexKey === r.indexKey) ?? targets[0]];
      return picked.map((t) => {
        const v = t.attrs[ref.attr];
        return typeof v === 'string' ? v : placeholder(t.address, ref.attr);
      });
    };
    fillUnknown(r.attrs, unknown, rc.change.after_sensitive, cfg?.expressions, r.module, { refsOf, resolve: resolveRef });
    // An instance's public IP is unknown until launch, but its subnet decides it, and the pricer reads the subnet.
    const subnet = r.type === 'aws_instance' ? after.find((s) => s.type === 'aws_subnet' && s.attrs.id === r.attrs.subnet_id) : undefined;
    const decided = (k: string) => k === 'associate_public_ip_address' && typeof subnet?.attrs.map_public_ip_on_launch === 'boolean';
    if (Object.entries(unknown).some(([k, u]) => COST_ATTRS.has(k) && hasTrue(u) && (r.attrs[k] === undefined || r.attrs[k] === null) && !decided(k))) unknownAfterApply.add(r.address);
  }

  // ── what happens to each address ──
  const actions: Record<string, ChangeAction> = {};
  const changedAttrs: Record<string, string[]> = {};
  for (const rc of changes) {
    const a: string[] = rc.change?.actions ?? [];
    const action: ChangeAction | undefined =
      a.includes('delete') && a.includes('create') ? 'replace' : a.includes('create') ? 'create' : a.includes('delete') ? 'delete' : a.includes('update') ? 'update' : undefined;
    if (!action) continue;
    actions[rc.address] = action;
    if (action === 'update' || action === 'replace') {
      const b = rc.change.before ?? {}, af = rc.change.after ?? {}, u = rc.change.after_unknown ?? {};
      const exprs = config.get(withoutKeys(String(rc.address)))?.expressions ?? {};
      // An id or ARN that a replacement will recompute is a consequence, not a change anyone made.
      const recomputed = (k: string) => u[k] === true && !(k in exprs) && (IDENTIFIER_KEYS.includes(k) || action === 'replace');
      const keys = [...new Set([...Object.keys(b), ...Object.keys(af), ...Object.keys(u)])]
        .filter((k) => k !== 'tags_all' && !recomputed(k) && (hasTrue(u[k]) || JSON.stringify(b[k] ?? null) !== JSON.stringify(af[k] ?? null)))
        .sort();
      if (keys.length) changedAttrs[rc.address] = keys;
    }
  }

  const version = json.terraform_version ?? '';
  const state = (resources: TfResource[]): ParsedState => ({ serial: 0, lineage: '', terraformVersion: version, resources, secrets });
  const region = json.configuration?.provider_config?.aws?.expressions?.region?.constant_value;
  return {
    before: state(before),
    after: state(after),
    actions,
    changedAttrs,
    unknownAfterApply: [...unknownAfterApply].filter((a) => actions[a] === 'create' || actions[a] === 'replace' || actions[a] === 'update').sort(),
    region: typeof region === 'string' ? region : undefined,
  };
}

// ── values (prior_state.values / planned_values) ──

function valuesResources(mod: any, out: any[] = []): any[] {
  for (const r of mod?.resources ?? []) out.push(r);
  for (const c of mod?.child_modules ?? []) valuesResources(c, out);
  return out;
}

function toResource(r: any): TfResource {
  const address: string = r.address;
  const local = `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`;
  const at = address.indexOf(local, address.startsWith('module.') ? address.lastIndexOf('.' + local) : 0);
  const module = at > 0 ? address.slice(0, at - 1) : undefined;
  const baseAddress = (module ? `${module}.` : '') + local;
  return {
    address,
    baseAddress,
    mode: r.mode,
    type: r.type,
    name: r.name,
    module,
    indexKey: r.index,
    provider: String(r.provider_name ?? '').split('/').pop() ?? '',
    attrs: structuredClone(r.values ?? {}),
    deps: r.depends_on ?? [],
  };
}

// ── configuration: expressions and their references ──

/** "module.net.aws_subnet.a" → that resource's configuration block (expressions, depends_on). */
function configIndex(root: any): Map<string, any> {
  const out = new Map<string, any>();
  const walk = (mod: any, prefix: string) => {
    for (const r of mod?.resources ?? []) out.set(prefix + r.address, r);
    for (const [name, call] of Object.entries<any>(mod?.module_calls ?? {})) walk(call.module, `${prefix}module.${name}.`);
  };
  walk(root, '');
  return out;
}

/** The configuration has one block per module call, whatever its count or for_each: module.a["x"].b[0] → module.a.b */
const withoutKeys = (address: string) => address.replace(/\[[^\]]*\]/g, '');
const configKey = (r: TfResource) => withoutKeys(r.baseAddress);

interface Ref {
  /** Absolute base address, e.g. module.net.aws_subnet.a */
  base: string;
  /** "[0]" or '["a"]' when the reference names one instance. */
  index?: string;
  attr: string;
}
type RefsOf = (expr: any, module: string | undefined) => Ref[];

/**
 * Resource references in one expression, e.g. aws_subnet.a[0].id. A module output (module.net.subnet_id),
 * or an input variable inside a module, is followed to the resources it names. Locals and root
 * variables are skipped: their values are not in the plan's configuration.
 */
function referenceReader(root: any): RefsOf {
  const modules = new Map<string, any>();
  const walk = (mod: any, path: string) => {
    modules.set(path, mod);
    for (const [name, call] of Object.entries<any>(mod?.module_calls ?? {})) walk(call?.module, `${path ? `${path}.` : ''}module.${name}`);
  };
  walk(root, '');
  const within = (module: string | undefined, rest: string) => `${module ? `${module}.` : ''}${rest}`;

  const refsOf = (expr: any, module: string | undefined, depth: number): Ref[] => {
    const raws: string[] = (expr?.references ?? []).map(String);
    // Terraform lists each reference with its prefixes: aws_subnet.a[0].id, aws_subnet.a[0], aws_subnet.a. Keep the longest.
    const longest = raws.filter((r) => !raws.some((o) => o !== r && (o.startsWith(`${r}.`) || o.startsWith(`${r}[`))));
    const out = new Map<string, Ref>();
    for (const raw of longest) {
      const found: Ref[] = [];
      const output = raw.match(/^module\.([A-Za-z_][\w-]*)(\[[^\]]+\])?\.([A-Za-z_][\w-]*)/);
      const input = raw.match(/^var\.([A-Za-z_][\w-]*)/);
      const res = raw.match(/^(data\.)?([a-z][a-z0-9_]*)\.([A-Za-z_][\w-]*)(\[[^\]]+\])?(?:\.([A-Za-z_]\w*))?/);
      if (output && depth < 8) {
        const expression = modules.get(withoutKeys(within(module, `module.${output[1]}`)))?.outputs?.[output[3]]?.expression;
        found.push(...refsOf(expression, within(module, `module.${output[1]}${output[2] ?? ''}`), depth + 1));
      } else if (input && module && depth < 8) {
        const call = module.match(/^(?:(.*)\.)?module\.([A-Za-z_][\w-]*)(?:\[[^\]]*\])?$/);
        const expression = call && modules.get(withoutKeys(call[1] ?? ''))?.module_calls?.[call[2]]?.expressions?.[input[1]];
        found.push(...refsOf(expression, call?.[1], depth + 1));
      } else if (res && (res[1] || !NOT_RESOURCES.has(res[2]))) {
        found.push({ base: within(module, `${res[1] ?? ''}${res[2]}.${res[3]}`), index: res[4], attr: res[5] ?? 'id' });
      }
      for (const ref of found) out.set(`${ref.base}${ref.index ?? ''}.${ref.attr}`, ref);
    }
    return [...out.values()];
  };
  return (expr, module) => refsOf(expr, module, 0);
}

/** Every resource a configuration block refers to, plus its depends_on, as base addresses. */
function configDeps(cfg: any, module: string | undefined, refsOf: RefsOf): string[] {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.references)) for (const r of refsOf(v, module)) out.add(r.base);
      else Object.values(v).forEach(walk);
    }
  };
  walk(cfg.expressions);
  for (const d of cfg.depends_on ?? []) for (const r of refsOf({ references: [d] }, module)) out.add(r.base);
  return [...out];
}

/**
 * Fills unknown values in `target` (planned values) from the references in `exprs` (configuration).
 * `unknown` is Terraform's after_unknown: true for an unknown value, or the same shape as the value.
 * `shape` is after_sensitive, which has an empty object where an unknown value is a map.
 */
function fillUnknown(
  target: Record<string, any>,
  unknown: Record<string, any>,
  shape: any,
  exprs: Record<string, any> | undefined,
  module: string | undefined,
  ctx: { refsOf: RefsOf; resolve: (ref: Ref, list: boolean) => string[] },
) {
  for (const [key, u] of Object.entries(unknown)) {
    if (SKIP_ATTR.test(key) || !hasTrue(u)) continue;
    const expr = exprs?.[key];
    const refs = expr && !Array.isArray(expr) && Array.isArray(expr.references) ? ctx.refsOf(expr, module) : [];
    const values = (list: boolean) => refs.flatMap((ref) => ctx.resolve(ref, list));
    const sub = shape && typeof shape === 'object' ? shape[key] : undefined;
    if (u === true) {
      if ((target[key] !== undefined && target[key] !== null) || !refs.length) continue;
      if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
        // A whole map unknown (the AWS provider does this when any one value is), e.g. Lambda environment
        // variables. Its keys are lost; keep one entry per reference so arrows still find their targets.
        target[key] = Object.fromEntries(refs.flatMap((ref) => {
          const vs = ctx.resolve(ref, true);
          return vs.map((v, i) => [`${ref.base}${ref.index ?? ''}${vs.length > 1 ? `[${i}]` : ''}.${ref.attr}`, v]);
        }));
      } else {
        const list = refs.length > 1 || LIST_ATTR.test(key);
        const v = values(list);
        if (v.length) target[key] = list ? v : v[0];
      }
    } else if (Array.isArray(u)) {
      if (!Array.isArray(target[key])) target[key] = [];
      const listValues = refs.length ? values(true) : [];
      u.forEach((ui, i) => {
        if (ui === true) {
          if ((target[key][i] === undefined || target[key][i] === null) && listValues[i] !== undefined) target[key][i] = listValues[i];
        } else if (ui && typeof ui === 'object') {
          target[key][i] ??= {};
          const block = Array.isArray(expr) ? (expr[i] ?? expr[0]) : undefined;
          fillUnknown(target[key][i], ui, Array.isArray(sub) ? sub[i] : undefined, block, module, ctx);
        }
      });
    } else if (u && typeof u === 'object') {
      target[key] ??= {};
      if (refs.length) {
        // A map built from one expression (e.g. environment variables): fill its unknown keys from it.
        const v = values(false);
        for (const [k, uk] of Object.entries(u)) if (uk === true && v.length && target[key][k] == null) target[key][k] = v[0];
      } else fillUnknown(target[key], u, sub, expr, module, ctx);
    }
  }
}

function hasTrue(u: unknown): boolean {
  if (u === true) return true;
  if (Array.isArray(u)) return u.some(hasTrue);
  if (u && typeof u === 'object') return Object.values(u).some(hasTrue);
  return false;
}
