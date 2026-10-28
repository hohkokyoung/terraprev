import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['build_snapshot', 'compare_stacks', 'cost_history', 'describe_resource', 'estimate_cost', 'find_resources', 'get_brief', 'list_findings', 'preview_plan', 'set_usage', 'stack_overview', 'suggest_savings', 'what_if']);
});

test('prompts: ready-made questions that name the tools to use', async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['cost_change', 'explain_bill', 'harden_stack', 'price_change', 'review_plan']);
  const review = await client.getPrompt({ name: 'review_plan', arguments: { plan: 'plan.json' } });
  const text = (review.messages[0].content as { text: string }).text;
  assert.match(text, /plan\.json/);
  assert.match(text, /preview_plan/);
  const price = await client.getPrompt({ name: 'price_change', arguments: { change: 'make app-db multi-AZ' } });
  assert.match((price.messages[0].content as { text: string }).text, /make app-db multi-AZ[\s\S]*what_if/);
});

test('what if: priced like a plan, without writing anything', async () => {
  const before = await callJson('estimate_cost');
  const more = await callJson('what_if', { changes: [{ resource: 'app-asg', set: { desired_capacity: 4 } }] });
  assert.ok(more.delta > 0, 'a fourth instance should cost more');
  assert.equal(more.before, before.total);
  assert.ok(more.changes.some((c: { resource: string }) => c.resource === 'app-asg'));
  assert.equal(more.markdown, undefined, 'no pull-request Markdown: nothing here is a plan');
  const arm = await callJson('what_if', { changes: [{ resource: 'aws_launch_template.app', set: { instance_type: 't4g.small' } }] });
  assert.ok(arm.delta < 0, 'Graviton should be cheaper');
  const gone = await callJson('what_if', { changes: [{ resource: 'sessions', remove: true }] });
  assert.ok(gone.delta < 0);
  assert.ok(gone.changes.some((c: { resource: string; change: string }) => c.resource === 'sessions' && /destroy/.test(c.change)));
  const backups = await callJson('what_if', { changes: [{ resource: 'app-db', set: { backup_retention_period: 7 } }] });
  assert.ok(backups.resolvedFindings.some((t: string) => /backups/i.test(t)), 'turning backups on resolves the backup finding');
  const typo = await callJson('what_if', { changes: [{ resource: 'app-db', set: { instance_clas: 'db.t4g.micro' } }] });
  assert.match(typo.warnings[0], /no "instance_clas"/);
  const missing = await call('what_if', { changes: [{ resource: 'nope', set: { a: 1 } }] });
  assert.ok(missing.isError);
  assert.match(missing.text, /No resource "nope"/);
  assert.equal((await callJson('estimate_cost')).total, before.total, 'what_if must not change the stack');
});

test('find resources: by kind, cost, internet reach and findings', async () => {
  const db = await callJson('find_resources', { kind: 'database' });
  assert.deepEqual(db.resources.map((r: { name: string }) => r.name).sort(), ['app-db', 'sessions']);
  const withParts = await callJson('find_resources', { kind: 'database', include_supporting: true });
  assert.ok(withParts.resources.some((r: { name: string }) => r.name === 'db-subnets'), 'the subnet group is a supporting piece');
  const open = await callJson('find_resources', { reachable_from_internet: true });
  assert.ok(open.resources.some((r: { name: string }) => r.name === 'web-alb'));
  assert.ok(open.resources.every((r: { reachableFromInternet: boolean }) => r.reachableFromInternet));
  const dear = await callJson('find_resources', { min_monthly: 20 });
  assert.ok(dear.resources.length > 0 && dear.resources.every((r: { monthly: number }) => r.monthly >= 20));
  const high = await callJson('find_resources', { finding_severity: 'high' });
  assert.ok(high.resources.some((r: { name: string; findings: { worst: string } }) => r.name === 'app-db' && r.findings.worst === 'high'));
  const inPrivate = await callJson('find_resources', { in: 'private' });
  assert.deepEqual(inPrivate.resources.map((r: { name: string }) => r.name), ['app-db']);
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

// Last: it writes terraprev.usage.json, which every later answer is priced at.
test('saved usage assumptions price every answer, and set_usage writes them', async () => {
  const file = join(root, 'terraprev.usage.json');
  const base = await callJson('estimate_cost');
  const p = base.usageParams[0];
  try {
    const saved = await callJson('set_usage', { usage: { [p.key]: p.max } });
    assert.equal(saved.file, file);
    assert.deepEqual(saved.saved, { [p.key]: p.max });
    assert.ok(existsSync(file));
    const after = await callJson('estimate_cost');
    assert.ok(after.total > base.total, 'the saved value should raise the total');
    assert.equal(after.total, saved.total);
    assert.equal(after.usageParams.find((x: { key: string }) => x.key === p.key).source, 'saved');
    assert.equal(after.assumptionsFile, file);
    // A call's own override still wins, for that call only.
    const once = await callJson('estimate_cost', { usage: { [p.key]: p.default } });
    assert.equal(once.total, base.total);
    // The brief and the overview read the same file.
    const overview = await callJson('stack_overview');
    assert.ok(overview.topCosts.length > 0);
    const odd = await call('set_usage', { usage: { 'no:such-key': 1 } });
    assert.ok(odd.isError);
    assert.match(odd.text, /Unknown usage keys/);
    // Back to the default: the file has nothing left to say, so it goes.
    const reset = await callJson('set_usage', { usage: { [p.key]: null } });
    assert.deepEqual(reset.saved, {});
    assert.ok(!existsSync(file));
    assert.equal((await callJson('estimate_cost')).total, base.total);
  } finally {
    rmSync(file, { force: true });
  }
});
