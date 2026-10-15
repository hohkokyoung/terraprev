// terraprev build: one-shot, no server. Reads the state + .tf files, prices it from the
// on-disk price cache, and writes a single self-contained HTML file you can double-click.
//
//   node server/src/cli/build.ts [--state path/to/terraform.tfstate] [--out file.html]
//                                [--offline] [--refresh-prices] [--open]
//                                [--pdf [file.pdf]] [--theme light|dark] [--free-tier]
//                                [--report]   (CTO brief: out/<name>-brief.md + .pdf)

import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { SourceResult, StaticBundle } from '../../../shared/types.ts';
import { componentMonthly, defaultUsage, formatUsd } from '../../../shared/cost.ts';
import { loadConfig, ROOT } from '../config.ts';
import { buildBase, priceSnapshot } from '../snapshot.ts';
import { inline, printDiagram, printReport, webTemplate } from '../export.ts';
import { AwsOffers } from '../pricing/aws/offers.ts';
import { AwsPricer } from '../pricing/aws/pricer.ts';
import { SourceIndex } from '../source/hcl.ts';
import { labelMap } from '../source/labels.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../../shared/report.ts';

const { values: args } = parseArgs({
  options: {
    state: { type: 'string' },
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

const config = loadConfig();
const stateFile = args.state ? resolve(args.state) : config.stateFile;
const outFile = resolve(args.out ?? join(ROOT, 'out', 'terraprev.html'));

if (!existsSync(stateFile)) {
  console.error(`[terraprev] no state file at ${stateFile}. Run terraform apply first, or pass --state.`);
  process.exit(1);
}

// 1. Diagram + prices, exactly as the live server computes them.
const parts = buildBase(stateFile, JSON.parse(readFileSync(stateFile, 'utf8')), config.defaultRegion);
const offers = new AwsOffers(
  config.cacheDir,
  args['refresh-prices'] ? 0 : config.priceCacheDays,
  (p) => p.done && say(`downloaded ${p.source} price list (${(p.loadedBytes / 1e6).toFixed(0)} MB)`),
  { offline: args.offline },
);
const cost = await priceSnapshot(parts, [new AwsPricer(offers)]);
for (const e of cost.errors) say(`price warning: ${e}`);

// 2. The Terraform blocks for every resource on the diagram.
const index = new SourceIndex(stateFile);
const names = labelMap(parts.state.resources);
const sources: Record<string, SourceResult | null> = {};
for (const n of parts.base.graph.nodes) {
  for (const address of n.addresses) {
    const found = index.find(address);
    sources[address] = found ? { ...found, ...names.get(address) } : null;
  }
}

const bundle: StaticBundle = {
  snapshot: { ...parts.base, cost, updatedAt: new Date(statSync(stateFile).mtime).toISOString() },
  sources,
  generatedAt: new Date().toISOString(),
};

// 3. Inline the built web app + data into one HTML file.
const html = inline(await webTemplate(say, args.quiet).catch((err: Error) => {
  console.error(`[terraprev] ${err.message}`);
  process.exit(1);
}), bundle);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile + '.tmp', html);
renameSync(outFile + '.tmp', outFile); // an open tab never sees a half-written file

const total = cost.components.reduce((s, c) => s + componentMonthly(c, defaultUsage(cost.usage)), 0);
say(`serial ${parts.base.serial} · ${parts.base.resourceCount} resources · ~${formatUsd(total)}/mo → ${outFile} (${Date.now() - t0} ms)`);
const print = { dark: args.theme === 'dark', freeTier: args['free-tier'], updatedAt: bundle.snapshot.updatedAt };
if (args.pdf || args['pdf-out']) await savePdf(printDiagram, outFile, resolve(args['pdf-out'] ?? outFile.replace(/\.html$/, '') + '.pdf'));
if (args.report) {
  const report = buildReport({ snapshot: bundle.snapshot, usage: defaultUsageValues(bundle.snapshot), freeTier: args['free-tier'] });
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
