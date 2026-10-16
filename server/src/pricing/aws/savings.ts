// Ways to cut an AWS bill, each priced from the same price lists as the bill itself. A rule changes one
// thing about a resource (instance family, volume type, a reservation), prices the result with the
// normal pricing rules, and keeps only the cost lines that differ. How much that saves is worked out
// where it's shown (shared/savings.ts), so it follows the usage sliders and the free tier.

import type { CostComponent, CostReport, Saving, TfResource } from '../../../../shared/types.ts';
import { formatUnitPrice } from '../../../../shared/cost.ts';
import { displayName } from '../../graph/catalog.ts';
import type { PricingResult } from '../types.ts';

export interface SavingsContext {
  /** This provider's managed resources. */
  resources: TfResource[];
  all: TfResource[];
  nodeOf: Map<string, string>;
  region: string;
  components: CostComponent[];
  unpriced: CostReport['unpriced'];
  /** Prices `r` with the normal pricing rules; `all` replaces the other resources (e.g. a changed launch template). */
  price(r: TfResource, all?: TfResource[]): PricingResult;
  /** 1-year standard No Upfront reserved rate for an on-demand SKU, per hour. */
  reservedRate(service: string, sku: string): number | undefined;
}

/** x86 family → the Graviton family with the same shape (vCPUs, memory), one generation on. */
const EC2_GRAVITON: Record<string, string> = {
  t2: 't4g', t3: 't4g', t3a: 't4g',
  m4: 'm7g', m5: 'm7g', m5a: 'm7g', m6i: 'm7g', m6a: 'm7g', m7i: 'm7g', m7a: 'm7g',
  c4: 'c7g', c5: 'c7g', c5a: 'c7g', c6i: 'c7g', c6a: 'c7g', c7i: 'c7g', c7a: 'c7g',
  r4: 'r7g', r5: 'r7g', r5a: 'r7g', r6i: 'r7g', r6a: 'r7g', r7i: 'r7g', r7a: 'r7g',
};
const RDS_GRAVITON: Record<string, string> = { t2: 't4g', t3: 't4g', m4: 'm7g', m5: 'm7g', m6i: 'm7g', r4: 'r7g', r5: 'r7g', r6i: 'r7g' };
const ARM_CAVEAT = 'Needs an arm64 (Graviton) AMI. Most Linux distributions and container images publish one; check any native dependencies.';
const RESERVED_CAVEAT = 'A 1-year commitment, billed every hour whether it runs or not. Bought in the AWS console or CLI, not in Terraform. A Compute Savings Plan gives a similar discount with more flexibility.';
const GP3_DETAIL = 'gp3 costs about 20% less per GB than gp2, and has a higher baseline (3,000 IOPS, 125 MB/s) at any size.';

export function graviton(type: unknown): string | undefined {
  const m = /^(db\.)?([a-z]+\d+[a-z]*)\.([\w-]+)$/.exec(String(type ?? ''));
  const family = m && (m[1] ? RDS_GRAVITON : EC2_GRAVITON)[m[2]];
  return family && !m[3].includes('metal') ? `${m[1] ?? ''}${family}.${m[3]}` : undefined;
}

const lineKey = (c: CostComponent) => `${c.sku}|${c.quantity.base}|${(c.quantity.usage ?? []).join(',')}`;
const serviceOf = (c: CostComponent) => c.source.replace('AWS Price List · ', '');
const isInstanceLine = (c: CostComponent) => c.kind === 'fixed' && /instance \(/i.test(c.name) && !/volume|IPv4/i.test(c.name);
const pct = (from: number, to: number) => `${Math.round((1 - to / from) * 100)}%`;

export function awsSavings(ctx: SavingsContext): Saving[] {
  const out: Saving[] = [];
  const own = (r: TfResource) => ctx.components.filter((c) => c.address === r.address);
  const unpricedCount = (r: TfResource) => ctx.unpriced.filter((u) => u.address === r.address).length;
  const nodeOf = (r: TfResource) => ctx.nodeOf.get(r.address) ?? r.address;

  /** A saving from pricing `alt` instead of `r`: only the cost lines that differ are swapped. */
  const alternative = (kind: Saving['kind'], r: TfResource, alt: TfResource, text: Pick<Saving, 'title' | 'detail' | 'caveat' | 'change'>, all?: TfResource[]) => {
    const priced = ctx.price(alt, all);
    if (priced.unpriced.length > unpricedCount(r)) return; // e.g. no Graviton size that large
    const mine = own(r);
    const altKeys = new Set(priced.components.map(lineKey));
    const ownKeys = new Set(mine.map(lineKey));
    const id = `${kind}:${r.address}`;
    const replaces = mine.filter((c) => !altKeys.has(lineKey(c))).map((c) => c.id);
    const swapIn = priced.components.filter((c) => !ownKeys.has(lineKey(c))).map((c) => ({ ...c, id: `${id}>${c.id}` }));
    if (!replaces.length) return;
    out.push({ id, kind, nodeId: nodeOf(r), ...text, replaces, with: swapIn });
  };

  /** Reserve `reserve` of the `count` instances an on-demand line bills for; the rest stay on-demand. */
  const reservation = (r: TfResource, line: CostComponent | undefined, count: number, reserve: number, what: string) => {
    if (!line || reserve <= 0 || line.tiers.length !== 1 || !line.sku) return;
    const od = line.tiers[0].price;
    const rate = ctx.reservedRate(serviceOf(line), line.sku);
    if (!rate || rate >= od * 0.97) return;
    const id = `reserved:${r.address}`;
    const per = line.quantity.base / Math.max(1, count);
    const swapIn: CostComponent[] = [{
      ...line, id: `${id}>reserved`, name: `${reserve === count ? '' : `${reserve} × `}${line.name.replace(/^\d+ × /, '').replace(/, on-demand\)$/, ')')} · 1-yr reserved`,
      tiers: [{ from: 0, to: null, price: rate }], quantity: { base: per * reserve },
      priceDescription: `1-year standard Reserved Instance, No Upfront: ${formatUnitPrice(rate, 'Hrs')}`, freeTier: undefined,
    }];
    if (reserve < count) swapIn.push({ ...line, id: `${id}>on-demand`, name: `${count - reserve} × ${line.name.replace(/^\d+ × /, '')}`, quantity: { base: per * (count - reserve) } });
    out.push({
      id, kind: 'reserved', nodeId: nodeOf(r),
      title: `Reserve ${displayName(r)} for a year`,
      detail: `A 1-year Reserved ${what} (standard, no upfront) bills ${formatUnitPrice(rate, 'Hrs')} instead of ${formatUnitPrice(od, 'Hrs')} on-demand, ${pct(od, rate)} less.${reserve < count ? ` Reserve the ${reserve === 1 ? 'instance that always runs' : `${reserve} instances that always run`} (min_size); scaling above that stays on-demand.` : ''}`,
      caveat: RESERVED_CAVEAT,
      replaces: [line.id], with: swapIn,
    });
  };

  for (const r of ctx.resources) {
    const a = r.attrs;
    switch (r.type) {
      case 'aws_instance': {
        const g = graviton(a.instance_type);
        if (g) alternative('graviton', r, { ...r, attrs: { ...a, instance_type: g } }, {
          title: `Run ${displayName(r)} on ${g} (Graviton)`,
          detail: `${a.instance_type} → ${g}: the same vCPUs and memory on AWS's Arm processors, for less per hour.`,
          caveat: ARM_CAVEAT, change: `instance_type = "${g}"`,
        });
        const root = a.root_block_device?.[0];
        if (root?.volume_type === 'gp2') alternative('gp3', r, { ...r, attrs: { ...a, root_block_device: [{ ...root, volume_type: 'gp3' }] } }, {
          title: `Switch ${displayName(r)}'s root volume to gp3`, detail: GP3_DETAIL, caveat: 'Changes online, with no downtime.', change: 'root_block_device { volume_type = "gp3" }',
        });
        reservation(r, own(r).find(isInstanceLine), 1, 1, 'Instance');
        break;
      }
      case 'aws_autoscaling_group': {
        const ltId = a.launch_template?.[0]?.id ?? a.mixed_instances_policy?.[0]?.launch_template?.[0]?.launch_template_specification?.[0]?.launch_template_id;
        const lt = ctx.all.find((x) => x.type === 'aws_launch_template' && x.attrs.id === ltId);
        if (!lt) break;
        const withLt = (attrs: Record<string, any>) => {
          const alt = { ...lt, attrs: { ...lt.attrs, ...attrs } };
          return ctx.all.map((x) => (x === lt ? alt : x));
        };
        const g = graviton(lt.attrs.instance_type);
        if (g) alternative('graviton', r, r, {
          title: `Run ${displayName(r)} on ${g} (Graviton)`,
          detail: `${lt.attrs.instance_type} → ${g} in the launch template ${displayName(lt)}: the same vCPUs and memory on AWS's Arm processors, for less per hour.`,
          caveat: `${ARM_CAVEAT} The ASG replaces instances on its next refresh.`, change: `instance_type = "${g}"  # ${lt.address}`,
        }, withLt({ instance_type: g }));
        const bdm = lt.attrs.block_device_mappings?.[0];
        const ebs = bdm?.ebs?.[0];
        if (ebs?.volume_type === 'gp2') alternative('gp3', r, r, {
          title: `Switch ${displayName(r)}'s root volumes to gp3`, detail: GP3_DETAIL, caveat: 'Applies to instances launched after the change.', change: `block_device_mappings { ebs { volume_type = "gp3" } }  # ${lt.address}`,
        }, withLt({ block_device_mappings: [{ ...bdm, ebs: [{ ...ebs, volume_type: 'gp3' }] }] }));
        const desired = Number(a.desired_capacity ?? a.min_size ?? 0);
        reservation(r, own(r).find(isInstanceLine), desired, Math.min(desired, Number(a.min_size ?? 0)), 'Instance');
        // Public IPv4 per instance, although users come in through the load balancer.
        const ipv4 = own(r).find((c) => /public IPv4/i.test(c.name));
        const behindLb = (a.target_group_arns ?? []).length > 0 || ctx.all.some((x) => x.type === 'aws_autoscaling_attachment' && x.attrs.autoscaling_group_name === a.name);
        if (ipv4 && behindLb && ctx.all.some((x) => x.type === 'aws_nat_gateway')) {
          out.push({
            id: `private-subnets:${r.address}`, kind: 'private-subnets', nodeId: nodeOf(r),
            title: `Move ${displayName(r)} to private subnets`,
            detail: `Each of its ${desired} instances gets a public IPv4 address, though users reach them through the load balancer. In private subnets they need none, and stop being reachable from the internet.`,
            caveat: 'They then reach the internet through the NAT gateway, which charges per GB processed.',
            change: 'vpc_zone_identifier = [private subnet ids]', replaces: [ipv4.id], with: [],
          });
        }
        break;
      }
      case 'aws_db_instance': {
        const g = graviton(a.instance_class);
        if (g) alternative('graviton', r, { ...r, attrs: { ...a, instance_class: g } }, {
          title: `Run ${displayName(r)} on ${g} (Graviton)`,
          detail: `${a.instance_class} → ${g}: the same engine, vCPUs and memory on AWS's Arm processors, for less per hour.`,
          caveat: `Applied as a modify with a short restart${a.multi_az ? ' (a failover, with Multi-AZ)' : ''}; schedule it in a maintenance window.`,
          change: `instance_class = "${g}"`,
        });
        if (String(a.storage_type || 'gp2') === 'gp2') alternative('gp3', r, { ...r, attrs: { ...a, storage_type: 'gp3' } }, {
          title: `Switch ${displayName(r)}'s storage to gp3`, detail: GP3_DETAIL, caveat: 'Runs online, but can take a while on large volumes.', change: 'storage_type = "gp3"',
        });
        reservation(r, own(r).find(isInstanceLine), 1, 1, 'DB instance');
        break;
      }
      case 'aws_ebs_volume':
        if (a.type === 'gp2') alternative('gp3', r, { ...r, attrs: { ...a, type: 'gp3' } }, {
          title: `Switch ${displayName(r)} to gp3`, detail: GP3_DETAIL, caveat: 'Changes online, with no downtime.', change: 'type = "gp3"',
        });
        break;
      case 'aws_lambda_function':
        if (!(a.architectures ?? []).includes('arm64') && (a.package_type ?? 'Zip') === 'Zip') alternative('arm64', r, { ...r, attrs: { ...a, architectures: ['arm64'] } }, {
          title: `Run ${displayName(r)} on arm64 (Graviton)`,
          detail: 'Arm functions cost about 20% less per GB-second of compute, at the same memory.',
          caveat: 'Native dependencies need arm64 builds; plain Python, Node.js or Java code usually runs unchanged.',
          change: 'architectures = ["arm64"]',
        });
        break;
      case 'aws_eip': {
        const idle = own(r).find((c) => /idle/i.test(c.name));
        if (idle) out.push({
          id: `release-ip:${r.address}`, kind: 'release-ip', nodeId: nodeOf(r),
          title: `Release the unused Elastic IP ${displayName(r)}`,
          detail: 'It is not attached to anything, and AWS bills idle public IPv4 addresses by the hour.',
          caveat: 'Only if nothing will need this exact address again.', change: `remove ${r.address}`,
          replaces: [idle.id], with: [],
        });
        break;
      }
      case 'aws_cloudwatch_log_group':
        if (!Number(a.retention_in_days)) alternative('log-retention', r, { ...r, attrs: { ...a, retention_in_days: 30 } }, {
          title: `Expire ${displayName(r)}'s logs after 30 days`,
          detail: 'The log group never expires, so its storage grows every month.',
          caveat: 'Older logs are deleted: keep what audits need (90 or 365 days are common).', change: 'retention_in_days = 30',
        });
        break;
    }
  }

  // S3 and DynamoDB traffic from private subnets pays NAT data processing unless a free gateway endpoint takes it.
  const nat = ctx.resources.find((r) => r.type === 'aws_nat_gateway');
  const natBytes = nat && own(nat).find((c) => /data processed/i.test(c.name));
  const gateway = (svc: string) => ctx.all.some((r) => r.type === 'aws_vpc_endpoint' && r.attrs.vpc_endpoint_type === 'Gateway' && String(r.attrs.service_name).endsWith(`.${svc}`));
  const missing = [
    ctx.all.some((r) => r.type === 'aws_s3_bucket') && !gateway('s3') && 'S3',
    ctx.all.some((r) => r.type === 'aws_dynamodb_table') && !gateway('dynamodb') && 'DynamoDB',
  ].filter((x): x is string => !!x);
  if (nat && natBytes && missing.length) {
    const rate = natBytes.tiers[0]?.price ?? 0;
    out.push({
      id: 'gateway-endpoints', kind: 'gateway-endpoints', nodeId: nodeOf(nat),
      title: `Add free ${missing.join(' and ')} gateway endpoint${missing.length > 1 ? 's' : ''}`,
      detail: `Traffic from private subnets to ${missing.join(' and ')} goes through the NAT gateway, which charges ${formatUnitPrice(rate, 'GB')} processed. Gateway endpoints cost nothing and take that traffic off the NAT.`,
      caveat: 'Add the endpoint to the private route tables; bucket policies that check source IPs may need updating.',
      change: missing.map((m) => `aws_vpc_endpoint { vpc_endpoint_type = "Gateway", service_name = "com.amazonaws.${ctx.region}.${m.toLowerCase()}" }`).join('\n'),
      replaces: [], with: [], perUnit: `${formatUnitPrice(rate, 'GB')} of ${missing.join('/')} traffic`,
    });
  }
  return out;
}
