import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { PriceProgress, Snapshot } from '../../shared/types.ts';
import { loadConfig, ROOT } from './config.ts';
import { watchState } from './watch.ts';
import { buildBase, loadingCost, priceSnapshot } from './snapshot.ts';
import { AwsOffers } from './pricing/aws/offers.ts';
import { AwsPricer } from './pricing/aws/pricer.ts';
import { SourceIndex } from './source/hcl.ts';
import { labelMap } from './source/labels.ts';

const config = loadConfig();

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
const broadcast: Listener = (event, data) => listeners.forEach((l) => l(event, data));

let snapshot: Snapshot | undefined;
let lastError: string | undefined;
let generation = 0;
/** address → real resource name, from the latest state (for labelling source blocks). */
let names = new Map<string, { name?: string; type: string }>();

const offers = new AwsOffers(config.cacheDir, config.priceCacheDays, (p: PriceProgress) => broadcast('progress', p));
const pricers = [new AwsPricer(offers)];
const sources = new SourceIndex(config.stateFile);

async function onState(json: unknown) {
  const gen = ++generation;
  try {
    const parts = buildBase(config.stateFile, json, config.defaultRegion);
    names = labelMap(parts.state.resources);
    // Keep showing the previous prices while new ones compute, so the total doesn't blink.
    const prevCost = snapshot?.cost.status === 'ready' ? { ...snapshot.cost, status: 'loading' as const } : loadingCost(parts.region);
    // "Last applied" = when terraform last wrote the state, not when we read it.
    try {
      parts.base.updatedAt = statSync(config.stateFile).mtime.toISOString();
    } catch {
      /* keep read time */
    }
    snapshot = { ...parts.base, cost: prevCost };
    lastError = undefined;
    broadcast('snapshot', snapshot);
    log(`state serial ${parts.base.serial}: ${parts.base.resourceCount} resources, ${parts.base.graph.nodes.length} nodes`);

    const cost = await priceSnapshot(parts, pricers);
    if (gen !== generation) return; // a newer apply landed meanwhile
    snapshot = { ...snapshot, cost };
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

const app = new Hono();

app.get('/api/snapshot', (c) => (snapshot ? c.json(snapshot) : c.json({ error: lastError ?? 'No state yet', stateFile: config.stateFile }, 503)));

// The HCL block(s) that declared a resource, read fresh from disk each time.
app.get('/api/source', (c) => {
  const address = c.req.query('address');
  if (!address) return c.json({ error: 'address required' }, 400);
  const found = sources.find(address);
  return found ? c.json({ ...found, ...names.get(address) }) : c.json({ error: `No block for ${address} in ${config.stateFile.replace(/\/[^/]+$/, '')}` }, 404);
});

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const send: Listener = (event, data) => void stream.writeSSE({ event, data: JSON.stringify(data) });
    listeners.add(send);
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
