import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { defaultUsage, lineCosts } from '../../shared/cost.ts';
import { fakeOffers, fixturePlan, fixtureState, SECRET } from './fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'tp-mcp-'));
const stateFile = join(root, 'terraform.tfstate');
writeFileSync(stateFile, JSON.stringify(fixtureState()));
writeFileSync(join(root, 'main.tf'), `resource "aws_lb" "main" {\n  name = "web-alb"\n}\n`);

const server = createMcpServer({
  config: { stateFile, port: 0, defaultRegion: 'us-east-1', priceCacheDays: 7, cacheDir: join(root, '.cache'), historyDir: join(root, 'history'), compareRoot: root },
  pricers: [new AwsPricer(fakeOffers)],
});
const client = new Client({ name: 'test', version: '0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  assert.ok(!text.includes(SECRET), `${name} leaked a secret`);
  return { isError: r.isError === true, text };
}
const callJson = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).text);

test('lists every tool', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['build_snapshot', 'compare_stacks', 'cost_history', 'describe_resource', 'estimate_cost', 'get_brief', 'list_findings', 'preview_plan', 'stack_overview', 'suggest_savings']);
});

test('plan preview: cost before and after, every change, and Markdown for a PR', async () => {
  const plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify(fixturePlan()));
  const p = await callJson('preview_plan', { plan });
  assert.deepEqual(p.resources, { create: 4, update: 2, replace: 1, delete: 1 });
  assert.ok(Math.abs(p.after - p.before - p.delta) <= 0.011);
  assert.ok(p.changes.some((c: { resource: string; change: string }) => c.resource === 'main-nat' && c.change === 'add'));
  assert.ok(p.newFindings.some((f: { title: string }) => /bastion-sg opens port 22/.test(f.title)));
  assert.match(p.markdown, /## terraprev: plan preview/);
  const missing = await call('preview_plan', { plan: join(root, 'nope.json') });
  assert.ok(missing.isError);
  assert.match(missing.text, /terraform show -json/);
});

test('compare stacks, savings and history', async () => {
  const other = join(root, 'staging.tfstate');
  const staging = fixtureState();
  staging.resources = staging.resources.filter((r) => r.type !== 'aws_dynamodb_table');
  writeFileSync(other, JSON.stringify(staging));
  const c = await callJson('compare_stacks', { other });
  assert.equal(c.baseStack, 'staging');
  assert.ok(c.changes.some((x: { resource: string; change: string }) => x.resource === 'sessions' && x.change.startsWith('only in')));
  const s = await callJson('suggest_savings');
  assert.ok(s.total > 0);
  assert.ok(s.savings.some((x: { title: string; terraformChange?: string }) => /Graviton/.test(x.title) && x.terraformChange));
  const h = await callJson('cost_history');
  assert.equal(h.applies, 0);
  assert.match(h.summary, /No history yet/);
});

test('overview: summary, costs, findings and the resource list', async () => {
  const o = await callJson('stack_overview');
  assert.equal(o.serial, 7);
  assert.ok(o.summary.length > 0);
  assert.ok(o.topCosts.length > 0);
  assert.ok(o.findings.high + o.findings.medium > 0);
  assert.ok(o.resources.some((r: { address: string }) => r.address === 'aws_lb.main'));
});

test('cost: lines add up, and usage overrides move the total', async () => {
  const base = await callJson('estimate_cost');
  const sum = base.lines.reduce((s: number, l: { monthly: number }) => s + l.monthly, 0);
  assert.ok(Math.abs(sum - base.total) < 0.05);
  // The total is the page's total to the cent: summed before rounding, not from rounded lines.
  const cost = await priceSnapshot(buildBase(stateFile, fixtureState(), 'us-east-1'), [new AwsPricer(fakeOffers)]);
  const exact = [...lineCosts(cost.components, defaultUsage(cost.usage), false).values()].reduce((s, l) => s + l.monthly, 0);
  assert.equal(base.total, Math.round(exact * 100) / 100);
  assert.ok(Math.abs(base.fixed + base.usageBased - base.total) <= 0.011, 'each part is rounded on its own, so at most a cent apart');
  const key = base.usageParams[0].key;
  const more = await callJson('estimate_cost', { usage: { [key]: base.usageParams[0].max } });
  assert.ok(more.total > base.total, 'raising usage should raise the total');
  const odd = await callJson('estimate_cost', { usage: { 'no:such-key': 5 } });
  assert.deepEqual(odd.ignoredUsageKeys, ['no:such-key']);
});

test('findings filter by severity', async () => {
  const high = await callJson('list_findings', { severity: ['high'] });
  assert.ok(high.length > 0);
  assert.ok(high.every((f: { severity: string }) => f.severity === 'high'));
});

test('describe a resource by name: config, paths in, and its .tf block', async () => {
  const alb = await callJson('describe_resource', { resource: 'web-alb' });
  assert.deepEqual(alb.addresses.slice(0, 1), ['aws_lb.main']);
  assert.ok(alb.outgoing.length > 0);
  assert.match(alb.terraform[0].blocks[0].text, /resource "aws_lb" "main"/);
  const db = await callJson('describe_resource', { resource: 'app-db' });
  assert.ok(db.findings.some((f: { title: string }) => /backups/i.test(f.title)));
});

test('unknown resource and missing state are tool errors, not crashes', async () => {
  const r = await call('describe_resource', { resource: 'nope' });
  assert.ok(r.isError);
  assert.match(r.text, /No resource "nope"/);
  const s = await call('stack_overview', { state: join(root, 'missing.tfstate') });
  assert.ok(s.isError);
  assert.match(s.text, /No state file/);
  // A folder, or a file that isn't state JSON: the error names the file, not just Node's message.
  const dir = await call('stack_overview', { state: root });
  assert.ok(dir.isError);
  assert.match(dir.text, /is a folder/);
  const broken = join(root, 'broken.tfstate');
  writeFileSync(broken, '{ "version": 4, "resources": [');
  const b = await call('stack_overview', { state: broken });
  assert.ok(b.isError);
  assert.match(b.text, /Could not read .*broken\.tfstate as Terraform state/);
});

test('usage must be non-negative, and the documented example key is a real one', async () => {
  const { usageParams } = await callJson('estimate_cost');
  const neg = await client.callTool({ name: 'estimate_cost', arguments: { usage: { [usageParams[0].key]: -5 } } }).then((r) => r.isError === true, () => true);
  assert.ok(neg, 'negative usage should be rejected');
  const { tools } = await client.listTools();
  const doc = JSON.stringify(tools.find((t) => t.name === 'estimate_cost')!.inputSchema);
  const example = doc.match(/"(aws_[a-z_]+\.[a-z_]+:[a-z_]+)\\?"/)?.[1];
  assert.ok(usageParams.some((p: { key: string }) => p.key === example), `example key ${example} is not a usage key`);
});

test('brief is the same Markdown the CLI writes', async () => {
  const { text } = await call('get_brief');
  for (const h of ['## Executive summary', '```mermaid', '## Findings & recommendations']) assert.ok(text.includes(h), `missing ${h}`);
});
