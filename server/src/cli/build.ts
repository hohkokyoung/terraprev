// terraprev build: one-shot, no server. Reads the state + .tf files, prices it from the
// on-disk price cache, and writes a single self-contained HTML file you can double-click.
//
//   node server/src/cli/build.ts [--state path/to/terraform.tfstate] [--out file.html]
//                                [--offline] [--refresh-prices] [--open]
//                                [--pdf [file.pdf]] [--theme light|dark] [--free-tier]
//                                [--report]   (CTO brief: out/<name>-brief.md + .pdf)
//                                [--plan plan.json|plan.out]   (preview a plan: what it adds, changes, costs)
//                                [--compare other.tfstate]     (this stack compared with another one)
//                                [--dir folder]                (where the .tf files are; default: next to the state/plan)

import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { Comparison, CostReport, SourceResult, StaticBundle } from '../../../shared/types.ts';
import { componentMonthly, defaultUsage, formatUsd } from '../../../shared/cost.ts';
import { diffSnapshots, diffSummary, renderDiffMarkdown } from '../../../shared/compare.ts';
import { loadConfig, ROOT } from '../config.ts';
import { buildBase, priceSnapshot, type SnapshotParts } from '../snapshot.ts';
import { planComparison, readPlan, stackComparison } from '../compare.ts';
import { recordHistory } from '../history.ts';
import { inline, printDiagram, printReport, webTemplate } from '../export.ts';
import { AwsOffers } from '../pricing/aws/offers.ts';
import { AwsPricer } from '../pricing/aws/pricer.ts';
import { SourceIndex } from '../source/hcl.ts';
import { labelMap } from '../source/labels.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../../shared/report.ts';

const { values: args } = parseArgs({
  options: {
    state: { type: 'string' },
    plan: { type: 'string' },
    compare: { type: 'string' },
    dir: { type: 'string' },
    out: { type: 'string' },
    offline: { type: 'boolean', default: false },
    'refresh-prices': { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    pdf: { type: 'boolean', default: false },
    'pdf-out': { type: 'string' },
    theme: { type: 'string', default: 'light' },
    'free-tier': { type: 'boolean', default: false },
    report: { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
});

const t0 = Date.now();
const say = (msg: string) => !args.quiet && console.error(`[terraprev] ${msg}`);
const fail = (msg: string): never => {
  console.error(`[terraprev] ${msg}`);
  process.exit(1);
};

const config = loadConfig();
const planFile = args.plan ? resolve(args.plan) : undefined;
const compareFile = args.compare ? resolve(args.compare) : undefined;
const stateFile = args.state ? resolve(args.state) : config.stateFile;
const mode = planFile ? 'plan' : compareFile ? 'compare' : 'state';
const outFile = resolve(args.out ?? join(ROOT, 'out', mode === 'plan' ? 'terraprev-plan.html' : mode === 'compare' ? 'terraprev-compare.html' : 'terraprev.html'));

for (const f of planFile ? [planFile] : compareFile ? [stateFile, compareFile] : [stateFile]) {
  if (!existsSync(f)) fail(`no file at ${f}.${f === stateFile ? ' Run terraform apply first, or pass --state.' : ''}`);
}

const offers = new AwsOffers(
  config.cacheDir,
  args['refresh-prices'] ? 0 : config.priceCacheDays,
  (p) => p.done && say(`downloaded ${p.source} price list (${(p.loadedBytes / 1e6).toFixed(0)} MB)`),
  { offline: args.offline },
);
const pricers = [new AwsPricer(offers)];

// 1. Diagram + prices, exactly as the live server computes them. A plan has two sides; so does a comparison.
let parts: SnapshotParts;
let cost: CostReport;
let compare: Comparison | undefined;
try {
  if (planFile) {
    ({ parts, cost, compare } = await planComparison(planFile, readPlan(planFile), config.defaultRegion, pricers));
  } else {
    parts = buildBase(stateFile, JSON.parse(readFileSync(stateFile, 'utf8')), config.defaultRegion);
    cost = await priceSnapshot(parts, pricers);
    if (compareFile) compare = await stackComparison(parts, compareFile, config.defaultRegion, pricers);
  }
} catch (err) {
  fail((err as Error).message);
}
for (const e of [...cost!.errors, ...(compare?.base.cost.errors ?? [])]) say(`price warning: ${e}`);

// 2. The Terraform blocks for every resource on the diagram (and the ones a plan destroys).
const source = resolve(args.dir ?? dirname(planFile ?? stateFile));
const index = new SourceIndex(planFile ? join(source, 'terraform.tfstate') : stateFile);
const names = labelMap(parts!.state.resources);
const sources: Record<string, SourceResult | null> = {};
for (const n of [...parts!.base.graph.nodes, ...(compare?.base.graph.nodes ?? [])]) {
  for (const address of n.addresses) {
    if (address in sources) continue;
    const found = index.find(address);
    sources[address] = found ? { ...found, ...names.get(address) } : null;
  }
}

const updatedAt = new Date(statSync(planFile ?? stateFile).mtime).toISOString();
const snapshot = { ...parts!.base, cost: cost!, updatedAt };
// Cost over time: only real applies count, not previews of what might be applied.
if (mode === 'state') snapshot.history = recordHistory(config.historyDir, snapshot);
const bundle: StaticBundle = { snapshot, sources, generatedAt: new Date().toISOString(), compare };

// 3. Inline the built web app + data into one HTML file.
const html = inline(await webTemplate(say, args.quiet).catch((err: Error) => fail(err.message)), bundle);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile + '.tmp', html);
renameSync(outFile + '.tmp', outFile); // an open tab never sees a half-written file

const total = cost!.components.reduce((s, c) => s + componentMonthly(c, defaultUsage(cost!.usage)), 0);
const diff = compare && diffSnapshots(compare, snapshot, defaultUsageValues(snapshot), args['free-tier']);
if (compare && diff) {
  // The same summary a pull request comment needs, next to the page.
  const md = outFile.replace(/\.html$/, '') + '.md';
  writeFileSync(md, renderDiffMarkdown(diff));
  say(`${mode === 'plan' ? 'plan' : `${compare.targetLabel} vs ${compare.baseLabel}`}: ${diffSummary(diff)}`);
  say(`→ ${outFile} · ${md} (${Date.now() - t0} ms)`);
} else {
  say(`serial ${parts!.base.serial} · ${parts!.base.resourceCount} resources · ~${formatUsd(total)}/mo → ${outFile} (${Date.now() - t0} ms)`);
}
const print = { dark: args.theme === 'dark', freeTier: args['free-tier'], updatedAt: bundle.snapshot.updatedAt };
if (args.pdf || args['pdf-out']) await savePdf(printDiagram, outFile, resolve(args['pdf-out'] ?? outFile.replace(/\.html$/, '') + '.pdf'));
if (args.report) {
  const report = buildReport({ snapshot: bundle.snapshot, usage: defaultUsageValues(bundle.snapshot), freeTier: args['free-tier'], diff });
  const base = join(dirname(outFile), `${report.title.split(':')[0].replace(/[^\w.-]+/g, '-')}-brief`);
  writeFileSync(`${base}.md`, renderMarkdown(report));
  say(`report → ${base}.md`);
  await savePdf(printReport, outFile, `${base}.pdf`);
}
if (args.open) openFile(outFile);

// ── helpers ──

/** Opens a file in its default app. */
function openFile(file: string) {
  if (process.platform === 'win32') spawnSync('explorer.exe', [file], { stdio: 'ignore' }); // explorer always exits 1; ignore it
  else spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore' });
}

async function savePdf(printer: typeof printReport, html: string, pdf: string) {
  try {
    await printer(html, pdf, print);
    say(`pdf → ${pdf}`);
  } catch (err) {
    console.error(`[terraprev] ${(err as Error).message}`);
  }
}
