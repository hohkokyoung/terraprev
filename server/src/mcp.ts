// terraprev as an MCP server: the same snapshot, prices, findings and brief as the page, as tools an
// AI assistant can call. Everything is read from the state file on each call (cached until it
// changes), so answers always match the last apply.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Comparison, GraphNode, InsightSeverity, Snapshot } from '../../shared/types.ts';
import { componentQuantity, formatQuantity, formatUnitPrice, lineCosts, prettyUnit } from '../../shared/cost.ts';
import { awsName } from '../../shared/awsNames.ts';
import { pathsInto } from '../../shared/flow.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../shared/report.ts';
import { ROOT, type Config } from './config.ts';
import { buildBase, buildBaseFrom, priceSnapshot, type SnapshotParts } from './snapshot.ts';
import { readUsage, usagePath, writeUsage } from './usage.ts';
import { applyWhatIf } from './whatif.ts';
import type { ProviderPricer } from './pricing/types.ts';
import { AwsOffers } from './pricing/aws/offers.ts';
import { AwsPricer } from './pricing/aws/pricer.ts';
import { SourceIndex } from './source/hcl.ts';
import { labelMap } from './source/labels.ts';
import { readHistory } from './history.ts';
import { planComparison, readPlan, stackComparison } from './compare.ts';
import { combinedSaving, priceSavings } from '../../shared/savings.ts';
import { historySentence, pointTotal, summarizeHistory } from '../../shared/history.ts';
import { changeText, diffSnapshots, diffSummary, renderDiffMarkdown, type Diff } from '../../shared/compare.ts';

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
  parts: SnapshotParts;
  snapshot: Snapshot;
  sources: SourceIndex;
  names: ReturnType<typeof labelMap>;
}

const INSTRUCTIONS = `terraprev reads a Terraform state file (terraform.tfstate) and explains the deployed AWS stack:
architecture, monthly cost from AWS's official price list, rule-based findings, and a CTO brief.
Start with stack_overview. Every tool takes an optional "state" path; without it the configured state file is used.
Costs are USD on-demand estimates. Traffic-based lines are priced at the saved usage assumptions
(terraprev.usage.json next to the state, the same ones the live page's sliders write), else defaults; "usage" on a
call overrides them for that call only, and set_usage saves new ones. Anything that can't be priced is listed as
unpriced, never counted as $0. find_resources filters resources (cost, kind, internet reach, findings).
what_if prices a change (attributes set, resources removed) before any .tf is written. Before an apply,
preview_plan says what a plan (terraform show -json output) adds, changes and costs. compare_stacks compares two
state files (staging vs prod). suggest_savings lists priced ways to cut the bill; cost_history shows how the bill
moved across applies.`;

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
    if (!st.isFile()) throw new Error(`${file} is a folder; pass the terraform.tfstate file inside it.`);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit.stack;
    const stack = (async () => {
      let parts;
      try {
        parts = buildBase(file, JSON.parse(readFileSync(file, 'utf8')), config.defaultRegion);
      } catch (err) {
        throw new Error(`Could not read ${file} as Terraform state: ${(err as Error).message}`);
      }
      const cost = await priceSnapshot(parts, pricers);
      for (const e of cost.errors) log(`price warning: ${e}`);
      return {
        file,
        parts,
        // History is read, never written: asking about a stack shouldn't change it.
        snapshot: { ...parts.base, cost, updatedAt: st.mtime.toISOString(), history: readHistory(config.historyDir, parts.base.lineage) },
        sources: new SourceIndex(file),
        names: labelMap(parts.state.resources),
      };
    })();
    stack.catch(() => cache.delete(file));
    cache.set(file, { key, stack });
    return stack;
  };

  /**
   * The usage every number is priced at: defaults, then terraprev.usage.json next to the state (what the
   * page's sliders saved), then this call's overrides. Read on every call, so a slider moved a second ago counts.
   */
  const assume = (snapshot: Snapshot, file: string, a: { usage?: Record<string, number>; free_tier?: boolean }) => {
    const saved = readUsage(file, log);
    return { values: { ...defaultUsageValues(snapshot), ...saved.usage, ...a.usage }, freeTier: a.free_tier ?? saved.freeTier };
  };

  const server = new McpServer({ name: 'terraprev', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const state = z.string().optional().describe('Path to a terraform.tfstate file. Defaults to the configured stateFile.');
  const usage = z.record(z.number().nonnegative()).optional().describe('Overrides for traffic-based usage, by key (see usageParams in estimate_cost), e.g. {"aws_lambda_function.worker:invocations": 5000000}. Applied on top of the saved assumptions in terraprev.usage.json, for this call only.');
  const freeTier = z.boolean().optional().describe('Apply the AWS Always Free allowances. Default: what terraprev.usage.json says (off when there is none).');

  server.registerTool('stack_overview', {
    title: 'Stack overview',
    description: 'Summary of the deployed stack: what it is, monthly cost, biggest cost lines, finding counts, and every resource (name, kind, Terraform address). Start here.',
    inputSchema: { state },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot, file } = await load(a.state);
    const { values, freeTier: free } = assume(snapshot, file, {});
    const r = buildReport({ snapshot, usage: values, freeTier: free });
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
    const { snapshot, file } = await load(a.state);
    const { cost, graph } = snapshot;
    const { values, freeTier: free } = assume(snapshot, file, a);
    const saved = readUsage(file).usage;
    const unknown = Object.keys(a.usage ?? {}).filter((k) => !cost.usage.some((p) => p.key === k));
    const lines = lineCosts(cost.components, values, free);
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
    // Totals from the unrounded lines, so they match the page and the brief to the cent.
    const sum = (kind?: string) => usd(cost.components.filter((c) => !kind || c.kind === kind).reduce((s, c) => s + lines.get(c.id)!.monthly, 0));
    return json({
      currency: cost.currency,
      region: cost.region,
      status: cost.status,
      freeTier: free,
      assumptionsFile: existsSync(usagePath(file)) ? usagePath(file) : undefined,
      total: sum(),
      fixed: sum('fixed'),
      usageBased: sum('usage'),
      lines: items,
      // source: where the value came from — this call, the saved assumptions, or the built-in default.
      usageParams: cost.usage.map((p) => ({
        key: p.key, resource: label(p.nodeId), label: p.label, unit: p.unit, value: values[p.key], default: p.default, min: p.min, max: p.max,
        source: a.usage && p.key in a.usage ? 'this call' : p.key in saved ? 'saved' : 'default',
      })),
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
    const { snapshot, file } = await load(a.state);
    const { values, freeTier: free } = assume(snapshot, file, {});
    const r = buildReport({ snapshot, usage: values, freeTier: free });
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
    const { snapshot, sources, names, file } = await load(a.state);
    const { graph, cost, insights } = snapshot;
    const node = findNode(graph.nodes, a.resource);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const label = labeller(graph.nodes);
    const parents: string[] = [];
    for (let p = node.parentId && byId.get(node.parentId); p; p = p.parentId ? byId.get(p.parentId) : undefined) parents.unshift(p.label);
    const { values, freeTier: free } = assume(snapshot, file, {});
    const lines = lineCosts(cost.components, values, free);
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
    const { snapshot, file } = await load(a.state);
    const { values, freeTier: free } = assume(snapshot, file, a);
    const md = renderMarkdown(buildReport({ snapshot, usage: values, freeTier: free }));
    return { content: [{ type: 'text', text: md }] };
  });

  server.registerTool('suggest_savings', {
    title: 'Suggest savings',
    description: 'Priced ways to cut the bill without removing anything: Graviton instance types, gp3 volumes, 1-year reservations, arm64 Lambdas, idle IPs, log retention, gateway endpoints. Each has the monthly saving at the given usage, what it takes, and the Terraform change. Savings on the same resource overlap; "total" counts each once.',
    inputSchema: { state, usage, free_tier: freeTier },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot, file } = await load(a.state);
    const { values, freeTier: free } = assume(snapshot, file, a);
    const priced = priceSavings(snapshot.cost.components, snapshot.cost.savings, values, free);
    const label = labeller(snapshot.graph.nodes);
    return json({
      total: usd(combinedSaving(priced)),
      savings: priced.map(({ saving: s, monthly }) => ({
        title: s.title, resource: label(s.nodeId), kind: s.kind, monthly: usd(monthly), ...(s.perUnit ? { perUnit: s.perUnit } : {}),
        detail: s.detail, caveat: s.caveat, terraformChange: s.change,
      })),
    });
  });

  server.registerTool('cost_history', {
    title: 'Cost history',
    description: 'The monthly cost at each apply of this stack (recorded by the snapshot build and the live server, at default usage), what changed since the last apply, and over the last month or so.',
    inputSchema: { state },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot } = await load(a.state);
    const points = snapshot.history ?? [];
    const s = summarizeHistory(points);
    return json({
      applies: points.length,
      summary: points.length > 1 ? historySentence(s) : points.length ? 'Only one apply recorded so far.' : 'No history yet: it is recorded by npm run snapshot (or bin/tf apply) and the live server.',
      sinceLastApply: s?.previous ? usd(pointTotal(s.last) - pointTotal(s.previous)) : undefined,
      points: points.map((p) => ({ serial: p.serial, appliedAt: p.appliedAt, monthly: usd(pointTotal(p)), fixed: p.fixed, usageBased: p.usage, resources: p.resourceCount, byCategory: p.byCategory, findings: p.findings })),
    });
  });

  const diffJson = (d: Diff) => ({
    summary: diffSummary(d),
    before: usd(d.total.before),
    after: usd(d.total.after),
    delta: usd(d.total.delta),
    ...(d.kind === 'plan' ? { resources: d.resources } : { baseStack: d.baseLabel, thisStack: d.targetLabel }),
    changes: d.nodes.filter((n) => !n.group).map((n) => ({
      resource: n.label, kind: n.kind, change: changeText(d, n.change), before: usd(n.before), after: usd(n.after), delta: usd(n.delta),
      ...(n.fields.length ? { configuration: n.fields } : {}), ...(n.attrs.length ? { changedAttributes: n.attrs } : {}),
      ...(n.unknown ? { mayCostMore: 'some values are only known after apply' } : {}), addresses: n.addresses,
    })),
    newFindings: d.findings.added.map((f) => ({ severity: f.severity, title: f.title, recommendation: f.recommendation })),
    resolvedFindings: d.findings.resolved.map((f) => f.title),
    markdown: renderDiffMarkdown(d),
  });

  server.registerTool('preview_plan', {
    title: 'Preview a plan',
    description: 'What a Terraform plan will do before it is applied: resources added, changed, replaced and destroyed, the monthly cost before and after, findings it introduces or fixes, and a Markdown summary for a pull request. Takes the JSON from terraform show -json plan.out (or a saved plan file, if terraform is on PATH).',
    inputSchema: {
      plan: z.string().describe('Path to terraform show -json output (plan.json), or a saved plan file (plan.out).'),
      usage,
      free_tier: freeTier,
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const file = resolve(a.plan);
    if (!existsSync(file)) throw new Error(`No plan at ${file}. Make one with: terraform plan -out=plan.out && terraform show -json plan.out > plan.json`);
    const { parts, cost, compare } = await planComparison(file, readPlan(file), config.defaultRegion, pricers);
    const snapshot = { ...parts.base, cost };
    const { values, freeTier: free } = assume(snapshot, file, a);
    return json(diffJson(diffSnapshots(compare, snapshot, values, free)));
  });

  server.registerTool('compare_stacks', {
    title: 'Compare two stacks',
    description: 'This stack compared with another state file (e.g. prod against staging): resources only in one of them, resources whose configuration or cost differs, the monthly cost of each, and findings only one has.',
    inputSchema: {
      state,
      other: z.string().describe('Path to the other terraform.tfstate to compare with.'),
      usage,
      free_tier: freeTier,
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const other = resolve(a.other);
    if (!existsSync(other)) throw new Error(`No state file at ${other}.`);
    const stack = await load(a.state);
    const parts = buildBase(stack.file, JSON.parse(readFileSync(stack.file, 'utf8')), config.defaultRegion);
    const compare = await stackComparison(parts, other, config.defaultRegion, pricers);
    const { values, freeTier: free } = assume(stack.snapshot, stack.file, a);
    return json(diffJson(diffSnapshots(compare, stack.snapshot, values, free)));
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

  server.registerTool('set_usage', {
    title: 'Save usage assumptions',
    description: 'Save expected usage (and the free tier switch) to terraprev.usage.json next to the state, so the live page, snapshot builds and every later answer are priced at it. Keys come from estimate_cost usageParams; null puts a key back to its default. The live page picks the change up within a second.',
    inputSchema: {
      state,
      usage: z.record(z.number().nonnegative().nullable()).optional().describe('Key → expected monthly value, or null for the default.'),
      free_tier: z.boolean().optional().describe('Save the free tier switch on or off.'),
      reset: z.boolean().optional().describe('Clear every saved value first.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    const { snapshot, file } = await load(a.state);
    const params = new Map(snapshot.cost.usage.map((p) => [p.key, p]));
    const unknown = Object.keys(a.usage ?? {}).filter((k) => !params.has(k));
    if (unknown.length) throw new Error(`Unknown usage keys: ${unknown.join(', ')}. estimate_cost lists them under usageParams.`);
    const cur = a.reset ? { usage: {}, freeTier: false } : readUsage(file, log);
    const next = { usage: { ...cur.usage }, freeTier: a.free_tier ?? cur.freeTier };
    for (const [k, v] of Object.entries(a.usage ?? {})) {
      // A value equal to the default is the default: keep the file to what was actually decided.
      if (v === null || v === params.get(k)!.default) delete next.usage[k];
      else next.usage[k] = v;
    }
    const saved = writeUsage(file, next);
    const { values, freeTier: free } = assume(snapshot, file, {});
    const total = [...lineCosts(snapshot.cost.components, values, free).values()].reduce((s, l) => s + l.monthly, 0);
    return json({ file: usagePath(file), saved: saved.usage, freeTier: saved.freeTier, total: usd(total) });
  });

  server.registerTool('what_if', {
    title: 'What if',
    description: 'Price a change before writing it: set attributes on resources (instance_type, instance_class, multi_az, allocated_storage, desired_capacity, billing_mode, …) or remove resources, and get the monthly cost before and after, per resource, and the findings the change would add or fix. Nothing is written and terraform is not run. Attribute names are the Terraform ones (describe_resource shows them); nested ones use dots, e.g. root_block_device.0.volume_size.',
    inputSchema: {
      state,
      changes: z.array(z.object({
        resource: z.string().describe('Terraform address (aws_db_instance.main), base address for every instance (aws_subnet.public), or name from stack_overview.'),
        set: z.record(z.unknown()).optional().describe('Attribute → new value, e.g. {"instance_class": "db.t4g.small", "multi_az": true}.'),
        remove: z.boolean().optional().describe('Price the stack without this resource.'),
      })).min(1),
      usage,
      free_tier: freeTier,
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const stack = await load(a.state);
    const resolveAddresses = (q: string) => {
      const direct = stack.parts.state.resources.filter((r) => r.address === q || r.baseAddress === q).map((r) => r.address);
      return direct.length ? direct : findNode(stack.snapshot.graph.nodes, q).addresses;
    };
    const { state: changed, actions, changedAttrs, warnings } = applyWhatIf(stack.parts.state, a.changes, resolveAddresses);
    const after = buildBaseFrom(stack.file, changed, stack.parts.region);
    const snapshot = { ...after.base, cost: await priceSnapshot(after, pricers) };
    const compare: Comparison = { kind: 'plan', base: stack.snapshot, baseLabel: 'now', targetLabel: 'what if', actions, changedAttrs };
    const { values, freeTier: free } = assume(stack.snapshot, stack.file, a);
    // The plan-preview shape, minus its pull-request Markdown: nothing here is a plan yet.
    const { markdown: _, ...result } = diffJson(diffSnapshots(compare, snapshot, values, free));
    return json({ ...result, ...(warnings.length ? { warnings } : {}) });
  });

  const SEVERITY_ORDER: InsightSeverity[] = ['high', 'medium', 'low', 'info'];
  server.registerTool('find_resources', {
    title: 'Find resources',
    description: 'Resources matching filters, with cost, location, internet reachability and findings: e.g. everything reachable from the internet, everything over $20/month, every database, everything with a high finding, everything in one subnet. Cheaper than stack_overview on a large stack.',
    inputSchema: {
      state,
      kind: z.string().optional().describe('Matches the Terraform type, AWS service name or category, e.g. "rds", "aws_lambda_function", "database", "Load Balancer".'),
      in: z.string().optional().describe('Only resources inside this VPC or subnet (by name).'),
      min_monthly: z.number().nonnegative().optional(),
      max_monthly: z.number().nonnegative().optional(),
      reachable_from_internet: z.boolean().optional().describe('true: only what traffic from the internet can reach; false: only what it cannot.'),
      finding_severity: z.enum(['high', 'medium', 'low', 'info']).optional().describe('Only resources with a finding at least this severe.'),
      usage_based: z.boolean().optional().describe('true: only resources with traffic-based charges.'),
      include_supporting: z.boolean().optional().describe('Also match supporting pieces the diagram hides by default (subnet groups, security groups, IAM roles, …). Default false.'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { snapshot, file } = await load(a.state);
    const { graph, cost, insights } = snapshot;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const { values, freeTier: free } = assume(snapshot, file, {});
    const lines = lineCosts(cost.components, values, free);
    const monthly = new Map<string, number>();
    for (const c of cost.components) monthly.set(c.nodeId, (monthly.get(c.nodeId) ?? 0) + lines.get(c.id)!.monthly);
    const usageNodes = new Set(cost.usage.map((p) => p.nodeId));
    const ancestors = (n: GraphNode) => {
      const out: GraphNode[] = [];
      for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) out.unshift(p);
      return out;
    };
    const kind = a.kind?.toLowerCase();
    const label = labeller(graph.nodes);
    const matches = graph.nodes
      .filter((n) => n.kind === 'resource' && n.type !== 'internet' && (a.include_supporting || !n.supporting))
      .map((n) => {
        const mine = insights.filter((i) => i.nodes.includes(n.id) && i.severity !== 'good');
        const worst = SEVERITY_ORDER.find((s) => mine.some((i) => i.severity === s));
        return {
          n,
          parents: ancestors(n),
          monthly: monthly.get(n.id),
          internet: pathsInto(graph.edges, n.id).some((path) => path[0]?.node === 'internet'),
          worst,
          count: mine.length,
        };
      })
      .filter(({ n, parents, monthly: m, internet, worst }) =>
        (!kind || [n.type, awsName(n.type)?.full, awsName(n.type)?.service, n.sublabel, n.category].some((s) => s?.toLowerCase().includes(kind))) &&
        (!a.in || parents.some((p) => p.label.toLowerCase() === a.in!.toLowerCase())) &&
        (a.min_monthly === undefined || (m ?? 0) >= a.min_monthly) &&
        (a.max_monthly === undefined || (m ?? 0) <= a.max_monthly) &&
        (a.reachable_from_internet === undefined || internet === a.reachable_from_internet) &&
        (!a.finding_severity || (!!worst && SEVERITY_ORDER.indexOf(worst) <= SEVERITY_ORDER.indexOf(a.finding_severity))) &&
        (a.usage_based === undefined || usageNodes.has(n.id) === a.usage_based))
      .sort((x, y) => (y.monthly ?? 0) - (x.monthly ?? 0));
    return json({
      count: matches.length,
      monthly: usd(matches.reduce((s, m) => s + (m.monthly ?? 0), 0)),
      resources: matches.map(({ n, parents, monthly: m, internet, worst, count }) => ({
        name: label(n.id),
        kind: awsName(n.type)?.full ?? n.type,
        address: n.addresses[0],
        category: n.category,
        monthly: m === undefined ? undefined : usd(m),
        usageBased: usageNodes.has(n.id),
        location: parents.map((p) => p.label).join(' › '),
        reachableFromInternet: internet,
        findings: count ? { count, worst } : undefined,
      })),
    });
  });

  // Prompts: ready-made questions, shown as slash commands in clients that support them.
  const ask = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });
  const onState = (s?: string) => (s ? ` Use the state file ${s}.` : '');

  server.registerPrompt('review_plan', {
    title: 'Review a Terraform plan',
    description: 'Cost, risk and findings of a plan before it is applied, with a pull request comment.',
    argsSchema: { plan: z.string().describe('Path to plan.json (terraform show -json) or a saved plan file.') },
  }, ({ plan }) => ask(`Review the Terraform plan at ${plan} with terraprev's preview_plan tool. Tell me, in this order: what it destroys or replaces (and whether data could be lost), the monthly cost before and after and which resources move it, findings it adds or fixes, and anything whose cost is only known after apply. Finish with the Markdown it returns, ready to paste into the pull request.`));

  server.registerPrompt('explain_bill', {
    title: 'Explain the bill',
    description: 'What drives the monthly cost, which numbers rest on usage assumptions, and the cheapest wins.',
    argsSchema: { state: z.string().optional().describe('Path to terraform.tfstate. Default: the configured one.') },
  }, ({ state: s }) => ask(`Explain what this stack costs per month and why.${onState(s)} Use terraprev's stack_overview, then estimate_cost. Name the three biggest cost drivers with their quantity × unit price, say which lines depend on usage assumptions (and whether those are saved or defaults), list anything not priced, then the best savings from suggest_savings with the Terraform change for each.`));

  server.registerPrompt('cost_change', {
    title: 'Why did the cost change?',
    description: 'How the bill moved across applies, and which resources moved it.',
    argsSchema: { state: z.string().optional().describe('Path to terraform.tfstate. Default: the configured one.') },
  }, ({ state: s }) => ask(`How has this stack's monthly cost changed across applies, and why?${onState(s)} Use terraprev's cost_history, then describe_resource on whatever drove the biggest change. Be specific about amounts and dates.`));

  server.registerPrompt('harden_stack', {
    title: 'Harden the stack',
    description: 'The high and medium findings, worst first, each with its Terraform fix and cost.',
    argsSchema: { state: z.string().optional().describe('Path to terraform.tfstate. Default: the configured one.') },
  }, ({ state: s }) => ask(`Go through this stack's high and medium findings, worst first.${onState(s)} Use terraprev's list_findings, find_resources (reachable_from_internet: true) and describe_resource for each affected resource. For each: what is exposed or at risk, the Terraform change that fixes it (from its .tf block), and what the fix costs, priced with what_if where it changes cost.`));

  server.registerPrompt('price_change', {
    title: 'Price a change',
    description: 'What a change you are considering would cost, before writing it.',
    argsSchema: {
      change: z.string().describe('The change in plain words, e.g. "make app-db multi-AZ on db.t4g.small".'),
      state: z.string().optional().describe('Path to terraform.tfstate. Default: the configured one.'),
    },
  }, ({ change, state: s }) => ask(`Price this change before I make it: ${change}.${onState(s)} Find the resources with terraprev's find_resources or describe_resource, then run what_if with the matching Terraform attributes. Tell me the monthly cost before and after, per resource, any findings it adds or fixes, and any warning what_if gives about attribute names. Then show the .tf edit it implies.`));

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
