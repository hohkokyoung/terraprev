// terraprev as an MCP server: the same snapshot, prices, findings and brief as the page, as tools an
// AI assistant can call. Everything is read from the state file on each call (cached until it
// changes), so answers always match the last apply.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GraphNode, Snapshot } from '../../shared/types.ts';
import { componentQuantity, formatQuantity, formatUnitPrice, lineCosts, prettyUnit } from '../../shared/cost.ts';
import { awsName } from '../../shared/awsNames.ts';
import { pathsInto } from '../../shared/flow.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../shared/report.ts';
import { ROOT, type Config } from './config.ts';
import { buildBase, priceSnapshot } from './snapshot.ts';
import type { ProviderPricer } from './pricing/types.ts';
import { AwsOffers } from './pricing/aws/offers.ts';
import { AwsPricer } from './pricing/aws/pricer.ts';
import { SourceIndex } from './source/hcl.ts';
import { labelMap } from './source/labels.ts';

export interface McpOptions {
  config: Config;
  /** Never download price lists; use the cache only. */
  offline?: boolean;
  /** Replaces the AWS price list (tests). */
  pricers?: ProviderPricer[];
  /** Progress and warnings. stdout belongs to the protocol, so this must not write there. */
  log?: (msg: string) => void;
}

interface Stack {
  file: string;
  snapshot: Snapshot;
  sources: SourceIndex;
  names: ReturnType<typeof labelMap>;
}

const INSTRUCTIONS = `terraprev reads a Terraform state file (terraform.tfstate) and explains the deployed AWS stack:
architecture, monthly cost from AWS's official price list, rule-based findings, and a CTO brief.
Start with stack_overview. Every tool takes an optional "state" path; without it the configured state file is used.
Costs are USD on-demand estimates; traffic-based lines use default usage unless "usage" overrides are passed
(keys come from estimate_cost). Anything that can't be priced is listed as unpriced, never counted as $0.`;

export function createMcpServer({ config, offline = false, pricers, log = () => {} }: McpOptions): McpServer {
  pricers ??= [new AwsPricer(new AwsOffers(
    config.cacheDir,
    config.priceCacheDays,
    (p) => p.done && log(`downloaded ${p.source} price list (${(p.loadedBytes / 1e6).toFixed(0)} MB)`),
    { offline },
  ))];

  // One parsed + priced stack per state file, rebuilt when the file changes.
  const cache = new Map<string, { key: string; stack: Promise<Stack> }>();
  const load = (state?: string): Promise<Stack> => {
    const file = state ? resolve(state) : config.stateFile;
    if (!existsSync(file)) {
      throw new Error(`No state file at ${file}. Run terraform apply first, or pass "state" (for remote state: terraform state pull > stack.tfstate).`);
    }
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit.stack;
    const stack = (async () => {
      const parts = buildBase(file, JSON.parse(readFileSync(file, 'utf8')), config.defaultRegion);
      const cost = await priceSnapshot(parts, pricers);
      for (const e of cost.errors) log(`price warning: ${e}`);
      return {
        file,
        snapshot: { ...parts.base, cost, updatedAt: st.mtime.toISOString() },
        sources: new SourceIndex(file),
        names: labelMap(parts.state.resources),
      };
    })();
    stack.catch(() => cache.delete(file));
    cache.set(file, { key, stack });
    return stack;
  };

  const server = new McpServer({ name: 'terraprev', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const state = z.string().optional().describe('Path to a terraform.tfstate file. Defaults to the configured stateFile.');
  const usage = z.record(z.number()).optional().describe('Overrides for traffic-based usage, by key (see usageParams in estimate_cost), e.g. {"aws_lambda_function.worker:requests": 5000000}.');
  const freeTier = z.boolean().optional().describe('Apply the AWS Always Free allowances. Default false.');

  server.registerTool('stack_overview', {
    title: 'Stack overview',
    description: 'Summary of the deployed stack: what it is, monthly cost, biggest cost lines, finding counts, and every resource (name, kind, Terraform address). Start here.',
    inputSchema: { state },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot } = await load(a.state);
    const r = buildReport({ snapshot, usage: defaultUsageValues(snapshot), freeTier: false });
    return json({
      title: r.title,
      stateFile: snapshot.stateFile,
      lastApplied: snapshot.updatedAt,
      serial: snapshot.serial,
      region: snapshot.cost.region,
      environment: snapshot.environment,
      providers: snapshot.providers,
      summary: r.summary,
      kpis: r.kpis,
      topCosts: r.cost.top.map((t) => ({ name: t.name, kind: t.kind, monthly: usd(t.monthly), share: pct(t.share), usageBased: t.usageBased })),
      costByCategory: r.cost.byCategory.map((c) => ({ category: c.category, monthly: usd(c.monthly), share: pct(c.share) })),
      findings: r.findings.counts,
      resources: r.inventory.map((i) => ({ name: i.name, kind: i.kind, address: i.address, monthly: i.monthly === undefined ? undefined : usd(i.monthly) })),
    });
  });

  server.registerTool('estimate_cost', {
    title: 'Estimate monthly cost',
    description: 'Monthly AWS cost, line by line: quantity × unit price, the SKU and price page behind each number, the usage assumptions for traffic-based lines (overridable), and anything not priced.',
    inputSchema: { state, usage, free_tier: freeTier },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot } = await load(a.state);
    const { cost, graph } = snapshot;
    const values = { ...defaultUsageValues(snapshot), ...a.usage };
    const unknown = Object.keys(a.usage ?? {}).filter((k) => !cost.usage.some((p) => p.key === k));
    const lines = lineCosts(cost.components, values, a.free_tier === true);
    const label = labeller(graph.nodes);
    const items = cost.components.map((c) => {
      const l = lines.get(c.id)!;
      return {
        resource: label(c.nodeId),
        address: c.address,
        charge: c.name,
        kind: c.kind,
        monthly: usd(l.monthly),
        quantity: `${formatQuantity(componentQuantity(c, values))} ${prettyUnit(c.unit)}`,
        price: c.tiers.length === 1 ? formatUnitPrice(c.tiers[0].price, c.unit) : c.tiers.map((t) => `from ${formatQuantity(t.from)}: ${formatUnitPrice(t.price, c.unit)}`).join('; '),
        freeUnits: l.freeUnits ? formatQuantity(l.freeUnits) : undefined,
        usageKeys: c.quantity.usage,
        note: c.note,
        sku: c.sku,
        pricingPage: c.pageUrl,
      };
    }).sort((x, y) => y.monthly - x.monthly);
    const total = items.reduce((s, i) => s + i.monthly, 0);
    return json({
      currency: cost.currency,
      region: cost.region,
      status: cost.status,
      freeTier: a.free_tier === true,
      total: usd(total),
      fixed: usd(items.filter((i) => i.kind === 'fixed').reduce((s, i) => s + i.monthly, 0)),
      usageBased: usd(items.filter((i) => i.kind === 'usage').reduce((s, i) => s + i.monthly, 0)),
      lines: items,
      usageParams: cost.usage.map((p) => ({ key: p.key, resource: label(p.nodeId), label: p.label, unit: p.unit, value: values[p.key], default: p.default, min: p.min, max: p.max })),
      unpriced: cost.unpriced.map((u) => ({ address: u.address, type: u.type, reason: u.reason })),
      freeResources: cost.free.length,
      sources: cost.sources,
      errors: cost.errors,
      ...(unknown.length ? { ignoredUsageKeys: unknown } : {}),
      excludes: 'Savings plans, reserved capacity, taxes and data transfer out are not included. EC2 assumes Linux on-demand.',
    });
  });

  server.registerTool('list_findings', {
    title: 'List findings',
    description: 'Rule-based findings from state attributes (reliability, security, cost, operations), each with what was seen and how to fix it. No finding does not mean no problem: only the rules are checked.',
    inputSchema: {
      state,
      severity: z.array(z.enum(['high', 'medium', 'low', 'info', 'good'])).optional().describe('Only these severities. Default: all.'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot } = await load(a.state);
    const r = buildReport({ snapshot, usage: defaultUsageValues(snapshot), freeTier: false });
    return json(r.findings.items
      .filter((f) => !a.severity || a.severity.includes(f.severity))
      .map((f) => ({ severity: f.severity, category: f.category, title: f.title, detail: f.detail, recommendation: f.recommendation, resources: f.resourceNames })));
  });

  server.registerTool('describe_resource', {
    title: 'Describe a resource',
    description: 'One resource in depth: its configuration, where it sits (VPC/subnet), what it talks to, every path that can reach it, IAM roles and security groups, its cost lines, findings about it, and the resource {} block from the .tf files.',
    inputSchema: {
      state,
      resource: z.string().describe('Terraform address (aws_lb.main), name shown in stack_overview (web-alb), or node id.'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot, sources, names } = await load(a.state);
    const { graph, cost, insights } = snapshot;
    const node = findNode(graph.nodes, a.resource);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const label = labeller(graph.nodes);
    const parents: string[] = [];
    for (let p = node.parentId && byId.get(node.parentId); p; p = p.parentId ? byId.get(p.parentId) : undefined) parents.unshift(p.label);
    const values = defaultUsageValues(snapshot);
    const lines = lineCosts(cost.components, values, false);
    const mine = cost.components.filter((c) => c.nodeId === node.id);
    const edge = (id: string, kind: string, text?: string) => ({ resource: label(id), kind, ...(text ? { label: text } : {}) });
    return json({
      name: node.label,
      kind: awsName(node.type)?.full ?? node.type,
      type: node.type,
      addresses: node.addresses,
      location: parents.join(' › '),
      configuration: Object.fromEntries(node.details),
      incoming: graph.edges.filter((e) => e.target === node.id).map((e) => edge(e.source, e.kind, e.label)),
      outgoing: graph.edges.filter((e) => e.source === node.id).map((e) => edge(e.target, e.kind, e.label)),
      // e.g. "Internet → web-alb → app-asg -(tcp 5432)→ app-db"
      reachableVia: pathsInto(graph.edges, node.id).map((path) => path.map((s, i) => (i ? (path[i - 1].via ? ` -(${path[i - 1].via})→ ` : ' → ') : '') + label(s.node)).join('')),
      access: node.access && {
        roles: node.access.roles.map(({ nodeId: _, policies, ...r }) => ({ ...r, policies: policies.map(({ nodeId: __, ...p }) => p) })),
        securityGroups: node.access.securityGroups.map(({ nodeId: _, ...g }) => g),
      },
      cost: mine.length ? {
        monthly: usd(mine.reduce((s, c) => s + lines.get(c.id)!.monthly, 0)),
        lines: mine.map((c) => ({ charge: c.name, monthly: usd(lines.get(c.id)!.monthly), usageKeys: c.quantity.usage })),
      } : undefined,
      unpriced: cost.unpriced.filter((u) => u.nodeId === node.id).map((u) => u.reason),
      findings: insights.filter((i) => i.nodes.includes(node.id)).map((i) => ({ severity: i.severity, title: i.title, recommendation: i.recommendation })),
      terraform: node.addresses.flatMap((address) => {
        const found = sources.find(address);
        if (!found) return [];
        return [{ address, name: names.get(address)?.name, changedSinceApply: found.changedSinceApply, blocks: found.blocks.map((b) => ({ role: b.role, file: b.file, line: b.blockLine, text: b.text })) }];
      }),
    });
  });

  server.registerTool('get_brief', {
    title: 'CTO brief',
    description: 'The full CTO brief as Markdown: executive summary, architecture (with a Mermaid diagram), cost drivers, findings and fixes, security posture, inventory and methodology.',
    inputSchema: { state, usage, free_tier: freeTier },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot } = await load(a.state);
    const md = renderMarkdown(buildReport({ snapshot, usage: { ...defaultUsageValues(snapshot), ...a.usage }, freeTier: a.free_tier === true }));
    return { content: [{ type: 'text', text: md }] };
  });

  server.registerTool('build_snapshot', {
    title: 'Build snapshot files',
    description: 'Write the self-contained HTML snapshot (interactive diagram + cost) to disk, optionally with the diagram PDF and the CTO brief (.md + .pdf). PDFs need Chrome, Edge, Brave or Chromium installed. Returns the files written.',
    inputSchema: {
      state,
      out: z.string().optional().describe('HTML path; other files go next to it. Default out/terraprev.html in the terraprev folder.'),
      pdf: z.boolean().optional().describe('Also write the diagram as an A4 landscape PDF.'),
      report: z.boolean().optional().describe('Also write the CTO brief as <stack>-brief.md and .pdf.'),
      theme: z.enum(['light', 'dark']).optional(),
      free_tier: freeTier,
      open: z.boolean().optional().describe('Open the snapshot in the default browser when done.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    const stack = await load(a.state); // fail fast, with the same message, on a missing state file
    const args = [join(ROOT, 'server', 'src', 'cli', 'build.ts'), '--state', stack.file];
    if (a.out) args.push('--out', resolve(a.out));
    if (a.pdf) args.push('--pdf');
    if (a.report) args.push('--report');
    if (a.theme) args.push('--theme', a.theme);
    if (a.free_tier) args.push('--free-tier');
    if (a.open) args.push('--open');
    if (offline) args.push('--offline');
    const { code, output } = await run(process.execPath, args);
    if (code !== 0) throw new Error(`snapshot build failed (exit ${code}):\n${output}`);
    return { content: [{ type: 'text', text: output.trim() }] };
  });

  return server;
}

// ── helpers ──

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const usd = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Node id → its label, with the kind added when two resources share a name. */
function labeller(nodes: GraphNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const count = new Map<string, number>();
  for (const n of nodes) count.set(n.label, (count.get(n.label) ?? 0) + 1);
  return (id: string) => {
    const n = byId.get(id);
    if (!n) return id;
    return (count.get(n.label) ?? 0) > 1 ? `${n.label} (${awsName(n.type)?.full ?? n.type})` : n.label;
  };
}

/** Accepts a node id, any Terraform address the node stands for, or its display name. */
function findNode(nodes: GraphNode[], query: string): GraphNode {
  const q = query.trim();
  const exact = nodes.find((n) => n.id === q) ?? nodes.find((n) => n.addresses.includes(q));
  if (exact) return exact;
  const named = nodes.filter((n) => n.kind === 'resource' && n.label.toLowerCase() === q.toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`"${q}" matches several resources; use one of these addresses: ${named.map((n) => n.addresses[0]).join(', ')}`);
  const near = nodes.filter((n) => n.kind === 'resource' && !n.virtual && (n.label.toLowerCase().includes(q.toLowerCase()) || n.addresses.some((x) => x.includes(q))));
  throw new Error(`No resource "${q}".${near.length ? ` Did you mean: ${near.slice(0, 10).map((n) => `${n.label} (${n.addresses[0]})`).join(', ')}?` : ' stack_overview lists every resource.'}`);
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => done({ code: null, output: err.message }));
    child.on('close', (code) => done({ code, output }));
  });
}
