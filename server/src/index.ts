import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, watchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Comparison, PriceProgress, Snapshot } from '../../shared/types.ts';
import { loadConfig, ROOT } from './config.ts';
import { watchState } from './watch.ts';
import { buildBase, loadingCost, priceSnapshot, type SnapshotParts } from './snapshot.ts';
import { AwsOffers } from './pricing/aws/offers.ts';
import { AwsPricer } from './pricing/aws/pricer.ts';
import { SourceIndex } from './source/hcl.ts';
import { labelMap } from './source/labels.ts';
import { inline, printReport, webTemplate } from './export.ts';
import { readHistory, recordHistory } from './history.ts';
import { buildView, listStackFiles, ViewError, type ViewRequest } from './views.ts';
import { cleanUsage, readUsage, usagePath, writeUsage } from './usage.ts';
import type { UsageFile } from '../../shared/types.ts';

const config = loadConfig();

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
const broadcast: Listener = (event, data) => listeners.forEach((l) => l(event, data));

let snapshot: Snapshot | undefined;
let lastError: string | undefined;
/** The live state, built: what a comparison compares against. */
let parts: SnapshotParts | undefined;
let generation = 0;
/** address → real resource name, from the latest state (for labelling source blocks). */
let names = new Map<string, { name?: string; type: string }>();

const offers = new AwsOffers(config.cacheDir, config.priceCacheDays, (p: PriceProgress) => broadcast('progress', p));
const pricers = [new AwsPricer(offers)];
const sources = new SourceIndex(config.stateFile);

async function onState(json: unknown) {
  const gen = ++generation;
  try {
    const built = buildBase(config.stateFile, json, config.defaultRegion);
    parts = built;
    names = labelMap(built.state.resources);
    // Keep showing the previous prices while new ones compute, so the total doesn't blink.
    const prevCost = snapshot?.cost.status === 'ready' ? { ...snapshot.cost, status: 'loading' as const } : loadingCost(built.region);
    // "Last applied" = when terraform last wrote the state, not when we read it.
    try {
      built.base.updatedAt = statSync(config.stateFile).mtime.toISOString();
    } catch {
      /* keep read time */
    }
    // History so far, so the chart doesn't blink; the new point lands once prices are in.
    snapshot = { ...built.base, cost: prevCost, history: readHistory(config.historyDir, built.base.lineage) };
    lastError = undefined;
    broadcast('snapshot', snapshot);
    log(`state serial ${built.base.serial}: ${built.base.resourceCount} resources, ${built.base.graph.nodes.length} nodes`);

    const cost = await priceSnapshot(built, pricers);
    if (gen !== generation) return; // a newer apply landed meanwhile
    snapshot = { ...snapshot, cost };
    snapshot.history = recordHistory(config.historyDir, snapshot);
    broadcast('snapshot', snapshot);
    const fixed = cost.components.filter((c) => c.kind === 'fixed').length;
    log(`priced: ${fixed} fixed + ${cost.components.length - fixed} usage components, ${cost.unpriced.length} unpriced`);
    for (const e of cost.errors) log(`price error: ${e}`);
  } catch (err) {
    lastError = (err as Error).message;
    broadcast('error', { message: lastError });
    log(`error: ${lastError}`);
  }
}

if (!existsSync(config.stateFile)) log(`waiting for ${config.stateFile} (run terraform apply)`);
watchState(config.stateFile, onState, (err) => {
  lastError = `Could not read state: ${err.message}`;
  broadcast('error', { message: lastError });
});

// Usage assumptions live in terraprev.usage.json, so the page, snapshot builds and the MCP server agree.
// `origin` names the page that made a change, so it can ignore its own echo.
let usageFile: UsageFile = readUsage(config.stateFile, log);
const sendUsage = (origin?: string) => broadcast('usage', { ...usageFile, origin });
watchFile(usagePath(config.stateFile), { interval: 1000 }, () => {
  const next = readUsage(config.stateFile, log);
  if (JSON.stringify(next) === JSON.stringify(usageFile)) return; // our own write
  usageFile = next;
  sendUsage();
});

const app = new Hono();

app.get('/api/usage', (c) => c.json(usageFile));
app.put('/api/usage', async (c) => {
  const body = await c.req.json().catch(() => undefined);
  if (!body || typeof body !== 'object') return c.json({ error: 'expected { usage, freeTier }' }, 400);
  try {
    usageFile = writeUsage(config.stateFile, cleanUsage(body));
  } catch (err) {
    log(`usage: ${(err as Error).message}`);
    return c.json({ error: `Could not save ${usagePath(config.stateFile)}: ${(err as Error).message}` }, 500);
  }
  sendUsage(c.req.header('x-terraprev-client'));
  return c.json(usageFile);
});

app.get('/api/snapshot', (c) => (snapshot ? c.json(snapshot) : c.json({ error: lastError ?? 'No state yet', stateFile: config.stateFile }, 503)));

// Other views of the stack: state files to compare with and plans to preview, from the compare root only.
app.get('/api/views', (c) => c.json(listStackFiles(config.compareRoot, config.stateFile)));

// Any stack in the compare root on its own, any two compared, or a plan (paths relative to the root;
// "live" = the watched state): ?show=prod.tfstate&against=staging.tfstate, ?show=live&against=…, ?show=plan.json
app.get('/api/view', (c) => viewRoute(c, () => showView({ show: c.req.query('show'), against: c.req.query('against') })));

const showView = (req: ViewRequest) => buildView(req, { compareRoot: config.compareRoot, live: parts, defaultRegion: config.defaultRegion, pricers });

async function viewRoute(c: Context, run: () => Promise<unknown>) {
  try {
    return c.json(await run());
  } catch (err) {
    const status = err instanceof ViewError ? err.status : 400;
    log(`view: ${(err as Error).message}`);
    return c.json({ error: (err as Error).message }, status);
  }
}

// The HCL block(s) that declared a resource, read fresh from disk each time.
app.get('/api/source', (c) => {
  const address = c.req.query('address');
  if (!address) return c.json({ error: 'address required' }, 400);
  const found = sources.find(address);
  return found ? c.json({ ...found, ...names.get(address) }) : c.json({ error: `No block for ${address} in ${config.stateFile.replace(/\/[^/]+$/, '')}` }, 404);
});

// The brief as a PDF, printed by headless Chrome and sent as a file: no browser print preview.
// Body: { theme: 'light' | 'dark', freeTier: boolean, usage: { [key]: number }, view?: { show, against } }
// (the page's current settings, and what's on screen when it isn't just the live stack).
app.post('/api/report.pdf', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let snap = snapshot;
  let compare: Comparison | undefined;
  try {
    if (body.view) ({ snapshot: snap = snap, compare } = await showView({ show: body.view.show, against: body.view.against }));
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof ViewError ? err.status : 400);
  }
  if (!snap || snap.cost.status !== 'ready') return c.json({ error: 'Prices are still loading; try again in a moment.' }, 503);
  const usage = Object.fromEntries(Object.entries(body.usage ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
  const dir = mkdtempSync(join(tmpdir(), 'terraprev-'));
  try {
    const html = join(dir, 'report.html');
    const pdf = join(dir, 'report.pdf');
    writeFileSync(html, inline(await webTemplate(log), { snapshot: snap, sources: {}, usage, generatedAt: new Date().toISOString(), compare }));
    await printReport(html, pdf, { dark: body.theme === 'dark', freeTier: body.freeTier === true, updatedAt: snap.updatedAt });
    return c.body(readFileSync(pdf), 200, { 'Content-Type': 'application/pdf' });
  } catch (err) {
    log(`report pdf: ${(err as Error).message}`);
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const send: Listener = (event, data) => void stream.writeSSE({ event, data: JSON.stringify(data) });
    listeners.add(send);
    send('usage', usageFile);
    if (snapshot) send('snapshot', snapshot);
    else if (lastError) send('error', { message: lastError });
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 20_000);
    await new Promise<void>((done) => stream.onAbort(done));
    clearInterval(ping);
    listeners.delete(send);
  }),
);

// Production: serve the built web app.
const dist = resolve(ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: dist }));
  app.get('*', serveStatic({ path: resolve(dist, 'index.html') }));
}

serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  log(`api on http://127.0.0.1:${info.port}  watching ${config.stateFile}`);
});

function log(msg: string) {
  console.log(`[terraprev] ${new Date().toLocaleTimeString()} ${msg}`);
}
