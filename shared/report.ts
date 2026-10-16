// The "CTO brief": one data model, rendered as an in-page document (web) and as Markdown (web + CLI).
// Everything here is derived from the snapshot; no numbers or findings are invented.

import type { Category, GraphNode, Insight, InsightSeverity, Snapshot } from './types.ts';
import { componentQuantity, formatQuantity, formatUsd, lineCosts, prettyUnit } from './cost.ts';
import { awsName } from './awsNames.ts';
import { pathsInto } from './flow.ts';
import { combinedSaving, priceSavings } from './savings.ts';
import { historySentence, pointTotal, summarizeHistory } from './history.ts';
import { changeText, diffSummary, fieldText, formatDelta, gapText, type Diff } from './compare.ts';

export interface ReportInput {
  snapshot: Snapshot;
  usage: Record<string, number>;
  freeTier: boolean;
  /** A plan preview or comparison: the brief leads with what changes. */
  diff?: Diff;
}

export interface Report {
  title: string;
  /**
   * Fingerprint of everything that went into the report (state, prices, usage, free tier).
   * Same ID = same inputs = byte-identical report. Replaces a wall-clock "generated at".
   */
  id: string;
  meta: { label: string; value: string }[];
  summary: string[];
  kpis: { label: string; value: string; note?: string }[];
  architecture: {
    overview: string[];
    tiers: { tier: string; items: { name: string; kind: string; note?: string }[] }[];
    paths: { to: string; steps: string }[];
    network: { name: string; cidr: string; subnets: { name: string; kind: string; cidr: string; az: string; contains: string[] }[] }[];
  };
  cost: {
    total: number;
    fixed: number;
    usage: number;
    saved: number;
    freeTier: boolean;
    byCategory: { category: string; monthly: number; share: number }[];
    top: { id: string; name: string; kind: string; monthly: number; share: number; usageBased: boolean }[];
    drivers: string[];
    assumptions: { resource: string; label: string; value: string }[];
    unpriced: { address: string; reason: string }[];
    sources: { name: string; published?: string; url?: string }[];
    /** Cheaper ways to run the same stack, biggest first; `total` counts overlapping ones once. */
    savings: { items: { title: string; resource: string; detail: string; caveat?: string; change?: string; monthly: number; perUnit?: string }[]; total: number };
    /** Applies so far (newest last), and what changed over the last month or so. */
    history?: { sentence?: string; points: { serial: number; date: string; total: number; fixed: number }[] };
  };
  changes?: {
    kind: Diff['kind'];
    summary: string;
    before: number;
    after: number;
    delta: number;
    baseLabel: string;
    targetLabel: string;
    rows: { name: string; kind: string; change: string; what: string; before: number; after: number; delta: number; unknown: boolean }[];
    findingsAdded: string[];
    findingsResolved: string[];
    unknownAfterApply: string[];
  };
  findings: { counts: Record<InsightSeverity, number>; items: (Insight & { resourceNames: string[] })[] };
  security: {
    entryPoints: string[];
    rules: { group: string; attachedTo: string[]; ingress: string[] }[];
    roles: { role: string; usedBy: string[]; trustedBy: string[]; permissions: string[] }[];
  };
  inventory: { name: string; kind: string; address: string; monthly?: number }[];
  methodology: string[];
  mermaid: string;
}

const SEVERITY_ORDER: InsightSeverity[] = ['high', 'medium', 'low', 'info', 'good'];
export const SEVERITY_LABEL: Record<InsightSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Note', good: 'Good' };
const CATEGORY_LABEL: Record<Category, string> = {
  compute: 'Compute', database: 'Database', storage: 'Storage', network: 'Networking', integration: 'Messaging',
  api: 'API', security: 'Security & identity', monitoring: 'Monitoring', other: 'Other',
};
const TIER_OF: Partial<Record<Category, string>> = {
  api: 'Edge & entry', network: 'Edge & entry', compute: 'Compute', database: 'Data', storage: 'Data',
  integration: 'Messaging & events', security: 'Identity & secrets', monitoring: 'Observability',
};
const TIER_ORDER = ['Edge & entry', 'Compute', 'Messaging & events', 'Data', 'Identity & secrets', 'Observability'];

const pct = (n: number) => `${Math.round(n * 100)}%`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const kindOf = (n: GraphNode) => awsName(n.type)?.full ?? n.type;

export function buildReport({ snapshot, usage, freeTier, diff }: ReportInput): Report {
  const { graph, cost } = snapshot;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  // Disambiguate components that share a name (e.g. an API Gateway and a Lambda both called "tf-lab-api").
  const nameCount = new Map<string, number>();
  for (const n of graph.nodes) if (n.kind === 'resource' && !n.virtual && !n.supporting) nameCount.set(n.label, (nameCount.get(n.label) ?? 0) + 1);
  const label = (id: string) => {
    const n = nodes.get(id);
    if (!n) return id;
    return (nameCount.get(n.label) ?? 0) > 1 ? `${n.label} (${awsName(n.type)?.service.replace(/^(Amazon|AWS) /, '') ?? n.type})` : n.label;
  };
  const resources = graph.nodes.filter((n) => n.kind === 'resource' && !n.supporting && n.type !== 'internet');
  const real = resources.filter((n) => !n.virtual);

  // ── cost ──
  const lines = lineCosts(cost.components, usage, freeTier);
  const plain = freeTier ? lineCosts(cost.components, usage, false) : lines;
  let fixed = 0, use = 0, saved = 0;
  const byNode = new Map<string, number>();
  const usageNodes = new Set<string>();
  for (const c of cost.components) {
    const m = lines.get(c.id)!.monthly;
    saved += plain.get(c.id)!.monthly - m;
    byNode.set(c.nodeId, (byNode.get(c.nodeId) ?? 0) + m);
    if (c.kind === 'fixed') fixed += m;
    else {
      use += m;
      if (m > 0) usageNodes.add(c.nodeId);
    }
  }
  const total = fixed + use;
  const top = [...byNode.entries()]
    .filter(([id, m]) => nodes.has(id) && m > 0)
    .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0]), 'en') || a[0].localeCompare(b[0], 'en'))
    .map(([id, monthly]) => ({ id, name: label(id), kind: kindOf(nodes.get(id)!), monthly, share: total ? monthly / total : 0, usageBased: usageNodes.has(id) }));
  const catTotals = new Map<string, number>();
  for (const t of top) {
    const n = nodes.get(t.id);
    const cat = CATEGORY_LABEL[n?.category ?? 'other'];
    catTotals.set(cat, (catTotals.get(cat) ?? 0) + t.monthly);
  }
  const byCategory = [...catTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en')).map(([category, monthly]) => ({ category, monthly, share: total ? monthly / total : 0 }));

  const drivers: string[] = [];
  const top3 = top.slice(0, 3);
  if (top3.length) drivers.push(`${list(top3.map((t) => `${t.name} (${formatUsd(t.monthly)}, ${pct(t.share)})`))} make up ${pct(top3.reduce((s, t) => s + t.share, 0))} of the total.`);
  const ipv4 = cost.components.filter((c) => /public IPv4/i.test(c.name)).reduce((s, c) => s + lines.get(c.id)!.monthly, 0);
  if (ipv4 > 0) drivers.push(`Public IPv4 addresses cost ${formatUsd(ipv4)}/month on their own (AWS has charged $0.005/hour per address since February 2024).`);
  const natCost = cost.components.filter((c) => /NAT gateway/i.test(c.name)).reduce((s, c) => s + lines.get(c.id)!.monthly, 0);
  if (natCost > 0) drivers.push(`NAT gateway hours (${formatUsd(natCost)}) are paid whether or not anything uses them.`);
  if (total) drivers.push(`${pct(fixed / total)} of the bill is always-on and won't shrink with low traffic; the rest scales with the usage assumptions below.`);

  const assumptions = cost.usage.map((p) => ({ resource: label(p.nodeId), label: p.label, value: `${formatQuantity(usage[p.key] ?? p.default)} ${p.unit}` }));

  const priced = priceSavings(cost.components, cost.savings, usage, freeTier);
  const savings = {
    items: priced.map(({ saving: s, monthly }) => ({ title: s.title, resource: label(s.nodeId), detail: s.detail, caveat: s.caveat, change: s.change, monthly, perUnit: s.perUnit })),
    total: combinedSaving(priced),
  };
  if (savings.total >= 0.005 && total) drivers.push(`About ${formatUsd(savings.total)}/month (${pct(savings.total / total)}) could be saved without removing anything; see Ways to cut the bill.`);
  const trend = summarizeHistory(snapshot.history);
  const history = trend && snapshot.history!.length > 1
    ? { sentence: historySentence(trend), points: snapshot.history!.slice(-8).map((p) => ({ serial: p.serial, date: utc(p.appliedAt).slice(0, 10), total: pointTotal(p), fixed: p.fixed })) }
    : undefined;
  if (history?.sentence) drivers.push(history.sentence);

  // ── architecture ──
  const vpcs = graph.nodes.filter((n) => n.groupKind === 'vpc');
  const subnets = graph.nodes.filter((n) => n.groupKind === 'subnet');
  const azs = new Set(subnets.map((s) => s.sublabel?.split(' · ')[2]).filter(Boolean));
  const network = vpcs.map((v) => ({
    name: v.label,
    cidr: v.sublabel ?? '',
    subnets: subnets
      .filter((s) => s.parentId === v.id)
      .map((s) => {
        const [kind, cidr, az] = (s.sublabel ?? '').split(' · ');
        return { name: s.label, kind, cidr, az, contains: resources.filter((r) => r.parentId === s.id).map((r) => label(r.id)) };
      }),
  }));
  const tiers = TIER_ORDER.map((tier) => ({
    tier,
    items: real
      .filter((n) => TIER_OF[n.category] === tier && !(n.groupKind))
      .map((n) => ({ name: label(n.id), kind: kindOf(n), note: n.details.find(([k]) => /type|class|runtime|engine|protocol|billing|desired/.test(k))?.join(': ') })),
  })).filter((t) => t.items.length);

  const entryIds = new Set([
    ...graph.edges.filter((e) => e.source === 'internet').map((e) => e.target),
    ...real.filter((n) => n.details.some(([k, v]) => k === 'scheme' && v === 'internet-facing')).map((n) => n.id),
  ]);
  const entry = [...entryIds].map(label);
  const sinks = real.filter((n) => n.category === 'database' || n.category === 'storage' || (n.category === 'compute' && !graph.edges.some((e) => e.source === n.id && e.kind === 'flow')));
  const flowOnly = graph.edges.filter((e) => e.kind === 'flow');
  const paths: Report['architecture']['paths'] = [];
  for (const s of sinks) {
    for (const p of pathsInto(flowOnly, s.id, 4)) {
      paths.push({ to: s.label, steps: p.map((st, i) => (i < p.length - 1 ? `${label(st.node)} ${st.via ? `—${st.via}→` : '→'} ` : label(st.node))).join('') });
    }
  }

  const compute = real.filter((n) => n.category === 'compute');
  const data = real.filter((n) => n.category === 'database' || n.category === 'storage');
  const msg = real.filter((n) => n.category === 'integration');
  const services = new Set(real.map((n) => awsName(n.type)?.service).filter(Boolean));
  const overview: string[] = [];
  if (vpcs.length) {
    overview.push(
      `${vpcs.length === 1 ? `One VPC (${vpcs[0].sublabel})` : `${vpcs.length} VPCs`} spans ${azs.size} availability zone${azs.size === 1 ? '' : 's'} with ${subnets.filter((s) => s.sublabel?.startsWith('public')).length} public and ${subnets.filter((s) => s.sublabel?.startsWith('private')).length} private subnets.`,
    );
  }
  if (entry.length) overview.push(`Public traffic can enter through ${list([...entryIds].map((id) => `${nodes.get(id)!.label} (${awsName(nodes.get(id)!.type)?.service ?? ''})`))}.`);
  if (compute.length) overview.push(`Compute: ${list(compute.map((n) => `${n.label} (${awsName(n.type)?.service ?? n.type})`))}.`);
  if (data.length) overview.push(`State lives in ${list(data.map((n) => `${n.label} (${awsName(n.type)?.service ?? n.type})`))}.`);
  if (msg.length) overview.push(`Asynchronous work flows through ${list(msg.map((n) => `${n.label} (${awsName(n.type)?.service ?? n.type})`))}.`);

  // ── findings ──
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<InsightSeverity, number>;
  for (const i of snapshot.insights) counts[i.severity]++;
  const items = [...snapshot.insights]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id, 'en'))
    .map((i) => ({ ...i, resourceNames: i.nodes.map(label) }));

  // ── security ──
  const rulesMap = new Map<string, Report['security']['rules'][number]>();
  const rolesMap = new Map<string, Report['security']['roles'][number]>();
  for (const n of real) {
    for (const sg of n.access?.securityGroups ?? []) {
      const r = rulesMap.get(sg.address) ?? { group: sg.name, attachedTo: [], ingress: sg.ingress };
      r.attachedTo.push(label(n.id));
      rulesMap.set(sg.address, r);
    }
    for (const role of n.access?.roles ?? []) {
      const r = rolesMap.get(role.address) ?? {
        role: role.name,
        usedBy: [],
        trustedBy: role.trustedBy,
        permissions: role.policies.flatMap((p) => p.statements.map((st) => `${st.effect} ${st.actions.join(', ')} on ${st.resources.join(', ')}`)),
      };
      r.usedBy.push(label(n.id));
      rolesMap.set(role.address, r);
    }
  }

  // ── summary ──
  const high = items.filter((i) => i.severity === 'high');
  const medium = items.filter((i) => i.severity === 'medium');
  const summary = [
    `This stack defines ${snapshot.resourceCount} Terraform resources (${real.length} architectural components across ${services.size} AWS services) in ${cost.region}. ${overview.slice(0, 2).join(' ')}`,
    `Estimated cost is **${formatUsd(total)}/month** at on-demand list prices: ${formatUsd(fixed)} always-on and ${formatUsd(use)} usage-based at the assumptions in this report${freeTier && saved > 0 ? `, after ${formatUsd(saved)} of AWS Free Tier` : ''}. ${drivers[0] ?? ''}`,
    high.length || medium.length
      ? `The review found ${high.length} high and ${medium.length} medium-severity item${high.length + medium.length === 1 ? '' : 's'}. Most important: ${list(high.concat(medium).slice(0, 3).map((i) => i.title.charAt(0).toLowerCase() + i.title.slice(1)))}.`
      : 'The review found no high or medium-severity issues.',
  ];
  if (snapshot.environment) summary.push(`Note: this state was applied to a ${snapshot.environment}.`);
  const changes: Report['changes'] = diff && {
    kind: diff.kind,
    summary: diffSummary(diff),
    before: diff.total.before,
    after: diff.total.after,
    delta: diff.total.delta,
    baseLabel: diff.baseLabel,
    targetLabel: diff.targetLabel,
    rows: diff.nodes.filter((n) => !n.group && (!n.supporting || n.change !== 'changed')).map((n) => ({
      name: n.label, kind: n.kind, change: changeText(diff, n.change),
      what: n.fields.length ? n.fields.map((f) => fieldText(diff, f)).join('; ') : n.attrs.slice(0, 4).join(', '),
      before: n.before, after: n.after, delta: n.delta, unknown: n.unknown,
    })),
    findingsAdded: diff.findings.added.map((f) => `${SEVERITY_LABEL[f.severity]}: ${f.title}`),
    findingsResolved: diff.findings.resolved.map((f) => f.title),
    unknownAfterApply: diff.unknownAfterApply,
  };
  if (diff) {
    summary.unshift(diff.kind === 'plan'
      ? `This brief describes the stack **as it will be after the plan is applied**. The plan changes the bill by **${formatDelta(diff.total.delta)}/month** (${formatUsd(diff.total.before)} → ${formatUsd(diff.total.after)}): ${diffSummary(diff).split(' · ')[0]}.`
      : `This brief describes **${diff.targetLabel}**, compared with ${diff.baseLabel}. It costs **${gapText(diff.total.delta)}** a month (${formatUsd(diff.total.after)} for ${diff.targetLabel}, ${formatUsd(diff.total.before)} for ${diff.baseLabel}).`);
  }

  const kpis = [
    {
      label: diff?.kind === 'stacks' ? `Monthly · ${diff.targetLabel}` : 'Estimated monthly',
      value: formatUsd(total),
      note: diff?.kind === 'stacks' ? `${gapText(diff.total.delta)} than ${diff.baseLabel} (${formatUsd(diff.total.before)})` : freeTier ? 'free tier applied' : 'on-demand, no free tier',
    },
    { label: 'Always-on', value: formatUsd(fixed), note: total ? `${pct(fixed / total)} of total` : undefined },
    { label: 'Components', value: String(real.length), note: `${services.size} AWS services` },
    { label: 'Availability zones', value: String(azs.size || '–') },
    { label: 'Public entry points', value: String(entry.length) },
    { label: 'Findings', value: `${high.length} high · ${medium.length} medium`, note: `${counts.good} strengths noted` },
  ];

  const inventory = real
    .map((n) => ({ name: label(n.id), kind: kindOf(n), address: n.addresses[0] ?? n.id, monthly: byNode.get(n.id) }))
    .sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0) || a.name.localeCompare(b.name, 'en') || a.address.localeCompare(b.address, 'en'));

  return {
    title: diff?.kind === 'stacks'
      ? `${diff.targetLabel} vs ${diff.baseLabel}: architecture & cost comparison`
      : `${vpcs[0]?.label.replace(/-vpc$/, '') ?? 'Infrastructure'}: architecture & cost brief`,
    id: fingerprint({
      lineage: snapshot.lineage,
      serial: snapshot.serial,
      history: (snapshot.history ?? []).map((p) => [p.serial, p.fixed, p.usage]),
      diff: diff && [diff.kind, diff.baseLabel, diff.total.before, diff.nodes.map((n) => `${n.id}:${n.change}`)],
      prices: [...cost.sources].map((x) => `${x.name}@${x.publishedAt ?? ''}`).sort(),
      usage: Object.keys(usage).sort().map((k) => [k, usage[k]]),
      freeTier,
    }),
    meta: diff?.kind === 'plan'
      ? [
        { label: 'Plan', value: snapshot.stateFile.split(/[\\/]/).slice(-2).join('/') },
        { label: 'Region', value: cost.region },
        { label: 'Terraform', value: snapshot.terraformVersion },
        { label: 'Planned', value: utc(snapshot.updatedAt) },
      ]
      : [
        { label: diff?.kind === 'stacks' ? diff.targetLabel : 'Source', value: snapshot.stateFile.split(/[\\/]/).slice(-2).join('/') },
        ...(diff?.kind === 'stacks' ? [{ label: `Compared with ${diff.baseLabel}`, value: diff.baseFile.split(/[\\/]/).slice(-2).join('/') }] : []),
        { label: 'State serial', value: String(snapshot.serial) },
        { label: 'Region', value: cost.region },
        { label: 'Terraform', value: snapshot.terraformVersion },
        { label: 'Last applied', value: utc(snapshot.updatedAt) },
      ],
    summary,
    kpis,
    architecture: { overview, tiers, paths, network },
    cost: {
      total, fixed, usage: use, saved, freeTier, byCategory, top, drivers, assumptions,
      unpriced: cost.unpriced.map((u) => ({ address: u.address, reason: u.reason })),
      sources: cost.sources
        .map((s) => ({ name: s.name.replace('AWS Price List · ', ''), published: s.publishedAt?.slice(0, 10), url: s.pageUrl }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en')),
      savings,
      history,
    },
    changes,
    findings: { counts, items },
    security: {
      entryPoints: [...entry].sort((a, b) => a.localeCompare(b, 'en')),
      rules: [...rulesMap.values()].sort((a, b) => a.group.localeCompare(b.group, 'en')),
      roles: [...rolesMap.values()].sort((a, b) => a.role.localeCompare(b.role, 'en')),
    },
    inventory,
    methodology: [
      'Architecture is read from the Terraform state file (what was last applied), not from the .tf source.',
      'Prices are on-demand list prices in USD from the public AWS Price List API for the region above; a month is 730 hours.',
      `Usage-based charges use the stated assumptions. ${freeTier ? 'AWS Always Free allowances are applied once per account.' : 'Free tier is not applied.'}`,
      'Not included: savings plans / reserved capacity, taxes, support plans, data transfer out to the internet, and resources not priced (listed above).',
      'Ways to cut the bill are priced from the same price lists: an alternative configuration (or a 1-year no-upfront reservation) priced by the same rules, at the same usage.',
      'Findings are derived from resource attributes in state; they flag configuration, not observed runtime behaviour.',
    ],
    mermaid: toMermaid(graph.nodes, graph.edges, byNode),
  };
}

/** Mermaid flowchart: renders natively in GitHub, GitLab, Notion and Confluence. */
export function toMermaid(nodes: GraphNode[], edges: Snapshot['graph']['edges'], cost: Map<string, number>): string {
  const keep = nodes.filter((n) => !n.supporting);
  const ids = new Map(keep.map((n, i) => [n.id, `n${i}`]));
  const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, '');
  const children = new Map<string | undefined, GraphNode[]>();
  for (const n of keep) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : undefined;
    children.set(p, [...(children.get(p) ?? []), n]);
  }
  const out = ['flowchart LR'];
  const emit = (n: GraphNode, depth: number) => {
    const pad = '  '.repeat(depth);
    if (n.kind === 'group') {
      out.push(`${pad}subgraph ${ids.get(n.id)}["${esc(`${n.groupKind === 'provider' ? 'AWS' : n.label}${n.sublabel ? ` · ${n.sublabel}` : ''}`)}"]`);
      for (const c of children.get(n.id) ?? []) emit(c, depth + 1);
      out.push(`${pad}end`);
    } else {
      const c = cost.get(n.id);
      const kind = awsName(n.type)?.service ?? n.sublabel ?? '';
      const shape = n.type === 'internet' ? ['((', '))'] : n.category === 'database' || n.category === 'storage' ? ['[(', ')]'] : ['[', ']'];
      out.push(`${pad}${ids.get(n.id)}${shape[0]}"${esc(n.label)}<br/><small>${esc(kind)}${c ? ` · ${formatUsd(c)}/mo` : ''}</small>"${shape[1]}`);
    }
  };
  for (const n of children.get(undefined) ?? []) emit(n, 1);
  for (const e of edges) {
    const s = ids.get(e.source), t = ids.get(e.target);
    if (!s || !t || e.kind === 'manages' || e.kind === 'route') continue;
    out.push(`  ${s} ${e.kind === 'flow' ? '-->' : '-.->'}${e.label ? `|"${esc(e.label)}"|` : ''} ${t}`);
  }
  return out.join('\n');
}

export function renderMarkdown(r: Report): string {
  const md: string[] = [];
  const table = (head: string[], rows: string[][], align?: string[]) => {
    md.push(`| ${head.join(' | ')} |`, `| ${head.map((_, i) => align?.[i] ?? '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`), '');
  };
  md.push(`# ${r.title}`, '', r.meta.map((m) => `**${m.label}:** ${m.value}`).join(' · '), '', `_Generated by terraprev · report ${r.id}. Same ID means same inputs and identical content._`, '');

  md.push('## Executive summary', '', ...r.summary.flatMap((p) => [p, '']));
  table(['Metric', 'Value', ''], r.kpis.map((k) => [k.label, `**${k.value}**`, k.note ?? '']));

  if (r.changes) {
    const c = r.changes;
    const plan = c.kind === 'plan';
    md.push(plan ? '## What this plan changes' : `## How ${c.targetLabel} differs from ${c.baseLabel}`, '', c.summary, '');
    if (c.rows.length) {
      table(['Resource', plan ? 'Change' : 'Difference', plan ? 'Before' : c.baseLabel, plan ? 'After' : c.targetLabel, plan ? 'Δ / month' : `${c.targetLabel} vs ${c.baseLabel}`],
        c.rows.map((x) => [`${x.name} · ${x.kind}`, `${x.change}${x.what ? ` (${x.what})` : ''}`, x.before ? formatUsd(x.before) : '–', `${x.after ? formatUsd(x.after) : '–'}${x.unknown ? ' ⚠' : ''}`, formatDelta(x.delta)]),
        ['---', '---', '---:', '---:', '---:']);
    }
    if (c.findingsAdded.length) md.push(plan ? '**New findings**' : `**Findings only in ${c.targetLabel}**`, '', ...c.findingsAdded.map((f) => `- ${f}`), '');
    if (c.findingsResolved.length) md.push(plan ? '**Resolved by this plan**' : `**Findings only in ${c.baseLabel}**`, '', ...c.findingsResolved.map((f) => `- ~~${f}~~`), '');
    if (c.unknownAfterApply.length) md.push(`_⚠ Some values are only known after apply, so these may cost more than shown: ${c.unknownAfterApply.map((a) => '`' + a + '`').join(', ')}._`, '');
  }

  md.push('## Architecture', '', ...r.architecture.overview.map((o) => `- ${o}`), '', '```mermaid', r.mermaid, '```', '');
  md.push('### Components by tier', '');
  for (const t of r.architecture.tiers) md.push(`**${t.tier}**`, '', ...t.items.map((i) => `- ${i.name} · ${i.kind}${i.note ? ` · ${i.note}` : ''}`), '');
  if (r.architecture.paths.length) {
    md.push('### Request & data paths', '', 'Every route by which traffic or events reach a data store or compute endpoint:', '');
    md.push(...r.architecture.paths.map((p) => `- ${p.steps}`), '');
  }
  if (r.architecture.network.length) {
    md.push('### Network layout', '');
    for (const v of r.architecture.network) {
      md.push(`**${v.name}** (${v.cidr})`, '');
      table(['Subnet', 'Type', 'CIDR', 'AZ', 'Runs'], v.subnets.map((s) => [s.name, s.kind, s.cidr, s.az, s.contains.join(', ') || '-']));
    }
  }

  md.push('## Cost', '');
  table(['', 'Monthly'], [
    ['Always-on', formatUsd(r.cost.fixed)],
    ['Usage-based (at assumptions below)', formatUsd(r.cost.usage)],
    ...(r.cost.freeTier && r.cost.saved > 0 ? [['AWS Free Tier applied', `−${formatUsd(r.cost.saved)}`]] : []),
    ['**Estimated total**', `**${formatUsd(r.cost.total)}**`],
  ], ['---', '---:']);
  md.push('### What drives the bill', '', ...r.cost.drivers.map((d) => `- ${d}`), '');
  md.push('### By category', '');
  table(['Category', 'Monthly', 'Share'], r.cost.byCategory.map((c) => [c.category, formatUsd(c.monthly), pct(c.share)]), ['---', '---:', '---:']);
  md.push('### By resource', '');
  table(['Resource', 'Type', 'Monthly', 'Share'], r.cost.top.map((t) => [t.name, t.kind, `${t.usageBased ? '~' : ''}${formatUsd(t.monthly)}`, pct(t.share)]), ['---', '---', '---:', '---:']);
  md.push('_~ includes usage-based charges._', '');
  if (r.cost.savings.items.length) {
    md.push('### Ways to cut the bill', '');
    if (r.cost.savings.total >= 0.005) md.push(`Up to **${formatUsd(r.cost.savings.total)}/month** together (savings on the same resource count once).`, '');
    table(['Change', 'Resource', 'Saves / month', 'What it takes'], r.cost.savings.items.map((s) => [s.title + (s.change ? ' · `' + s.change.split('\n')[0] + '`' : ''), s.resource, s.monthly >= 0.005 ? formatUsd(s.monthly) : s.perUnit ?? '-', s.caveat ?? '']), ['---', '---', '---:', '---']);
  }
  if (r.cost.history) {
    md.push('### Cost over time', '');
    if (r.cost.history.sentence) md.push(r.cost.history.sentence, '');
    table(['Applied', 'State serial', 'Always-on', 'Total (default usage)'], r.cost.history.points.map((p) => [p.date, String(p.serial), formatUsd(p.fixed), formatUsd(p.total)]), ['---', '---:', '---:', '---:']);
  }
  if (r.cost.assumptions.length) {
    md.push('### Usage assumptions', '');
    table(['Resource', 'Assumption', 'Value'], r.cost.assumptions.map((a) => [a.resource, a.label, a.value]), ['---', '---', '---:']);
  }
  if (r.cost.unpriced.length) {
    md.push('### Not priced', '');
    md.push(...r.cost.unpriced.map((u) => `- \`${u.address}\`: ${u.reason}`), '');
  }

  md.push('## Findings & recommendations', '', `${SEVERITY_ORDER.map((s) => `${SEVERITY_LABEL[s]}: ${r.findings.counts[s]}`).join(' · ')}`, '');
  for (const sev of SEVERITY_ORDER) {
    const items = r.findings.items.filter((i) => i.severity === sev);
    if (!items.length) continue;
    md.push(`### ${sev === 'good' ? 'Strengths' : `${SEVERITY_LABEL[sev]} priority`}`, '');
    for (const i of items) {
      md.push(`**${i.title}** · _${i.category}_${i.resourceNames.length ? ` · ${i.resourceNames.join(', ')}` : ''}`, '', i.detail, '');
      if (i.recommendation) md.push(`> **Recommendation:** ${i.recommendation}`, '');
    }
  }

  md.push('## Security posture', '');
  if (r.security.entryPoints.length) md.push(`**Internet-facing:** ${r.security.entryPoints.join(', ')}`, '');
  if (r.security.rules.length) {
    md.push('### Network access (security groups)', '');
    table(['Security group', 'Attached to', 'Allows in'], r.security.rules.map((g) => [g.group, g.attachedTo.join(', '), g.ingress.join('; ') || 'nothing']));
  }
  if (r.security.roles.length) {
    md.push('### What each role can do (IAM)', '');
    table(['Role', 'Used by', 'Assumed by', 'Permissions'], r.security.roles.map((x) => [x.role, x.usedBy.join(', '), x.trustedBy.join(', '), x.permissions.join('; ') || 'none']));
  }

  md.push('## Appendix', '', '### Resource inventory', '');
  table(['Name', 'Type', 'Terraform address', 'Monthly'], r.inventory.map((i) => [i.name, i.kind, `\`${i.address}\``, i.monthly ? formatUsd(i.monthly) : '-']), ['---', '---', '---', '---:']);
  md.push('### Pricing sources', '', ...r.cost.sources.map((s) => `- ${s.name}${s.published ? ` (published ${s.published})` : ''}${s.url ? `: ${s.url}` : ''}`), '');
  md.push('### Methodology & caveats', '', ...r.methodology.map((m) => `- ${m}`), '');
  return md.join('\n');
}

/** Usage values to use when nothing was customised (CLI). */
export function defaultUsageValues(snapshot: Snapshot): Record<string, number> {
  return Object.fromEntries(snapshot.cost.usage.map((p) => [p.key, p.default]));
}

export { componentQuantity, prettyUnit };

/** Timezone- and locale-independent timestamp, e.g. "2026-09-12 09:27 UTC". */
export function utc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Short stable hash (FNV-1a, 2×32 bit) of a JSON-serialisable value. Same in Node and the browser. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
