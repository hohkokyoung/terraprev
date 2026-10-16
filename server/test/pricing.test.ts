import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentMonthly, componentQuantity, defaultUsage, tieredCost } from '../../shared/cost.ts';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { parseCsvLine, withoutFreeTier } from '../src/pricing/aws/offers.ts';
import { fakeOffers, fixtureState } from './fixture.ts';

async function report() {
  const parts = buildBase('/tmp/x.tfstate', fixtureState(), 'us-east-1');
  return priceSnapshot(parts, [new AwsPricer(fakeOffers)]);
}

test('tiered pricing charges each band at its own rate', () => {
  const tiers = [{ from: 0, to: 100, price: 1 }, { from: 100, to: null, price: 0.5 }];
  assert.equal(tieredCost(tiers, 50), 50);
  assert.equal(tieredCost(tiers, 300), 100 + 100);
});

test('free-tier bands are removed and paid bands shifted to start at zero', () => {
  const t = withoutFreeTier([
    { from: 0, to: 1_000_000, price: 0, desc: 'First 1,000,000 requests per month are free' },
    { from: 1_000_000, to: null, price: 0.0000005, desc: '$0.50 per 1M' },
  ]);
  assert.deepEqual(t, [{ from: 0, to: null, price: 0.0000005 }]);
});

test('CSV parser handles quotes and embedded commas', () => {
  assert.deepEqual(parseCsvLine('"a","b, c","say ""hi""",,x'), ['a', 'b, c', 'say "hi"', '', 'x']);
});

test('ASG cost = desired × instance + root volume + public IPv4', async () => {
  const cost = await report();
  const asg = cost.components.filter((c) => c.nodeId === 'aws_autoscaling_group.app');
  const total = asg.reduce((s, c) => s + componentMonthly(c, {}), 0);
  const expected = 3 * 730 * 0.0208 + 3 * 8 * 0.08 + 3 * 730 * 0.005;
  assert.ok(Math.abs(total - expected) < 1e-9, `${total} vs ${expected}`);
  assert.ok(asg.some((c) => c.note?.includes('assumed')), 'flags the assumed root volume size');
});

test('Lambda compute scales with invocations × duration × memory (arm64)', async () => {
  const cost = await report();
  const compute = cost.components.find((c) => c.nodeId === 'aws_lambda_function.worker' && c.name.startsWith('Compute'))!;
  const u = { ...defaultUsage(cost.usage), 'aws_lambda_function.worker:invocations': 1_000_000, 'aws_lambda_function.worker:duration': 200 };
  assert.ok(Math.abs(componentQuantity(compute, u) - 1_000_000 * 0.2 * 0.5) < 1e-6, 'GB-seconds');
  assert.equal(compute.sku, 'SKU-Lambda-GB-Second-ARM-0.0000133334');
});

test('RDS picks engine + deployment specific SKUs', async () => {
  const cost = await report();
  const rds = cost.components.filter((c) => c.nodeId === 'aws_db_instance.main' && c.kind === 'fixed');
  const total = rds.reduce((s, c) => s + componentMonthly(c, {}), 0);
  assert.ok(Math.abs(total - (730 * 0.018 + 50 * 0.115)) < 1e-9);
});

test('ALB lines attach to the ALB node, incl. one public IPv4 per AZ', async () => {
  const cost = await report();
  const alb = cost.components.filter((c) => c.nodeId === 'aws_lb.main');
  assert.ok(alb.some((c) => c.name.startsWith('2 × public IPv4')));
});

test('free, unpriced and unknown-provider resources are reported, never silently $0', async () => {
  const cost = await report();
  assert.ok(cost.free.some((f) => f.type === 'aws_security_group'));
  assert.ok(cost.free.some((f) => f.type === 'aws_lb_listener'));
  assert.ok(cost.unpriced.some((u) => u.type === 'azurerm_resource_group' && /provider "azurerm"/.test(u.reason)));
  assert.ok(!cost.free.some((f) => f.type === 'random_password'), 'utility providers are ignored entirely');
});
