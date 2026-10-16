// Two snapshots side by side: a plan's before/after, or two stacks. Shared by the page (which reprices
// as the sliders move), the CLI (Markdown for a PR comment) and the MCP server.

import type { ChangeAction, Comparison, GraphEdge, GraphNode, Insight, Snapshot } from './types.ts';
import { defaultUsage, formatUsd, lineCosts } from './cost.ts';
import { awsName } from './awsNames.ts';

export type NodeChange = 'added' | 'removed' | 'changed' | 'replaced';

export interface NodeDiff {
  id: string;
  label: string;
  /** e.g. "Amazon RDS DB instance". */
  kind: string;
  change: NodeChange;
  /** Diagram groups (VPCs, subnets) and supporting resources (IAM, SGs) sort after the rest. */
  group?: boolean;
  supporting?: boolean;
  before: number;
  after: number;
  delta: number;
  /** Shown configuration that differs. Same redacted values the inspector shows. */
  fields: { key: string; before?: string; after?: string }[];
  /** Attribute names a plan changes (no values: they may be secret). */
  attrs: string[];
  addresses: string[];
  /** Some cost-relevant value is only known after apply. */
  unknown: boolean;
}

export interface Diff {
  kind: Comparison['kind'];
  baseLabel: string;
  targetLabel: string;
  /** Biggest cost change first. */
  nodes: NodeDiff[];
  /** Node id → change, for every changed node including ASG instances. */
  status: Map<string, NodeChange>;
  /** Terraform addresses per action (plans), or only-in-one-side (stacks). */
  resources: Record<ChangeAction, number>;
  total: { before: number; after: number; delta: number; fixedBefore: number; fixedAfter: number };
  findings: { added: Insight[]; resolved: Insight[] };
  /** Removed nodes (and edges touching them), to draw faded on the "after" diagram. */
  ghosts: { nodes: GraphNode[]; edges: GraphEdge[] };
  unknownAfterApply: string[];
  /** The state file (or plan) of the "before" side, for the brief's header. */
  baseFile: string;
}

/** Configuration keys that differ between any two stacks without meaning anything. */
const IDENTITY_KEYS = new Set(['id', 'arn', 'dns', 'endpoint', 'public ip', 'url', 'address', 'invoke url']);

/**
 * `usage` is the slider values for the target; the base side uses the same values where the keys
 * match (keys are Terraform addresses, so they do across a plan and across stacks built from the
 * same code), and its own defaults elsewhere.
 */
export function diffSnapshots(cmp: Comparison, target: Snapshot, usage: Record<string, number>, freeTier: boolean): Diff {
  const base = cmp.base;
  const baseNodes = new Map(base.graph.nodes.map((n) => [n.id, n]));
  const targetNodes = new Map(target.graph.nodes.map((n) => [n.id, n]));

  // ── cost on both sides, same usage ──
  const targetValues = { ...defaultUsage(target.cost.usage), ...usage };
  const baseValues = { ...defaultUsage(base.cost.usage), ...pick(usage, base.cost.usage.map((p) => p.key)) };
  const sumBy = (s: Snapshot, values: Record<string, number>) => {
    const lines = lineCosts(s.cost.components, values, freeTier);
    const byNode = new Map<string, number>();
    let total = 0, fixed = 0;
    for (const c of s.cost.components) {
      const m = lines.get(c.id)!.monthly;
      byNode.set(c.nodeId, (byNode.get(c.nodeId) ?? 0) + m);
      total += m;
      if (c.kind === 'fixed') fixed += m;
    }
    return { byNode, total, fixed };
  };
  const before = sumBy(base, baseValues);
  const after = sumBy(target, targetValues);

  // ── what changed, per node ──
  const unknown = new Set(cmp.unknownAfterApply ?? []);
  const label = labeller([...target.graph.nodes, ...base.graph.nodes.filter((n) => !targetNodes.has(n.id))]);
  const status = new Map<string, NodeChange>();
  const nodes: NodeDiff[] = [];
  const consider = (n: GraphNode) => n.groupKind !== 'provider' && n.type !== 'internet';

  for (const n of target.graph.nodes.filter(consider)) {
    const was = baseNodes.get(n.id);
    const acts = n.addresses.map((a) => cmp.actions[a]).filter(Boolean);
    const fields = was ? fieldDiff(was.details, n.details) : [];
    const b = before.byNode.get(n.id) ?? 0, a = after.byNode.get(n.id) ?? 0;
    let change: NodeChange | undefined;
    if (!was || cmp.actions[n.addresses[0] ?? n.id] === 'create') change = 'added';
    else if (acts.includes('replace')) change = 'replaced';
    else if (acts.length) change = 'changed';
    // Stacks have no plan: changed means the shown configuration or the cost differs.
    else if (cmp.kind === 'stacks' && (fields.length || Math.abs(a - b) >= 0.005)) change = 'changed';
    if (!change) continue;
    status.set(n.id, change);
    if (n.virtual) continue; // an ASG's instances: drawn, but the ASG carries the change and the cost
    nodes.push({
      id: n.id, label: label(n.id), kind: kindOf(n), change, group: n.kind === 'group', supporting: n.supporting,
      before: b, after: a, delta: a - b, fields,
      attrs: [...new Set(n.addresses.flatMap((x) => cmp.changedAttrs?.[x] ?? []))].sort(),
      addresses: n.addresses.filter((x) => cmp.actions[x] || cmp.kind === 'stacks'),
      unknown: n.addresses.some((x) => unknown.has(x)),
    });
  }

  // Removed: in the base, gone from the target.
  const removed = base.graph.nodes.filter((n) => consider(n) && !targetNodes.has(n.id));
  const removedIds = new Set(removed.map((n) => n.id));
  for (const n of removed) {
    status.set(n.id, 'removed');
    if (n.virtual) continue;
    const b = before.byNode.get(n.id) ?? 0;
    nodes.push({
      id: n.id, label: label(n.id), kind: kindOf(n), change: 'removed', group: n.kind === 'group', supporting: n.supporting,
      before: b, after: 0, delta: -b, fields: [], attrs: [], addresses: n.addresses, unknown: false,
    });
  }
  const rank = (d: NodeDiff) => (d.group ? 2 : d.supporting ? 1 : 0);
  nodes.sort((x, y) => rank(x) - rank(y) || Math.abs(y.delta) - Math.abs(x.delta) || x.label.localeCompare(y.label, 'en') || x.id.localeCompare(y.id, 'en'));

  // Ghosts hang off the nearest ancestor that still exists, so they stay where they were.
  const anchor = (id: string | undefined): string | undefined => {
    for (let cur = id; cur; cur = baseNodes.get(cur)?.parentId) if (targetNodes.has(cur) || removedIds.has(cur)) return cur;
    return target.graph.nodes.find((n) => n.groupKind === 'provider')?.id;
  };
  const ghosts = {
    nodes: removed.map((n) => ({ ...n, parentId: anchor(n.parentId) })),
    edges: base.graph.edges.filter((e) => (removedIds.has(e.source) || removedIds.has(e.target)) && (targetNodes.has(e.source) || removedIds.has(e.source)) && (targetNodes.has(e.target) || removedIds.has(e.target))),
  };

  // ── findings ──
  const baseIds = new Set(base.insights.map((i) => i.id));
  const targetIds = new Set(target.insights.map((i) => i.id));

  const resources: Record<ChangeAction, number> = { create: 0, update: 0, replace: 0, delete: 0 };
  for (const a of Object.values(cmp.actions)) resources[a]++;

  return {
    kind: cmp.kind,
    baseLabel: cmp.baseLabel,
    targetLabel: cmp.targetLabel,
    nodes,
    status,
    resources,
    total: { before: before.total, after: after.total, delta: after.total - before.total, fixedBefore: before.fixed, fixedAfter: after.fixed },
    findings: {
      added: target.insights.filter((i) => !baseIds.has(i.id) && i.severity !== 'good'),
      resolved: base.insights.filter((i) => !targetIds.has(i.id) && i.severity !== 'good'),
    },
    ghosts,
    unknownAfterApply: [...unknown],
    baseFile: base.stateFile,
  };
}

/** "+$211.65/mo" style, with a real minus sign. */
export function formatDelta(n: number): string {
  if (Math.abs(n) < 0.005) return '±$0';
  return `${n > 0 ? '+' : '−'}${formatUsd(Math.abs(n))}`;
}

/** What a plan does to a resource, as a pill. */
export const CHANGE_LABEL: Record<NodeChange, string> = { added: 'add', changed: 'change', replaced: 'replace', removed: 'destroy' };

type Sides = Pick<Diff, 'kind' | 'baseLabel' | 'targetLabel'>;

/** "add" for a plan; "only in prod" or "differs" for two stacks. */
export function changeText(d: Sides, change: NodeChange): string {
  if (d.kind === 'plan') return CHANGE_LABEL[change];
  return change === 'added' ? `only in ${d.targetLabel}` : change === 'removed' ? `only in ${d.baseLabel}` : 'differs';
}

/**
 * Two values of one setting. A plan goes from one to the other ("t3.small → t3.medium"); two stacks
 * both exist, so they sit side by side ("staging t3.small · prod t3.medium").
 */
export function pairText(d: Sides, before: string | undefined, after: string | undefined): string {
  return d.kind === 'plan' ? `${before ?? '–'} → ${after ?? '–'}` : `${d.baseLabel} ${before ?? '–'} · ${d.targetLabel} ${after ?? '–'}`;
}

/** One differing setting, e.g. "desired: 3 → 4", or "desired: staging 1 · prod 3". */
export function fieldText(d: Sides, f: NodeDiff['fields'][number]): string {
  return `${f.key}: ${pairText(d, f.before, f.after)}`;
}

/** How much more or less the stack on show costs: "$43.40 more", "$2.10 less", "the same". No judgement: prod is meant to cost more. */
export function gapText(delta: number): string {
  if (Math.abs(delta) < 0.005) return 'the same';
  return `${formatUsd(Math.abs(delta))} ${delta > 0 ? 'more' : 'less'}`;
}

/** One line, e.g. "2 to add, 1 to change, 1 to destroy · $123.45 → $335.10/mo (+$211.65)". */
export function diffSummary(d: Diff): string {
  const r = d.resources;
  if (d.kind === 'plan') {
    const counts = [r.create && `${r.create} to add`, r.update && `${r.update} to change`, r.replace && `${r.replace} to replace`, r.delete && `${r.delete} to destroy`].filter(Boolean).join(', ') || 'no changes';
    return `${counts} · ${formatUsd(d.total.before)} → ${formatUsd(d.total.after)}/mo (${formatDelta(d.total.delta)})`;
  }
  const counts = `${d.nodes.filter((n) => n.change === 'added' && !n.group).length} only in ${d.targetLabel}, ${d.nodes.filter((n) => n.change === 'changed' || n.change === 'replaced').length} differ, ${d.nodes.filter((n) => n.change === 'removed' && !n.group).length} only in ${d.baseLabel}`;
  // e.g. "… · staging $64.97/mo, prod $108.36/mo ($43.40 more)"
  return `${counts} · ${d.baseLabel} ${formatUsd(d.total.before)}/mo, ${d.targetLabel} ${formatUsd(d.total.after)}/mo (${gapText(d.total.delta)})`;
}

/** The comparison as Markdown, ready to paste into a pull request. */
export function renderDiffMarkdown(d: Diff): string {
  const md: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const money = (n: number) => (n ? formatUsd(n) : '–');
  md.push(d.kind === 'plan' ? '## terraprev: plan preview' : `## terraprev: ${d.targetLabel} compared with ${d.baseLabel}`, '');
  const counts = diffSummary(d).split(' · ')[0];
  md.push(d.kind === 'plan'
    ? `**${formatDelta(d.total.delta)}/month** (${formatUsd(d.total.before)} → ${formatUsd(d.total.after)}) · ${counts}`
    : `**${d.targetLabel} costs ${gapText(d.total.delta)}${Math.abs(d.total.delta) < 0.005 ? ' as' : ' than'} ${d.baseLabel}** (${d.baseLabel} ${formatUsd(d.total.before)}/month, ${d.targetLabel} ${formatUsd(d.total.after)}/month) · ${counts}`, '');
  const rows = d.nodes.filter((n) => !n.group && (!n.supporting || n.change !== 'changed' || n.fields.length || n.attrs.length));
  if (rows.length) {
    md.push(`| Resource | ${d.kind === 'plan' ? 'Change' : 'Difference'} | ${d.kind === 'plan' ? 'Before' : d.baseLabel} | ${d.kind === 'plan' ? 'After' : d.targetLabel} | ${d.kind === 'plan' ? 'Δ / month' : `${d.targetLabel} vs ${d.baseLabel}`} |`, '| --- | --- | ---: | ---: | ---: |');
    for (const n of rows) {
      const what = [...n.fields.map((f) => fieldText(d, f)), ...(n.fields.length ? [] : n.attrs.slice(0, 4))].join('; ');
      md.push(`| ${esc(n.label)} · ${esc(n.kind)} | ${changeText(d, n.change)}${what ? ` (${esc(what)})` : ''} | ${money(n.before)} | ${money(n.after)}${n.unknown ? ' ⚠' : ''} | ${formatDelta(n.delta)} |`);
    }
    md.push('');
  }
  if (d.findings.added.length) {
    md.push(`### ${d.kind === 'plan' ? 'New findings' : `Findings only in ${d.targetLabel}`}`, '');
    for (const f of d.findings.added) md.push(`- **${f.severity}** · ${f.title}${f.recommendation ? `. ${f.recommendation}` : ''}`);
    md.push('');
  }
  if (d.findings.resolved.length) {
    md.push(`### ${d.kind === 'plan' ? 'Resolved by this plan' : `Findings only in ${d.baseLabel}`}`, '');
    for (const f of d.findings.resolved) md.push(`- ~~${f.title}~~`);
    md.push('');
  }
  const notes = ['On-demand list prices; usage-based lines use the default usage assumptions.'];
  if (d.unknownAfterApply.length) notes.push(`⚠ Some values are only known after apply, so these may cost more than shown: ${d.unknownAfterApply.map((a) => `\`${a}\``).join(', ')}.`);
  md.push(...notes.map((n) => `_${n}_`), '');
  return md.join('\n');
}

// ── helpers ──

function pick(values: Record<string, number>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) if (k in values) out[k] = values[k];
  return out;
}

function kindOf(n: GraphNode): string {
  if (n.groupKind === 'vpc') return 'VPC';
  if (n.groupKind === 'subnet') return 'Subnet';
  return awsName(n.type)?.full ?? n.type;
}

function labeller(nodes: GraphNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const count = new Map<string, number>();
  for (const n of byId.values()) if (n.kind === 'resource' && !n.virtual) count.set(n.label, (count.get(n.label) ?? 0) + 1);
  return (id: string) => {
    const n = byId.get(id);
    if (!n) return id;
    return (count.get(n.label) ?? 0) > 1 ? `${n.label} (${awsName(n.type)?.service.replace(/^(Amazon|AWS) /, '') ?? n.type})` : n.label;
  };
}

function fieldDiff(a: [string, string][], b: [string, string][]): NodeDiff['fields'] {
  const ma = joinByKey(a), mb = joinByKey(b);
  const out: NodeDiff['fields'] = [];
  for (const key of [...new Set([...ma.keys(), ...mb.keys()])]) {
    if (IDENTITY_KEYS.has(key)) continue;
    const x = ma.get(key), y = mb.get(key);
    if (x !== y) out.push({ key, before: x, after: y });
  }
  return out;
}

function joinByKey(kv: [string, string][]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of kv) m.set(k, m.has(k) ? `${m.get(k)}, ${v}` : v);
  return m;
}
