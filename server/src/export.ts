// Turns a snapshot into the self-contained page and prints it to PDF with the locally installed
// Chrome (no extra dependencies). Shared by `terraprev build` and the live server's PDF download.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { StaticBundle } from '../../shared/types.ts';
import { ROOT } from './config.ts';

export interface PrintOptions {
  dark: boolean;
  freeTier: boolean;
  /** The state's last-applied time, stamped into the PDF so identical input gives identical bytes. */
  updatedAt: string;
}

let building: Promise<void> | undefined;

/** web/dist/index.html, rebuilt first if the web sources changed since the last build. */
export async function webTemplate(say: (msg: string) => void, quiet = false): Promise<string> {
  const dist = join(ROOT, 'web', 'dist', 'index.html');
  const builtAt = existsSync(dist) ? statSync(dist).mtimeMs : 0;
  const newest = Math.max(newestMtime(join(ROOT, 'web', 'src')), newestMtime(join(ROOT, 'shared')), statSync(join(ROOT, 'web', 'index.html')).mtimeMs);
  if (newest > builtAt) {
    // One build at a time, however many requests are waiting on it.
    building ??= (async () => {
      say('building web app (sources changed)…');
      // npm is npm.cmd on Windows, which Node only launches through a shell.
      const r = await run('npm', ['run', 'build', '-w', 'web'], { cwd: ROOT, shell: process.platform === 'win32', stdio: quiet ? 'ignore' : ['ignore', 'ignore', 'inherit'] });
      if (r.code !== 0) throw new Error('web build failed');
    })().finally(() => (building = undefined));
    await building;
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

/** The built web app with its CSS, JS and the data inlined: one file that opens without a server. */
export function inline(template: string, data: StaticBundle): string {
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

/** The diagram on one A4 landscape page. */
export function printDiagram(html: string, pdf: string, o: PrintOptions): Promise<void> {
  return printPdf(html, pdf, ['print', o.dark ? 'dark' : 'light', o.freeTier ? 'free' : ''], [1123, 794], o.updatedAt);
}

/** The CTO brief on A4 portrait pages. */
export function printReport(html: string, pdf: string, o: PrintOptions): Promise<void> {
  return printPdf(html, pdf, ['report', o.dark ? 'dark' : '', o.freeTier ? 'free' : ''], [794, 1123], o.updatedAt);
}

async function printPdf(html: string, pdf: string, hash: string[], [w, h]: [number, number], updatedAt: string) {
  const chrome = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => process.env[v] ? [
      join(process.env[v]!, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env[v]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env[v]!, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ] : []),
  ].find((p) => p && existsSync(p));
  if (!chrome) throw new Error('PDF export needs Chrome, Edge, Brave or Chromium (or set CHROME_PATH)');
  const r = await run(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-pdf-header-footer',
    `--window-size=${w},${h}`,
    // ELK layout and the fit run on timers; let virtual time advance until the page settles.
    '--virtual-time-budget=10000',
    `--print-to-pdf=${pdf}`,
    `${pathToFileURL(html).href}#${hash.filter(Boolean).join('&')}`,
  ], { stdio: 'ignore', timeout: 90_000 });
  if (r.code !== 0 || !existsSync(pdf)) throw new Error(`PDF export failed (${r.error?.message ?? `exit ${r.code}`})`);
  pinPdfDates(pdf, updatedAt);
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

/** spawn, awaited: the live server keeps answering while Chrome or the build runs. */
function run(cmd: string, args: string[], opts: SpawnOptions): Promise<{ code: number | null; error?: Error }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, opts);
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
  });
}
