import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../src/state/plan.ts';
import { planComparison, readPlan, stackComparison, stackLabel } from '../src/compare.ts';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { diffSnapshots, diffSummary, renderDiffMarkdown } from '../../shared/compare.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../shared/report.ts';
import { fakeOffers, fixturePlan, fixtureState, realPlan, SECRET } from './fixture.ts';

const pricers = [new AwsPricer(fakeOffers)];
const preview = async () => {
  const { parts, cost, compare } = await planComparison('/tmp/stack/plan.json', fixturePlan(), 'us-east-1', pricers);
  const snapshot = { ...parts.base, cost };
  return { parts, snapshot, compare, diff: diffSnapshots(compare, snapshot, defaultUsageValues(snapshot), false) };
};

test('plan: what happens to each address, without recomputed ids as "changes"', () => {
  const p = parsePlan(fixturePlan());
  assert.deepEqual(p.actions, {
    'aws_launch_template.app': 'update', 'aws_autoscaling_group.app': 'update', 'aws_db_instance.main': 'replace', 'aws_dynamodb_table.sessions': 'delete',
    'aws_eip.nat': 'create', 'aws_nat_gateway.main': 'create', 'aws_security_group.bastion': 'create', 'aws_instance.bastion': 'create',
  });
  assert.deepEqual(p.changedAttrs['aws_db_instance.main'], ['storage_encrypted']);
  assert.deepEqual(p.changedAttrs['aws_launch_template.app'], ['instance_type']);
  assert.deepEqual(p.unknownAfterApply, [], 'its public IP is decided at launch, by its subnet');
  assert.equal(p.region, 'us-east-1');
  assert.ok(!p.after.resources.some((r) => r.address === 'aws_dynamodb_table.sessions'));
});

test('plan: new resources connect through ids that are only known after apply', async () => {
  const { parts } = await preview();
  const node = (id: string) => parts.base.graph.nodes.find((n) => n.id === id)!;
  // The new EIP's id is unknown, but the NAT's allocation_id references it: the EIP folds into the NAT.
  assert.equal(parts.nodeOf.get('aws_eip.nat'), 'aws_nat_gateway.main');
  assert.equal(node('aws_nat_gateway.main').parentId, 'aws_subnet.public["a"]');
  // The bastion wears the new security group, whose id is unknown too.
  assert.deepEqual(node('aws_instance.bastion').access?.securityGroups.map((g) => g.name), ['bastion-sg']);
  const shown = JSON.stringify(parts.base.graph.nodes.map((n) => n.details));
  assert.ok(!shown.includes('(known after apply:'), 'placeholders never reach the page');
});

test('plan: cost before and after, changes per resource, findings that come and go', async () => {
  const { diff } = await preview();
  const status = Object.fromEntries(diff.status);
  assert.equal(status['aws_nat_gateway.main'], 'added');
  assert.equal(status['aws_instance.bastion'], 'added');
  assert.equal(status['aws_autoscaling_group.app'], 'changed', 'the launch template change shows on the ASG it folds into');
  assert.equal(status['aws_autoscaling_group.app#4'], 'added', 'desired 3 → 4 draws a fourth instance');
  assert.equal(status['aws_db_instance.main'], 'replaced');
  assert.equal(status['aws_dynamodb_table.sessions'], 'removed');
  assert.ok(Math.abs(diff.total.after - diff.total.before - diff.total.delta) < 1e-9);
  const asg = diff.nodes.find((n) => n.id === 'aws_autoscaling_group.app')!;
  // 3 × t3.small → 4 × t3.medium, plus one more public IPv4 and root volume.
  assert.ok(asg.delta > 70 && asg.delta < 90, `asg delta ${asg.delta}`);
  assert.deepEqual(asg.fields.map((f) => [f.key, f.before, f.after]), [['instance type', 't3.small', 't3.medium'], ['desired', '3', '4']]);
  assert.equal(diff.nodes.find((n) => n.id === 'aws_dynamodb_table.sessions')!.after, 0);
  assert.deepEqual(diff.ghosts.nodes.map((n) => [n.id, n.parentId]), [['aws_dynamodb_table.sessions', 'provider:aws']]);
  assert.ok(diff.findings.added.some((f) => f.id === 'sg-open:aws_security_group.bastion'), 'opens SSH to the internet');
  assert.ok(diff.findings.resolved.some((f) => f.id === 'rds-unencrypted:aws_db_instance.main'), 'encrypting the database fixes that finding');
  assert.match(diffSummary(diff), /^4 to add, 2 to change, 1 to replace, 1 to destroy · \$[\d.]+ → \$[\d.]+\/mo \(\+\$[\d.]+\)$/);
});

test('plan: Markdown for a pull request, and the brief leads with the changes; no secrets anywhere', async () => {
  const { snapshot, compare, diff } = await preview();
  const md = renderDiffMarkdown(diff);
  assert.match(md, /^## terraprev: plan preview/);
  assert.match(md, /\| app-asg · .* \| change \(instance type: t3\.small → t3\.medium; desired: 3 → 4\) \|/);
  assert.match(md, /\| bastion · [^|]* \| add \| – \| \$[\d.]+ \|/, 'priced with the public IPv4 its subnet gives it, so no ⚠');
  assert.match(md, /### New findings[\s\S]*bastion-sg opens port 22/);
  const brief = renderMarkdown(buildReport({ snapshot, usage: defaultUsageValues(snapshot), freeTier: false, diff }));
  assert.match(brief, /## What this plan changes/);
  assert.match(brief, /as it will be after the plan is applied/);
  for (const text of [md, brief, JSON.stringify(snapshot), JSON.stringify(compare)]) assert.ok(!text.includes(SECRET), 'secret leaked');
});

test('plan: real terraform output for a new stack connects, prices and shows no placeholders', async () => {
  const json = realPlan();
  const p = parsePlan(json);
  assert.equal(Object.keys(p.actions).length, 16);
  assert.ok(Object.values(p.actions).every((a) => a === 'create'));
  assert.equal(p.region, 'us-east-1');
  const dlq = p.after.resources.find((r) => r.type === 'aws_sqs_queue' && r.name === 'this')!;
  assert.deepEqual([dlq.address, dlq.baseAddress, dlq.module], ['module.dlq.aws_sqs_queue.this', 'module.dlq.aws_sqs_queue.this', 'module.dlq']);
  // Terraform lists aws_subnet.public[0].id with its prefixes aws_subnet.public[0] and aws_subnet.public: still one subnet.
  const attrs = (a: string) => p.after.resources.find((r) => r.address === a)!.attrs;
  assert.equal(attrs('aws_nat_gateway.main').subnet_id, attrs('aws_subnet.public[0]').id);
  assert.equal(attrs('aws_instance.web').subnet_id, attrs('aws_subnet.public[1]').id);
  // The provider marks the whole environment map unknown; module.dlq.arn is followed into the module.
  assert.deepEqual(Object.values(attrs('aws_lambda_function.worker').environment[0].variables), [
    attrs('aws_sqs_queue.jobs').url, attrs('aws_sqs_queue.jobs').arn, attrs('module.dlq.aws_sqs_queue.this').arn,
  ]);

  const { parts, cost, compare } = await planComparison('/tmp/real/plan.json', json, 'eu-west-1', pricers);
  const node = (id: string) => parts.base.graph.nodes.find((n) => n.id === id)!;
  assert.equal(parts.nodeOf.get('aws_eip.nat'), 'aws_nat_gateway.main');
  assert.equal(node('aws_nat_gateway.main').parentId, 'aws_subnet.public[0]');
  assert.equal(node('aws_instance.web').parentId, 'aws_subnet.public[1]');
  assert.deepEqual(node('aws_instance.web').access?.securityGroups.map((g) => g.name), ['web-sg']);
  assert.equal(parts.nodeOf.get('aws_launch_template.app'), 'aws_autoscaling_group.app');
  assert.deepEqual(['aws_autoscaling_group.app#1', 'aws_autoscaling_group.app#2'].map((id) => node(id).parentId), ['aws_subnet.private[0]', 'aws_subnet.private[1]']);
  const edges = parts.base.graph.edges.map((e) => `${e.source} -> ${e.target}`);
  for (const e of ['aws_lambda_function.worker -> aws_sqs_queue.jobs', 'aws_lambda_function.worker -> module.dlq.aws_sqs_queue.this', 'aws_sqs_queue.jobs -> aws_lambda_event_source_mapping.jobs']) {
    assert.ok(edges.includes(e), e);
  }
  assert.equal(node('aws_lambda_event_source_mapping.jobs').label, 'jobs', 'its function_name is only known after apply');
  for (const text of [JSON.stringify(parts.base), JSON.stringify(cost)]) assert.ok(!text.includes('(known after apply:'), 'placeholders never reach the page');
  assert.ok(!JSON.stringify(json).includes('access_key'), 'the fixture carries no provider credentials');

  const diff = diffSnapshots(compare, { ...parts.base, cost }, defaultUsageValues({ ...parts.base, cost }), false);
  const after = (id: string) => diff.nodes.find((n) => n.id === id)!.after;
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≠ ${b}`);
  near(after('aws_nat_gateway.main'), 730 * 0.045 + 10 * 0.045 + 730 * 0.005); // hours, 10 GB processed, the EIP it absorbed
  near(after('aws_autoscaling_group.app'), 2 * 730 * 0.0208 + 2 * 8 * 0.08); // 2 × t3.small from the launch template, 8 GB gp3 roots
  near(after('aws_instance.web'), 730 * 0.0104 + 8 * 0.08 + 730 * 0.005); // its new subnet maps a public IPv4 on launch
  assert.deepEqual(compare.unknownAfterApply, []);
  // The above, plus two SQS queues at 1M requests ($0.40 each) and the Lambda at default usage.
  assert.equal(diffSummary(diff), '16 to add · $0 → $81.37/mo (+$81.37)');
});

test('plan: an instance with no subnet to go by may get a public IPv4 at launch, and says so', async () => {
  const json: any = fixturePlan();
  delete json.planned_values.root_module.resources.find((r: any) => r.address === 'aws_instance.bastion').values.subnet_id;
  delete json.configuration.root_module.resources.find((r: any) => r.address === 'aws_instance.bastion').expressions.subnet_id;
  const { parts, cost, compare } = await planComparison('/tmp/stack/plan.json', json, 'us-east-1', pricers);
  assert.deepEqual(compare.unknownAfterApply, ['aws_instance.bastion']);
  assert.ok(!cost.components.some((c) => c.address === 'aws_instance.bastion' && /IPv4/.test(c.name)));
  const snapshot = { ...parts.base, cost };
  assert.match(renderDiffMarkdown(diffSnapshots(compare, snapshot, defaultUsageValues(snapshot), false)), /\| bastion · [^|]* \| add \| – \| \$[\d.]+ ⚠ \|/);
});

test('plan: a state file passed as a plan gets a helpful error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-plan-'));
  const state = join(dir, 'terraform.tfstate');
  writeFileSync(state, JSON.stringify(fixtureState()));
  assert.throws(() => readPlan(state), /is a state file, not a plan/);
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify(fixturePlan()));
  assert.ok(readPlan(plan));
});

test('stacks: what only one has, and what differs in configuration or cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-cmp-'));
  const staging = fixtureState();
  const asg = staging.resources.find((r) => r.type === 'aws_autoscaling_group')!.instances[0].attributes as Record<string, unknown>;
  asg.desired_capacity = 1;
  staging.resources = staging.resources.filter((r) => r.type !== 'aws_dynamodb_table');
  const stagingFile = join(dir, 'staging', 'terraform.tfstate');
  await import('node:fs').then((fs) => fs.mkdirSync(join(dir, 'staging')));
  writeFileSync(stagingFile, JSON.stringify(staging));
  const prod = buildBase(join(dir, 'prod', 'terraform.tfstate'), fixtureState(), 'us-east-1');
  const cost = await priceSnapshot(prod, pricers);
  const compare = await stackComparison(prod, stagingFile, 'us-east-1', pricers);
  assert.equal(compare.baseLabel, 'staging');
  assert.equal(compare.targetLabel, 'prod');
  const d = diffSnapshots(compare, { ...prod.base, cost }, {}, false);
  assert.equal(d.status.get('aws_dynamodb_table.sessions'), 'added');
  const a = d.nodes.find((n) => n.id === 'aws_autoscaling_group.app')!;
  assert.equal(a.change, 'changed');
  assert.deepEqual(a.fields.map((f) => [f.key, f.before, f.after]), [['desired', '1', '3']]);
  assert.ok(a.delta > 0);
  assert.equal(d.status.get('aws_lb.main'), undefined, 'identical resources are not listed');
  const md = renderDiffMarkdown(d);
  assert.match(md, /\| sessions · .* \| only in prod \|/);
  // Both stacks exist: side by side, no arrows, and the gap without a verdict.
  assert.match(md, /^\*\*prod costs \$[\d.]+ more than staging\*\* \(staging \$[\d.]+\/month, prod \$[\d.]+\/month\)/m);
  assert.match(md, /differs \(desired: staging 1 · prod 3\)/);
  assert.ok(!md.includes('→'), 'no arrows between two stacks');
  assert.match(diffSummary(d), /· staging \$[\d.]+\/mo, prod \$[\d.]+\/mo \(\$[\d.]+ more\)$/);
  // The brief (and its PDF) is a comparison too: both stacks in the title, header and cost tile.
  const r = buildReport({ snapshot: { ...prod.base, cost }, usage: {}, freeTier: false, diff: d });
  assert.equal(r.title, 'prod vs staging: architecture & cost comparison');
  assert.deepEqual(r.meta.slice(0, 2).map((m) => [m.label, m.value]), [['prod', 'prod/terraform.tfstate'], ['Compared with staging', 'staging/terraform.tfstate']]);
  assert.match(r.kpis[0].note ?? '', /^\$[\d.]+ more than staging \(\$[\d.]+\)$/);
  assert.equal(stackLabel('/x/staging.tfstate'), 'staging');
});
