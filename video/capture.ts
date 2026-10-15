// Screenshots of the real snapshot page for the demo video, plus where each control sits on screen
// (src/shots.json), so the video's cursor and zooms land on the right spots.
//
//   npm run snapshot -- --state demo.tfstate    (from the repo root: builds out/terraprev.html)
//   npm run capture                             (from video/)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'public', 'shots');
const W = 1600;
const H = 900;

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => process.env[v] ? [
    join(process.env[v]!, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env[v]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : []),
].find((p) => p && existsSync(p));
if (!chrome) throw new Error('Needs Chrome or Edge (or set CHROME_PATH)');

const html = join(ROOT, 'out', 'terraprev.html');
const STATE = join(ROOT, 'demo.tfstate');
if (!existsSync(html)) throw new Error(`No ${html}: run \`npm run snapshot\` in the repo root first`);

type Rect = { x: number; y: number; w: number; h: number };
const shots: Record<string, Record<string, Rect>> = {};

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: W, height: H, deviceScaleFactor: 2 } });
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.evaluateOnNewDocument(() => localStorage.clear());
// Show a generic state path instead of wherever this machine keeps the demo state.
await page.evaluateOnNewDocument((swaps: [string, string][]) => {
  const fix = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      let t = n.textContent ?? '';
      for (const [a, b] of swaps) t = t.split(a).join(b);
      if (t !== n.textContent) n.textContent = t;
    } else n.childNodes.forEach(fix);
  };
  new MutationObserver((ms) => ms.forEach((m) => (m.type === 'characterData' ? fix(m.target) : m.addedNodes.forEach(fix))))
    .observe(document, { subtree: true, childList: true, characterData: true });
}, [[STATE, '~/my-stack/terraform.tfstate'], [STATE.replace(/\\/g, '/'), '~/my-stack/terraform.tfstate'], ['terraprev/demo.tfstate', 'my-stack/terraform.tfstate']] as [string, string][]);
await page.goto(pathToFileURL(html).href);
await page.waitForSelector('.rnode');
await settle(page, 1500);
// One step out from the initial fit, so the canvas toolbar and minimap don't sit on top of boxes.
await click(page, '.react-flow__controls-zoomout');

const node = (label: string) => `xpath///div[contains(@class,"rnode")][.//span[@class="rnode__label" and text()="${label}"]]`;

await shot('overview', { total: '.total', cost: '.side', canvas: '.canvas', db: node('app-db'), stackbar: '.stackbar', legend: '.legend', costrows: '.costrows' });

await click(page, node('app-db'));
await shot('select', { db: node('app-db'), head: '.inspector__head', lines: '.lines' });

await click(page, '.tabs ::-p-text(Usage)');
// A real drag of the first slider, one shot per step, so the video's knob and total move with the cursor.
const RANGE = '.slider input[type="range"]';
const track = (await (await page.$(RANGE))!.boundingBox())!;
const y = track.y + track.height / 2;
const knob = 8; // half the thumb: its centre stops this far inside the track ends
const DRAG = [0, 0.1, 0.22, 0.36, 0.5, 0.64, 0.78, 0.9, 1];
await page.mouse.move(track.x + knob, y);
await page.mouse.down();
for (const [i, t] of DRAG.entries()) {
  const x = track.x + knob + t * (track.width - 2 * knob);
  await page.mouse.move(x, y, { steps: 4 });
  await shot(`drag-${i}`, { slider: '.slider', total: '.total' });
  shots[`drag-${i}`].cursor = { x: Math.round(x), y: Math.round(y), w: 0, h: 0 };
}
await page.mouse.up();
await click(page, '::-p-text(Reset to defaults)');

await click(page, '.tabs ::-p-text(Cost)');
await page.mouse.click(60, 400); // empty canvas: clear the selection
await settle(page, 400);
// Each click in the video cuts to the state it produced: before, toggle on, resource picked.
await shot('flow-0', { toggle: '.toggle--flow' });
await click(page, '::-p-text(Data flow)');
await shot('flow-1', { toggle: '.toggle--flow' });
await click(page, node('app-asg'));
await shot('flow', { asg: node('app-asg'), toggle: '.toggle--flow', paths: '.paths' });
await click(page, '::-p-text(Data flow)');

await click(page, '.rnode__chips');
await shot('access', { chips: '.rnode__chips.is-open' });
await click(page, '.rnode__chips.is-open');

await click(page, '::-p-text(Report)');
await page.waitForSelector('.doc');
await shot('report', { kpis: '.kpis', title: '.doc h1' });
await scrollReportTo(page, '.costsplit', 120);
await shot('report-cost', { split: '.costsplit', catbars: '.catbars' });
await scrollReportTo(page, '.finding', 140);
await shot('findings', { finding: '.finding' });
await click(page, '.report__close');

await click(page, '::-p-text(Dark)');
await click(page, '.react-flow__controls-zoomout');
await page.mouse.click(60, 400); // empty canvas: clear the selection
await click(page, '.tabs ::-p-text(Cost)');
await shot('dark', { canvas: '.canvas' });

writeFileSync(join(import.meta.dirname, 'src', 'shots.json'), JSON.stringify({ width: W, height: H, shots }, null, 2) + '\n');
await browser.close();
console.log(`${Object.keys(shots).length} shots → ${OUT}`);

async function shot(name: string, targets: Record<string, string>) {
  await settle(page, 600);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  shots[name] = {};
  for (const [key, sel] of Object.entries(targets)) {
    const el = await page.waitForSelector(sel, { timeout: 5000 });
    const b = await el!.boundingBox();
    if (b) shots[name][key] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  }
}

async function click(p: Page, sel: string) {
  const el = await p.waitForSelector(sel, { timeout: 5000 });
  await el!.click();
  await settle(p, 500);
}

/** Scroll the report so `sel` sits `top` px below the viewport top. */
function scrollReportTo(p: Page, sel: string, top: number) {
  return p.evaluate((s, t) => {
    const r = document.querySelector('.report')!;
    r.scrollTop += document.querySelector(s)!.getBoundingClientRect().top - t;
  }, sel, top);
}

function settle(p: Page, ms: number) {
  return p.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
}
