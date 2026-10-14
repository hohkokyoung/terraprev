// terraprev build: one-shot, no server. Reads the state + .tf files, prices it from the
// on-disk price cache, and writes a single self-contained HTML file you can double-click.
//
//   node server/src/cli/build.ts [--state path/to/terraform.tfstate] [--out file.html]
//                                [--offline] [--refresh-prices] [--open]
//                                [--pdf [file.pdf]] [--theme light|dark] [--free-tier]
//                                [--report]   (CTO brief: out/<name>-brief.md + .pdf)

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { SourceResult, StaticBundle } from '../../../shared/types.ts';
import { componentMonthly, defaultUsage, formatUsd } from '../../../shared/cost.ts';
import { loadConfig, ROOT } from '../config.ts';
import { buildBase, priceSnapshot } from '../snapshot.ts';
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
const html = inline(webTemplate(), bundle);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile + '.tmp', html);
renameSync(outFile + '.tmp', outFile); // an open tab never sees a half-written file

const total = cost.components.reduce((s, c) => s + componentMonthly(c, defaultUsage(cost.usage)), 0);
say(`serial ${parts.base.serial} · ${parts.base.resourceCount} resources · ~${formatUsd(total)}/mo → ${outFile} (${Date.now() - t0} ms)`);
if (args.pdf || args['pdf-out']) exportPdf(outFile, resolve(args['pdf-out'] ?? outFile.replace(/\.html$/, '') + '.pdf'));
if (args.report) {
  const report = buildReport({ snapshot: bundle.snapshot, usage: defaultUsageValues(bundle.snapshot), freeTier: args['free-tier'] });
  const base = join(dirname(outFile), `${report.title.split(':')[0].replace(/[^\w.-]+/g, '-')}-brief`);
  writeFileSync(`${base}.md`, renderMarkdown(report));
  say(`report → ${base}.md`);
  printPdf(outFile, `${base}.pdf`, ['report', args.theme === 'dark' ? 'dark' : '', args['free-tier'] ? 'free' : ''].filter(Boolean).join('&'), [794, 1123]);
}
if (args.open) spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [outFile], { stdio: 'ignore' });

// ── helpers ──

/** web/dist/index.html, rebuilt first if the web sources changed since the last build. */
function webTemplate(): string {
  const dist = join(ROOT, 'web', 'dist', 'index.html');
  const builtAt = existsSync(dist) ? statSync(dist).mtimeMs : 0;
  const newest = Math.max(newestMtime(join(ROOT, 'web', 'src')), newestMtime(join(ROOT, 'shared')), statSync(join(ROOT, 'web', 'index.html')).mtimeMs);
  if (newest > builtAt) {
    say('building web app (sources changed)…');
    const r = spawnSync('npm', ['run', 'build', '-w', 'web'], { cwd: ROOT, stdio: args.quiet ? 'ignore' : ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) {
      console.error('[terraprev] web build failed');
      process.exit(1);
    }
  }
  return readFileSync(dist, 'utf8');
}

function newestMtime(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

function inline(template: string, data: StaticBundle): string {
  const assetDir = join(ROOT, 'web', 'dist');
  const read = (href: string) => readFileSync(join(assetDir, href.replace(/^\.?\//, '')), 'utf8');
  // JSON inside <script>: escape "<" so "</script>" in any value can't end the tag.
  const json = JSON.stringify(data).replace(/[<\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return template
    .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${read(href)}</style>`)
    .replace(
      /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
      (_, src) => `<script>window.__TERRAPREV__=${json}</script>\n<script type="module">${read(src).replace(/<\/script/gi, '<\\/script')}</script>`,
    );
}

/** Prints the snapshot's diagram to a one-page PDF with the locally installed Chrome (no extra dependencies). */
function exportPdf(html: string, pdf: string) {
  const hash = ['print', args.theme === 'dark' ? 'dark' : 'light', args['free-tier'] ? 'free' : ''].filter(Boolean).join('&');
  printPdf(html, pdf, hash, [1123, 794]);
}

function printPdf(html: string, pdf: string, hash: string, [w, h]: [number, number]) {
  const chrome = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => p && existsSync(p));
  if (!chrome) {
    console.error('[terraprev] PDF export needs Chrome, Edge, Brave or Chromium (or set CHROME_PATH)');
    return;
  }
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-pdf-header-footer',
    `--window-size=${w},${h}`,
    // ELK layout and the fit run on timers; let virtual time advance until the page settles.
    '--virtual-time-budget=10000',
    `--print-to-pdf=${pdf}`,
    `file://${html}#${hash}`,
  ], { stdio: 'ignore', timeout: 90_000 });
  if (r.status === 0 && existsSync(pdf)) {
    pinPdfDates(pdf, bundle.snapshot.updatedAt);
    say(`pdf → ${pdf}`);
  }
  else console.error(`[terraprev] PDF export failed (${r.error?.message ?? `exit ${r.status}`})`);
}

/**
 * Chrome stamps the print time into /CreationDate and /ModDate, so identical input would give a
 * different PDF every run. Rewrite both to the state's last-applied time. Same byte length, so the
 * PDF's cross-reference offsets stay valid.
 */
function pinPdfDates(pdf: string, iso: string) {
  const buf = readFileSync(pdf);
  const text = buf.toString('latin1');
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
  const out = text.replace(/(\/(?:CreationDate|ModDate)\s*\()(D:[^)]*)(\))/g, (m, a: string, v: string, b: string) => (v.length === stamp.length ? a + stamp + b : m));
  writeFileSync(pdf, Buffer.from(out, 'latin1'));
}
