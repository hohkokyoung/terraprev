import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { OfferSet } from '../src/pricing/aws/offers.ts';
import { graviton } from '../src/pricing/aws/savings.ts';
import { combinedSaving, priceSavings, savingMonthly } from '../../shared/savings.ts';
import { defaultUsage, HOURS_PER_MONTH as H } from '../../shared/cost.ts';
import { buildReport, defaultUsageValues, renderMarkdown } from '../../shared/report.ts';
import { fakeOffers, fixtureState } from './fixture.ts';

const priced = async (state = fixtureState()) => {
  const parts = buildBase('/tmp/stack/terraform.tfstate', state, 'us-east-1');
  const cost = await priceSnapshot(parts, [new AwsPricer(fakeOffers)]);
  return { snapshot: { ...parts.base, cost }, cost };
};
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≠ ${b}`);

test('graviton: same shape, one family on; not for sizes or types it has no match for', () => {
  assert.equal(graviton('t3.small'), 't4g.small');
  assert.equal(graviton('m5.2xlarge'), 'm7g.2xlarge');
  assert.equal(graviton('db.r5.large'), 'db.r7g.large');
  assert.equal(graviton('t4g.small'), undefined);
  assert.equal(graviton('m5.metal'), undefined);
  assert.equal(graviton(undefined), undefined);
});

test('savings are priced from the price list, and overlapping ones count once', async () => {
  const { cost } = await priced();
  const usage = defaultUsage(cost.usage);
  const list = priceSavings(cost.components, cost.savings, usage, false);
  const by = (id: string) => list.find((p) => p.saving.id === id);
  // 3 × t3.small → t4g.small, via the launch template.
  close(by('graviton:aws_autoscaling_group.app')!.monthly, 3 * H * (0.0208 - 0.0168));
  // Reserve the one instance min_size keeps running; the other two stay on-demand.
  close(by('reserved:aws_autoscaling_group.app')!.monthly, H * (0.0208 - 0.013));
  close(by('graviton:aws_db_instance.main')!.monthly, H * (0.018 - 0.016));
  assert.ok(list.every((p, i) => i === 0 || list[i - 1].monthly >= p.monthly), 'biggest first');
  // Graviton and the reservation both change the ASG's instance line: only the bigger one counts.
  close(combinedSaving(list), 3 * H * 0.004 + H * 0.002);
  const g = by('graviton:aws_autoscaling_group.app')!.saving;
  assert.match(g.change!, /instance_type = "t4g\.small"/);
  assert.equal(g.replaces.length, 1, 'only the instance-hours line changes, not the volumes or IPs');
});

test('a saving that would cost more at this usage is not shown', async () => {
  const { cost } = await priced();
  const s = cost.savings!.find((x) => x.kind === 'graviton')!;
  const pricier = { ...s, with: s.with.map((c) => ({ ...c, tiers: [{ from: 0, to: null, price: 1 }] })) };
  assert.ok(savingMonthly(cost.components, pricier, defaultUsage(cost.usage), false) < 0);
  assert.ok(!priceSavings(cost.components, [pricier], defaultUsage(cost.usage), false).length);
});

test('reserved rates sit next to on-demand rows but never price the bill', () => {
  const set = new OfferSet({
    service: 'AmazonEC2', region: 'us-east-1', fetchedAt: 'now',
    rows: [
      { sku: 'A', usageType: 'BoxUsage:t3.small', operation: '', unit: 'Hrs', price: 0.013, from: 0, to: null, desc: 'reserved', attrs: {}, term: 'reserved' },
      { sku: 'A', usageType: 'BoxUsage:t3.small', operation: '', unit: 'Hrs', price: 0.0208, from: 0, to: null, desc: 'on demand', attrs: {} },
    ],
  });
  assert.equal(set.find({ usageType: 'BoxUsage:t3.small' })?.tiers[0].price, 0.0208);
  assert.equal(set.reserved('A'), 0.013);
  assert.equal(set.reserved('B'), undefined);
});

test('the brief lists the savings with what they take', async () => {
  const { snapshot } = await priced();
  const md = renderMarkdown(buildReport({ snapshot, usage: defaultUsageValues(snapshot), freeTier: false }));
  assert.match(md, /### Ways to cut the bill/);
  assert.match(md, /Run app-asg on t4g\.small \(Graviton\)/);
  assert.match(md, /could be saved without removing anything/);
});
