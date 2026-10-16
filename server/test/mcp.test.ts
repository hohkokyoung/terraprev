import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { fakeOffers, fixtureState, SECRET } from './fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'tp-mcp-'));
const stateFile = join(root, 'terraform.tfstate');
writeFileSync(stateFile, JSON.stringify(fixtureState()));
writeFileSync(join(root, 'main.tf'), `resource "aws_lb" "main" {\n  name = "web-alb"\n}\n`);

const server = createMcpServer({
  config: { stateFile, port: 0, defaultRegion: 'us-east-1', priceCacheDays: 7, cacheDir: join(root, '.cache') },
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['build_snapshot', 'describe_resource', 'estimate_cost', 'get_brief', 'list_findings', 'stack_overview']);
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
});

test('brief is the same Markdown the CLI writes', async () => {
  const { text } = await call('get_brief');
  for (const h of ['## Executive summary', '```mermaid', '## Findings & recommendations']) assert.ok(text.includes(h), `missing ${h}`);
});
