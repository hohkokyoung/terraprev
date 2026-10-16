import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildView, listStackFiles, resolveInStack } from '../src/views.ts';
import { readStack } from '../src/compare.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { fakeOffers, fixturePlan, fixtureState } from './fixture.ts';

/** A stack folder: the live state, staging next to it, two plans, and things that must not be listed. */
function stack() {
  const outer = mkdtempSync(join(tmpdir(), 'tp-views-'));
  const dir = join(outer, 'stack');
  const put = (rel: string, body: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const state = JSON.stringify(fixtureState());
  put('terraform.tfstate', state);
  put('terraform.tfstate.backup', state);
  put('staging/terraform.tfstate', state);
  put('envs/dev.tfstate', state);
  put('plan.json', JSON.stringify(fixturePlan()));
  put('plan.out', 'PK\u0003\u0004 a saved plan is a zip');
  put('planning-notes.json', JSON.stringify({ format_version: '1.0', notes: 'not a plan' }));
  put('node_modules/pkg/other.tfstate', state);
  put('.terraform/terraform.tfstate', state);
  put('a/b/c/d/deep.tfstate', state);
  writeFileSync(join(outer, 'outside.tfstate'), state);
  writeFileSync(join(outer, 'plan.json'), JSON.stringify(fixturePlan()));
  const stateFile = join(dir, 'terraform.tfstate');
  return { outer, dir, stateFile, root: dirname(stateFile) };
}

test('views: other state files and plans in the stack folder, labelled, without the live one or noise', () => {
  const { stateFile, root } = stack();
  const f = listStackFiles(root, stateFile);
  assert.deepEqual(f.states.map((s) => [s.path, s.label]), [['envs/dev.tfstate', 'dev'], ['staging/terraform.tfstate', 'staging']]);
  assert.deepEqual(f.plans.map((p) => p.path).sort(), ['plan.json', 'plan.out']);
});

test('views: only files inside the compare root can be read, and only the right kind', () => {
  const { stateFile, root } = stack();
  assert.match(resolveInStack(root, 'staging/terraform.tfstate', 'state'), /staging[\\/]terraform\.tfstate$/);
  assert.match(resolveInStack(root, 'plan.json', 'plan'), /plan\.json$/);
  for (const rel of ['../outside.tfstate', '../plan.json', join(stateFile, '..', '..', 'outside.tfstate'), 'missing.tfstate', '']) {
    assert.throws(() => resolveInStack(root, rel, rel.includes('plan') ? 'plan' : 'state'), (e: any) => e.status === 404 || e.status === 400, rel);
  }
  assert.throws(() => resolveInStack(root, 'plan.json', 'state'), /not a \.tfstate file/);
  assert.throws(() => resolveInStack(root, 'planning-notes.json', 'plan'), /not a Terraform plan/);
  assert.throws(() => resolveInStack(root, 'staging', 'state'), /not a file/);
});

test('views: a compare root above the stack reaches sibling env folders, and still nothing outside it', () => {
  const outer = mkdtempSync(join(tmpdir(), 'tp-envs-'));
  const envs = join(outer, 'envs');
  const state = (desired: number) => {
    const s = fixtureState();
    (s.resources.find((r) => r.type === 'aws_autoscaling_group')!.instances[0].attributes as Record<string, unknown>).desired_capacity = desired;
    return JSON.stringify(s);
  };
  for (const [env, desired] of [['prod', 3], ['staging', 1]] as const) {
    mkdirSync(join(envs, env), { recursive: true });
    writeFileSync(join(envs, env, 'terraform.tfstate'), state(desired));
  }
  writeFileSync(join(outer, 'secret.tfstate'), state(9));
  const prod = join(envs, 'prod', 'terraform.tfstate');
  // Default root (prod's folder) can't see staging; envs/ as the root can.
  assert.deepEqual(listStackFiles(dirname(prod), prod).states, []);
  assert.deepEqual(listStackFiles(envs, prod).states.map((s) => [s.path, s.label]), [['staging/terraform.tfstate', 'staging']]);
  assert.throws(() => resolveInStack(envs, '../secret.tfstate', 'state'), /is not a file in/);
  assert.ok(resolveInStack(envs, 'staging/terraform.tfstate', 'state'));
});

test('views: any stack on its own, any two compared either way round, or a plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-pick-'));
  const write = (env: string, desired: number) => {
    const s = fixtureState();
    (s.resources.find((r) => r.type === 'aws_autoscaling_group')!.instances[0].attributes as Record<string, unknown>).desired_capacity = desired;
    writeFileSync(join(root, `${env}.tfstate`), JSON.stringify(s));
  };
  write('demo', 3);
  write('prod', 4);
  write('staging', 1);
  writeFileSync(join(root, 'plan.json'), JSON.stringify(fixturePlan()));
  const ctx = { compareRoot: root, live: readStack(join(root, 'demo.tfstate'), 'us-east-1'), defaultRegion: 'us-east-1', pricers: [new AwsPricer(fakeOffers)] };
  const desired = (snap: any) => snap.graph.nodes.filter((n: any) => n.id.startsWith('aws_autoscaling_group.app#')).length;

  // Two stacks that are neither the live one, both ways round.
  const a = await buildView({ show: 'prod.tfstate', against: 'staging.tfstate' }, ctx);
  assert.deepEqual([a.compare?.targetLabel, a.compare?.baseLabel, desired(a.snapshot)], ['prod', 'staging', 4]);
  const b = await buildView({ show: 'staging.tfstate', against: 'prod.tfstate' }, ctx);
  assert.deepEqual([b.compare?.targetLabel, b.compare?.baseLabel, desired(b.snapshot)], ['staging', 'prod', 1]);
  // The live stack against another: the page already has the live snapshot.
  const c = await buildView({ show: 'live', against: 'staging.tfstate' }, ctx);
  assert.deepEqual([c.compare?.targetLabel, c.snapshot], ['demo', undefined]);
  // A stack on its own: its own snapshot and cost, nothing to compare.
  const d = await buildView({ show: 'staging.tfstate' }, ctx);
  assert.deepEqual([desired(d.snapshot), d.compare, d.snapshot?.cost.status], [1, undefined, 'ready']);
  // A plan: after apply, compared with its prior state.
  const e = await buildView({ show: 'plan.json', against: 'staging.tfstate' }, ctx);
  assert.equal(e.compare?.kind, 'plan');
  await assert.rejects(buildView({ show: 'prod.tfstate', against: 'prod.tfstate' }, ctx), /two different stacks/);
  await assert.rejects(buildView({ show: '../x.tfstate' }, ctx), /is not a file in/);
});
