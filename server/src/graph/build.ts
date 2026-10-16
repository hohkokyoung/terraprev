import type { GraphEdge, GraphNode, TfResource } from '../../../shared/types.ts';
import { redactValue } from '../state/redact.ts';
import { isPlaceholder } from '../state/plan.ts';
import { attachAccess } from './access.ts';
import { IDENTIFIER_KEYS, UTILITY_PROVIDERS, displayName, typeInfo, type Link } from './catalog.ts';

export interface BuiltGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** address → node id that represents it (itself, or the parent it was folded into). */
  nodeOf: Map<string, string>;
  region: string | undefined;
}

const EDGE_RANK = { flow: 4, uses: 3, route: 2, manages: 1 } as const;
const MIN_IDENT_LEN = 6;

export function buildGraph(all: TfResource[], secrets: Set<string>, defaultRegion: string): BuiltGraph {
  const resources = all.filter((r) => r.mode === 'managed' && !UTILITY_PROVIDERS.has(r.provider));
  const byAddress = new Map(resources.map((r) => [r.address, r]));
  const byBase = groupBy(resources, (r) => r.baseAddress);

  // ── identifier index: any id/arn/name → resources carrying it ──
  const ident = new Map<string, TfResource[]>();
  for (const r of resources) {
    for (const k of IDENTIFIER_KEYS) {
      const v = r.attrs[k];
      if (typeof v === 'string' && v.length >= MIN_IDENT_LEN) push(ident, v, r);
    }
    // Cognito issuer URLs end in the pool id; RDS endpoints are "host:port".
    if (r.type === 'aws_db_instance' && typeof r.attrs.address === 'string') push(ident, r.attrs.address, r);
  }
  const identList = [...ident.keys()].sort((a, b) => b.length - a.length);

  // ── synthetic parent hints for types whose parent holds the reference ──
  const hints = new Map<string, Record<string, unknown>>();
  const hint = (r: TfResource, k: string, v: unknown) => hints.set(r.address, { ...hints.get(r.address), [k]: v });
  for (const r of resources) {
    if (r.type === 'aws_autoscaling_group') {
      const ltId = r.attrs.launch_template?.[0]?.id ?? r.attrs.mixed_instances_policy?.[0]?.launch_template?.[0]?.launch_template_specification?.[0]?.launch_template_id;
      for (const lt of ident.get(ltId) ?? []) hint(lt, '__asg', r.attrs.arn ?? r.attrs.id);
    }
    if (r.type === 'aws_nat_gateway') for (const e of ident.get(r.attrs.allocation_id) ?? []) hint(e, '__nat', r.attrs.id);
    if (r.type === 'aws_lb_listener' || r.type === 'aws_lb_listener_rule') {
      const lbArn = r.type === 'aws_lb_listener' ? r.attrs.load_balancer_arn : lookupOne(ident, r.attrs.listener_arn)?.attrs.load_balancer_arn;
      for (const tgArn of collectTargetGroups(r.attrs)) for (const tg of ident.get(tgArn) ?? []) hint(tg, '__lb', lbArn);
    }
  }
  const attrsOf = (r: TfResource) => (hints.has(r.address) ? { ...r.attrs, ...hints.get(r.address) } : r.attrs);

  // ── fold children (listeners, stages, versions...) into their parent ──
  const parentOf = new Map<string, TfResource>();
  for (const r of resources) {
    const ref = typeInfo(r).absorbInto?.(attrsOf(r));
    const p = typeof ref === 'string' ? lookupOne(ident, ref, r) : undefined;
    if (p && p !== r) parentOf.set(r.address, p);
  }
  const rootOf = (r: TfResource): TfResource => {
    let cur = r;
    for (let i = 0; i < 5 && parentOf.has(cur.address); i++) cur = parentOf.get(cur.address)!;
    return cur;
  };

  const region = detectRegion(resources) ?? defaultRegion;
  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const nodeOf = new Map<string, string>();
  const addNode = (n: GraphNode) => {
    nodes.push(n);
    nodeById.set(n.id, n);
  };

  // ── provider groups ──
  const providerGroup = (provider: string) => {
    const id = `provider:${provider}`;
    if (!nodeById.has(id)) {
      addNode({
        id, kind: 'group', groupKind: 'provider', type: provider, provider, category: 'other', addresses: [], details: [],
        label: provider === 'aws' ? 'AWS' : provider,
        sublabel: provider === 'aws' ? region : undefined,
      });
    }
    return id;
  };

  // ── VPC + subnet containers ──
  const publicSubnets = findPublicSubnets(resources, ident);
  const subnetGroupId = new Map<string, string>(); // subnet id → node id
  const vpcGroupId = new Map<string, string>();
  for (const r of resources.filter((r) => r.type === 'aws_vpc')) {
    addNode({
      id: r.address, kind: 'group', groupKind: 'vpc', type: r.type, provider: r.provider, category: 'network',
      label: displayName(r), sublabel: r.attrs.cidr_block, addresses: [r.address], details: [['id', isPlaceholder(r.attrs.id) ? 'known after apply' : r.attrs.id]],
      parentId: providerGroup(r.provider),
    });
    vpcGroupId.set(r.attrs.id, r.address);
    nodeOf.set(r.address, r.address);
  }
  const subnets = resources.filter((r) => r.type === 'aws_subnet').sort((a, b) => `${a.attrs.availability_zone}`.localeCompare(`${b.attrs.availability_zone}`));
  for (const r of subnets) {
    const isPublic = publicSubnets.has(r.attrs.id);
    addNode({
      id: r.address, kind: 'group', groupKind: 'subnet', type: r.type, provider: r.provider, category: 'network',
      label: displayName(r),
      sublabel: `${isPublic ? 'public' : 'private'} · ${r.attrs.cidr_block} · ${r.attrs.availability_zone}`,
      addresses: [r.address], details: [['id', isPlaceholder(r.attrs.id) ? 'known after apply' : r.attrs.id]],
      parentId: vpcGroupId.get(r.attrs.vpc_id) ?? providerGroup(r.provider),
    });
    subnetGroupId.set(r.attrs.id, r.address);
    nodeOf.set(r.address, r.address);
  }

  const placement = (r: TfResource): string => {
    const a = r.attrs;
    const vpcOfSubnet = (sid: string) => byAddress.get(subnetGroupId.get(sid) ?? '')?.attrs.vpc_id;
    if (typeof a.subnet_id === 'string' && subnetGroupId.has(a.subnet_id)) return subnetGroupId.get(a.subnet_id)!;
    if (r.type === 'aws_db_instance') {
      const group = resources.find((g) => g.type === 'aws_db_subnet_group' && g.attrs.name === a.db_subnet_group_name);
      const ids: string[] = group?.attrs.subnet_ids ?? [];
      const inAz = ids.find((sid) => byAddress.get(subnetGroupId.get(sid) ?? '')?.attrs.availability_zone === a.availability_zone);
      if (inAz && !a.multi_az) return subnetGroupId.get(inAz)!;
      if (ids[0] && vpcGroupId.has(vpcOfSubnet(ids[0]))) return vpcGroupId.get(vpcOfSubnet(ids[0]))!;
    }
    const multi: string[] = a.vpc_zone_identifier ?? a.subnets ?? a.vpc_config?.[0]?.subnet_ids ?? a.subnet_ids ?? [];
    const vpcId = a.vpc_id ?? a.vpc_config?.[0]?.vpc_id ?? (multi[0] ? vpcOfSubnet(multi[0]) : undefined);
    if (vpcId && vpcGroupId.has(vpcId)) return vpcGroupId.get(vpcId)!;
    return providerGroup(r.provider);
  };

  // ── resource nodes ──
  for (const r of resources) {
    if (r.type === 'aws_vpc' || r.type === 'aws_subnet' || parentOf.has(r.address)) continue;
    const info = typeInfo(r);
    addNode({
      id: r.address, kind: 'resource', type: r.type, provider: r.provider, category: info.category,
      label: displayName(r), sublabel: info.short, addresses: [r.address], details: [],
      supporting: info.supporting, parentId: placement(r),
    });
    nodeOf.set(r.address, r.address);
  }
  // Absorbed children: attach address + details to the parent node.
  for (const r of resources) {
    if (!parentOf.has(r.address)) continue;
    const root = rootOf(r);
    nodeOf.set(r.address, nodeOf.get(root.address) ?? root.address);
    nodeById.get(nodeOf.get(r.address)!)?.addresses.push(r.address);
  }
  // Details, in address order so the parent's own details come first.
  for (const n of nodes) {
    if (n.kind !== 'resource') continue;
    for (const addr of n.addresses) {
      const r = byAddress.get(addr)!;
      for (const [k, v] of typeInfo(r).details?.(attrsOf(r)) ?? []) {
        if (v === undefined || v === null || v === '' || v === 'undefined') continue;
        n.details.push([k, isPlaceholder(v) ? 'known after apply' : redactValue(k, String(v), secrets)]);
      }
    }
  }

  // ── ASG: draw the instances it launches, spread across its subnets ──
  for (const asg of resources.filter((r) => r.type === 'aws_autoscaling_group')) {
    const lt = resources.find((r) => r.type === 'aws_launch_template' && parentOf.get(r.address) === asg);
    const subnetIds: string[] = [...(asg.attrs.vpc_zone_identifier ?? [])].sort((a, b) =>
      `${byAddress.get(subnetGroupId.get(a) ?? '')?.attrs.availability_zone}`.localeCompare(`${byAddress.get(subnetGroupId.get(b) ?? '')?.attrs.availability_zone}`),
    );
    const n = Number(asg.attrs.desired_capacity ?? asg.attrs.min_size ?? 0);
    const asgNode = nodeById.get(asg.address)!;
    if (lt?.attrs.instance_type) asgNode.details.unshift(['instance type', lt.attrs.instance_type]);
    for (let i = 0; i < n; i++) {
      const sid = subnetIds[i % Math.max(1, subnetIds.length)];
      const id = `${asg.address}#${i + 1}`;
      addNode({
        id, kind: 'resource', type: 'aws_instance', provider: asg.provider, category: 'compute', virtual: true,
        label: `${displayName(asg)} #${i + 1}`, sublabel: 'EC2',
        addresses: [], details: [['type', lt?.attrs.instance_type ?? '?'], ['launched by', displayName(asg)]],
        parentId: subnetGroupId.get(sid) ?? asgNode.parentId,
      });
    }
  }

  // ── edges ──
  const edges = new Map<string, GraphEdge>();
  const addEdge = (source: string | undefined, target: string | undefined, kind: GraphEdge['kind'], label?: string) => {
    if (!source || !target || source === target) return;
    const s = nodeById.get(source), t = nodeById.get(target);
    if (!s || !t) return;
    // Containment already says "this lives in that VPC/subnet".
    if (t.kind === 'group' || s.kind === 'group' && kind !== 'route') return;
    const key = `${source}->${target}`;
    const rev = edges.get(`${target}->${source}`);
    if (rev && EDGE_RANK[rev.kind] >= EDGE_RANK[kind]) return;
    const prev = edges.get(key);
    if (prev && (EDGE_RANK[prev.kind] > EDGE_RANK[kind] || (prev.kind === kind && (prev.label || !label)))) return;
    if (rev) edges.delete(`${target}->${source}`);
    edges.set(key, { id: key, source, target, kind, label });
  };
  const resolve = (value: unknown, self?: TfResource): string | undefined => {
    if (typeof value !== 'string' || value.length < MIN_IDENT_LEN) return undefined;
    let r = lookupOne(ident, value, self);
    if (!r) {
      const hit = identList.find((id) => id.length >= 8 && value.includes(id));
      r = hit ? lookupOne(ident, hit, self) : undefined;
    }
    return r ? nodeOf.get(r.address) : undefined;
  };

  // 1. Relationship resources and inline links (subscriptions, triggers, integrations, DLQs).
  for (const r of resources) {
    for (const l of typeInfo(r).links?.(r.attrs) ?? ([] as Link[])) {
      addEdge(resolve(l.from), resolve(l.to), l.kind ?? 'flow', l.label || undefined);
    }
  }
  // 2. References inside attributes (env vars, ARNs, names) → "uses".
  for (const r of resources) {
    const src = nodeOf.get(r.address);
    if (!src || nodeById.get(src)?.kind === 'group' || typeInfo(r).links) continue;
    const inbound = new Set(typeInfo(r).inboundRefs ?? []);
    const own = new Set(IDENTIFIER_KEYS.map((k) => r.attrs[k]));
    walkStrings(r.attrs, (key, value) => {
      if (own.has(value) || key === 'tags' || key === 'tags_all') return;
      const r2 = lookupOne(ident, value, r);
      if (!r2) return;
      const dst = nodeOf.get(r2.address);
      if (inbound.has(key)) addEdge(dst, src, 'flow');
      else if (typeInfo(r).describes) addEdge(dst, src, 'uses');
      else addEdge(src, dst, 'uses');
    });
  }
  // 3. Explicit depends_on / implicit deps that the attributes didn't reveal.
  for (const r of resources) {
    const src = nodeOf.get(r.address);
    if (!src || nodeById.get(src)?.supporting || typeInfo(r).links) continue;
    for (const dep of r.deps) {
      for (const d of byBase.get(dep) ?? []) {
        const dst = nodeOf.get(d.address);
        if (!dst || nodeById.get(dst)?.supporting) continue;
        if (edges.has(`${src}->${dst}`) || edges.has(`${dst}->${src}`)) continue;
        // A log group "depends on" the thing whose name it borrows; logs actually flow the other way.
        if (r.type === 'aws_cloudwatch_log_group') {
          if (nodeById.get(dst)?.category === 'compute') addEdge(dst, src, 'uses', 'logs');
        } else if (typeInfo(r).describes) addEdge(dst, src, 'uses');
        else addEdge(src, dst, 'uses');
      }
    }
  }
  // 4. Routing: subnet → NAT / IGW, from route table associations.
  for (const assoc of resources.filter((r) => r.type === 'aws_route_table_association' && r.attrs.subnet_id)) {
    const rt = lookupOne(ident, assoc.attrs.route_table_id);
    for (const route of rt?.attrs.route ?? []) {
      const via = route.nat_gateway_id || route.gateway_id;
      if (via && (route.cidr_block === '0.0.0.0/0' || route.ipv6_cidr_block === '::/0')) {
        addEdge(subnetGroupId.get(assoc.attrs.subnet_id), resolve(via), 'route', route.nat_gateway_id ? 'egress' : 'internet');
      }
    }
  }
  // 5. ASG manages its instances.
  for (const n of nodes.filter((n) => n.virtual)) addEdge(n.id.split('#')[0], n.id, 'manages');

  // 6. Public entry points get an "Internet" node so the request path reads left → right.
  const entries = nodes.filter((n) => {
    const r = byAddress.get(n.id);
    if (!r) return false;
    if (r.type === 'aws_lb') return !r.attrs.internal;
    if (r.type === 'aws_apigatewayv2_api' || r.type === 'aws_api_gateway_rest_api' || r.type === 'aws_cloudfront_distribution') return true;
    return false;
  });
  if (entries.length) {
    addNode({ id: 'internet', kind: 'resource', type: 'internet', provider: 'internet', category: 'other', label: 'Internet', sublabel: 'users', addresses: [], details: [], virtual: true });
    // Only entries not already fronted by another entry (API GW → ALB means users hit API GW).
    const fronted = new Set([...edges.values()].filter((e) => entries.some((x) => x.id === e.source)).map((e) => e.target));
    for (const e of entries) if (!fronted.has(e.id)) addEdge('internet', e.id, 'flow');
  }

  attachAccess(nodes, resources, byAddress, nodeOf, (v) => lookupOne(ident, v));

  // 7. Network reachability from security groups: if db-sg allows tcp 5432 from app-sg,
  //    everything wearing app-sg can open connections to everything wearing db-sg.
  const wearers = new Map<string, string[]>(); // SG id → node ids
  for (const n of nodes) {
    for (const sg of n.access?.securityGroups ?? []) {
      const id = byAddress.get(sg.address)?.attrs.id;
      if (id) wearers.set(id, [...(wearers.get(id) ?? []), n.id]);
    }
  }
  for (const sg of resources.filter((r) => r.type === 'aws_security_group')) {
    for (const rule of sg.attrs.ingress ?? []) {
      const port = rule.protocol === '-1' ? 'all traffic' : `${rule.protocol} ${rule.from_port === rule.to_port ? rule.from_port : `${rule.from_port}-${rule.to_port}`}`;
      for (const srcSg of rule.security_groups ?? []) {
        for (const from of wearers.get(srcSg) ?? []) {
          for (const to of wearers.get(sg.attrs.id) ?? []) {
            const existing = edges.get(`${from}->${to}`);
            if (!existing) addEdge(from, to, 'flow', port);
            else if (existing.kind === 'flow' && !existing.label) existing.label = port;
          }
        }
      }
    }
  }

  return { nodes, edges: [...edges.values()], nodeOf, region };
}

// ── helpers ──

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) push(m, key(x), x);
  return m;
}

/** Picks the most meaningful resource for an identifier: drawn nodes beat supporting ones. */
function lookupOne(ident: Map<string, TfResource[]>, value: unknown, self?: TfResource): TfResource | undefined {
  if (typeof value !== 'string') return undefined;
  const hits = (ident.get(value) ?? []).filter((r) => r !== self);
  if (hits.length <= 1) return hits[0];
  return [...hits].sort((a, b) => score(b) - score(a))[0];
}

function score(r: TfResource): number {
  const info = typeInfo(r);
  return (info.supporting ? 0 : 2) + (info.absorbInto ? 0 : 1);
}

function walkStrings(v: any, fn: (key: string, value: string) => void, key = '') {
  if (typeof v === 'string') {
    if (v.length >= MIN_IDENT_LEN) fn(key, v);
  } else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkStrings(x, fn, key === 'tags' || key === 'tags_all' ? key : k);
}

function collectTargetGroups(a: any): string[] {
  const out: string[] = [];
  walkStrings(a, (k, v) => {
    if (k === 'target_group_arn' || (k === 'arn' && v.includes(':targetgroup/'))) out.push(v);
  });
  return out;
}

function findPublicSubnets(resources: TfResource[], ident: Map<string, TfResource[]>): Set<string> {
  const out = new Set<string>();
  for (const r of resources) {
    if (r.type === 'aws_subnet' && r.attrs.map_public_ip_on_launch) out.add(r.attrs.id);
    if (r.type === 'aws_route_table_association' && r.attrs.subnet_id) {
      const rt = lookupOne(ident, r.attrs.route_table_id);
      if (rt?.attrs.route?.some((x: any) => typeof x.gateway_id === 'string' && x.gateway_id.startsWith('igw-'))) out.add(r.attrs.subnet_id);
    }
  }
  return out;
}

function detectRegion(resources: TfResource[]): string | undefined {
  for (const r of resources) {
    const m = typeof r.attrs.arn === 'string' && r.attrs.arn.match(/^arn:aws[\w-]*:[\w-]+:([a-z]{2}(?:-gov)?-[a-z]+-\d):/);
    if (m) return m[1];
  }
  for (const r of resources) {
    const az = r.attrs.availability_zone;
    if (typeof az === 'string' && /\d[a-z]$/.test(az)) return az.slice(0, -1);
  }
  return undefined;
}
