import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentMonthly, componentQuantity, defaultUsage, tieredCost } from '../../shared/cost.ts';
import { buildBase, priceSnapshot } from '../src/snapshot.ts';
import { AwsPricer } from '../src/pricing/aws/pricer.ts';
import { OfferSet, parseCsvLine, withoutFreeTier, type AwsOffers, type OfferRow } from '../src/pricing/aws/offers.ts';
import { fixtureState } from './fixture.ts';

const row = (usageType: string, price: number, unit: string, attrs: Record<string, string> = {}, extra: Partial<OfferRow> = {}): OfferRow => ({
  sku: `SKU-${usageType}-${price}`, usageType, operation: '', unit, price, from: 0, to: null, desc: '', attrs, ...extra,
});

/** Offline stand-in for the AWS price list with real us-east-1 prices. */
const OFFERS: Record<string, OfferRow[]> = {
  AmazonEC2: [
    row('BoxUsage:t3.small', 0.0208, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }),
    row('EBS:VolumeUsage.gp3', 0.08, 'GB-Mo'),
  ],
  AmazonVPC: [row('USE1-PublicIPv4:InUseAddress', 0.005, 'Hrs')],
  AWSELB: [row('LoadBalancerUsage', 0.0225, 'Hrs', {}, { operation: 'LoadBalancing:Application' }), row('LCUUsage', 0.008, 'LCU-Hrs', {}, { operation: 'LoadBalancing:Application' })],
  AWSQueueService: [row('Requests-RBP', 0.0000004, 'Requests')],
  AWSLambda: [row('Request-ARM', 0.0000002, 'Requests'), row('Lambda-GB-Second-ARM', 0.0000133334, 'Lambda-GB-Second')],
  AmazonRDS: [
    row('InstanceUsage:db.t3.micro', 0.018, 'Hrs', { 'Product Family': 'Database Instance', 'Instance Type': 'db.t3.micro', 'Database Engine': 'PostgreSQL', 'Deployment Option': 'Single-AZ', 'License Model': 'No license required' }),
    row('RDS:GP3-Storage', 0.115, 'GB-Mo', { 'Product Family': 'Database Storage', 'Database Engine': 'PostgreSQL' }),
    row('RDS:ChargedBackupUsage', 0.095, 'GB-Mo', { 'Database Engine': 'Any' }),
  ],
  AmazonDynamoDB: [row('ReadRequestUnits', 0.000000125, 'ReadRequestUnits'), row('WriteRequestUnits', 0.000000625, 'WriteRequestUnits'), row('TimedStorage-ByteHrs', 0.25, 'GB-Mo')],
};

const fakeOffers = {
  load: async (service: string, region: string) => new OfferSet({ service, region, rows: OFFERS[service] ?? [], fetchedAt: 'now' }),
} as unknown as AwsOffers;

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
