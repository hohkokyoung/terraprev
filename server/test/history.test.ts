import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryPoint, Snapshot } from '../../shared/types.ts';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { readHistory, recordHistory } from '../src/history.ts';
import { historySentence, summarizeHistory } from '../../shared/history.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../shared/report.ts';
import { fakeOffers, fixtureState } from './fixture.ts';

const at = async (serial: number, desired: number, appliedAt: string): Promise<Snapshot> => {
  const state = fixtureState();
  state.serial = serial;
  (state.resources.find((r) => r.type === 'aws_autoscaling_group')!.instances[0].attributes as Record<string, unknown>).desired_capacity = desired;
  const parts = buildBase('/tmp/stack/terraform.tfstate', state, 'us-east-1');
  return { ...parts.base, updatedAt: appliedAt, cost: await priceSnapshot(parts, [new AwsPricer(fakeOffers)]) };
};

test('one point per apply, kept per lineage; a rebuild of the same serial replaces its point', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hist-'));
  assert.equal(recordHistory(dir, await at(7, 3, '2026-09-01T10:00:00Z')).length, 1);
  assert.equal(recordHistory(dir, await at(7, 3, '2026-09-01T10:00:00Z')).length, 1);
  const points = recordHistory(dir, await at(9, 5, '2026-10-10T10:00:00Z'));
  assert.deepEqual(points.map((p) => p.serial), [7, 9]);
  assert.ok(points[1].fixed > points[0].fixed);
  assert.deepEqual(readHistory(dir, 'test-lineage'), points);
  assert.deepEqual(readHistory(dir, 'other-lineage'), []);
  // Rebuilding an old serial shows history up to it, not after.
  assert.deepEqual(recordHistory(dir, await at(7, 3, '2026-09-01T10:00:00Z')).map((p) => p.serial), [7]);
});

test('prices still loading are not recorded: a $0 point would look like a real drop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hist-'));
  const s = await at(3, 3, '2026-09-01T10:00:00Z');
  assert.deepEqual(recordHistory(dir, { ...s, cost: { ...s.cost, status: 'loading' } }), []);
  assert.deepEqual(readHistory(dir, 'test-lineage'), []);
});

test('summary: change since the last apply, and over about a month, with the category that moved most', () => {
  const p = (serial: number, appliedAt: string, compute: number, database: number): HistoryPoint => ({
    serial, appliedAt, resourceCount: 10, fixed: compute + database, usage: 0, byCategory: { Compute: compute, Database: database }, findings: { high: 0, medium: 0 },
  });
  const points = [p(1, '2026-08-01T00:00:00Z', 50, 20), p(2, '2026-09-01T00:00:00Z', 50, 20), p(3, '2026-09-20T00:00:00Z', 60, 20), p(4, '2026-10-05T00:00:00Z', 60, 60)];
  const s = summarizeHistory(points)!;
  assert.equal(s.previous?.serial, 3);
  assert.equal(s.since?.serial, 2, 'the newest point at least 30 days before the last');
  assert.equal(s.delta, 50);
  assert.deepEqual(s.driver, { category: 'Database', delta: 40 });
  assert.equal(historySentence(s), 'Since 1 Sep 2026 (serial 2) the bill went up 71% (+$50.00/month), mostly Database (+$40.00).');
  assert.equal(historySentence(summarizeHistory([points[0]])), undefined);
});

test('the brief shows cost over time once there is more than one apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hist-'));
  recordHistory(dir, await at(7, 3, '2026-09-01T10:00:00Z'));
  const s = await at(9, 5, '2026-10-10T10:00:00Z');
  s.history = recordHistory(dir, s);
  const md = renderMarkdown(buildReport({ snapshot: s, usage: defaultUsageValues(s), freeTier: false }));
  assert.match(md, /### Cost over time/);
  assert.match(md, /Since 1 Sep 2026 \(serial 7\) the bill went up/);
});
