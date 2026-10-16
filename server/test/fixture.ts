// A small but realistic state: VPC with public/private subnets, ALB → ASG, SQS → Lambda, RDS with a sensitive password.

import { readFileSync } from 'node:fs';
import { OfferSet, type AwsOffers, type OfferRow } from '../src/pricing/aws/offers.ts';

export const SECRET = 'Sup3rS3cretPassw0rd!';

const res = (type: string, name: string, attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  mode: 'managed',
  type,
  name,
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [{ attributes: attrs, sensitive_attributes: [], dependencies: [], ...extra }],
});

const arn = (svc: string, rest: string) => `arn:aws:${svc}:us-east-1:111122223333:${rest}`;

export function fixtureState() {
  return {
    version: 4,
    terraform_version: '1.9.0',
    serial: 7,
    lineage: 'test-lineage',
    resources: [
      res('aws_vpc', 'main', { id: 'vpc-111111', cidr_block: '10.0.0.0/16', tags: { Name: 'main-vpc' } }),
      {
        ...res('aws_subnet', 'public', {}),
        instances: [
          { index_key: 'a', attributes: { id: 'subnet-pub-a', vpc_id: 'vpc-111111', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: true }, dependencies: [] },
          { index_key: 'b', attributes: { id: 'subnet-pub-b', vpc_id: 'vpc-111111', cidr_block: '10.0.2.0/24', availability_zone: 'us-east-1b', map_public_ip_on_launch: true }, dependencies: [] },
        ],
      },
      res('aws_subnet', 'private', { id: 'subnet-prv-a', vpc_id: 'vpc-111111', cidr_block: '10.0.10.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: false }),
      res('aws_security_group', 'app', {
        id: 'sg-app111', vpc_id: 'vpc-111111', name: 'app-sg',
        ingress: [{ protocol: 'tcp', from_port: 443, to_port: 443, cidr_blocks: ['0.0.0.0/0'], security_groups: [] }],
        egress: [{ protocol: '-1', from_port: 0, to_port: 0, cidr_blocks: ['0.0.0.0/0'], security_groups: [] }],
      }),
      res('aws_lb', 'main', {
        id: arn('elasticloadbalancing', 'loadbalancer/app/web/abc'), arn: arn('elasticloadbalancing', 'loadbalancer/app/web/abc'),
        name: 'web-alb', load_balancer_type: 'application', internal: false, subnets: ['subnet-pub-a', 'subnet-pub-b'], vpc_id: 'vpc-111111',
        dns_name: 'web-alb-123.us-east-1.elb.amazonaws.com', security_groups: ['sg-app111'],
      }),
      res('aws_lb_target_group', 'app', { id: arn('elasticloadbalancing', 'targetgroup/app/def'), arn: arn('elasticloadbalancing', 'targetgroup/app/def'), name: 'app-tg', target_type: 'instance', port: 8080 }),
      res('aws_lb_listener', 'http', {
        id: arn('elasticloadbalancing', 'listener/app/web/abc/l1'), arn: arn('elasticloadbalancing', 'listener/app/web/abc/l1'),
        load_balancer_arn: arn('elasticloadbalancing', 'loadbalancer/app/web/abc'), port: 80, protocol: 'HTTP',
        default_action: [{ type: 'forward', target_group_arn: arn('elasticloadbalancing', 'targetgroup/app/def') }],
      }),
      res('aws_launch_template', 'app', { id: 'lt-0123456789', name: 'app-lt', instance_type: 't3.small', block_device_mappings: [], network_interfaces: [] }),
      res('aws_autoscaling_group', 'app', {
        id: 'app-asg', arn: arn('autoscaling', 'autoScalingGroup:uuid:autoScalingGroupName/app-asg'), name: 'app-asg',
        desired_capacity: 3, min_size: 1, max_size: 5, vpc_zone_identifier: ['subnet-pub-a', 'subnet-pub-b'],
        target_group_arns: [arn('elasticloadbalancing', 'targetgroup/app/def')],
        launch_template: [{ id: 'lt-0123456789', version: '1' }],
      }),
      res('aws_sqs_queue', 'jobs', { id: 'https://sqs.us-east-1.amazonaws.com/111122223333/jobs', arn: arn('sqs', 'jobs'), name: 'jobs', fifo_queue: false, redrive_policy: '' }),
      res('aws_lambda_function', 'worker', {
        id: 'worker-fn', arn: arn('lambda', 'function:worker-fn'), function_name: 'worker-fn', role: arn('iam', 'role/worker-role'), memory_size: 512, architectures: ['arm64'], runtime: 'python3.12',
        environment: [{ variables: { DB_PASSWORD: SECRET } }],
      }),
      res('aws_lambda_event_source_mapping', 'jobs', { id: 'esm-uuid-1234', event_source_arn: arn('sqs', 'jobs'), function_name: arn('lambda', 'function:worker-fn'), batch_size: 10 }),
      res('aws_db_subnet_group', 'main', { id: 'db-subnets', name: 'db-subnets', subnet_ids: ['subnet-prv-a'] }),
      res(
        'aws_db_instance',
        'main',
        {
          id: 'db-ABCDEF', identifier: 'app-db', engine: 'postgres', instance_class: 'db.t3.micro', allocated_storage: 50, storage_type: 'gp3',
          multi_az: false, backup_retention_period: 0, availability_zone: 'us-east-1a', db_subnet_group_name: 'db-subnets', password: SECRET, address: 'app-db.xyz.us-east-1.rds.amazonaws.com',
        },
        { sensitive_attributes: [[{ type: 'get_attr', value: 'password' }]] },
      ),
      res('aws_iam_role', 'worker', {
        id: 'worker-role', arn: arn('iam', 'role/worker-role'), name: 'worker-role',
        assume_role_policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] }),
      }),
      res('aws_iam_role_policy', 'worker', {
        id: 'worker-role:jobs', name: 'read-jobs', role: 'worker-role',
        policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'], Resource: arn('sqs', 'jobs') }] }),
      }),
      res('aws_dynamodb_table', 'sessions', { id: 'sessions', arn: arn('dynamodb', 'table/sessions'), name: 'sessions', billing_mode: 'PAY_PER_REQUEST' }),
      { ...res('random_password', 'db', { result: SECRET }), provider: 'provider["registry.terraform.io/hashicorp/random"]' },
      { ...res('azurerm_resource_group', 'rg', { id: '/subscriptions/x/resourceGroups/rg', name: 'rg', location: 'westeurope' }), provider: 'provider["registry.terraform.io/hashicorp/azurerm"]' },
    ],
  };
}

/**
 * `terraform show -json` of a plan against fixtureState(): adds a NAT gateway (with a new EIP, whose
 * id is unknown until apply) and a bastion host in a new open security group; resizes the app tier;
 * replaces the database to encrypt it; destroys the DynamoDB table.
 */
export function fixturePlan() {
  const state = fixtureState();
  const provider = (r: any) => String(r.provider).match(/"([^"]+)"/)?.[1];
  const prior = state.resources.flatMap((r: any) =>
    r.instances.map((inst: any) => ({
      address: `${r.type}.${r.name}${inst.index_key === undefined ? '' : `[${JSON.stringify(inst.index_key)}]`}`,
      mode: 'managed', type: r.type, name: r.name, ...(inst.index_key === undefined ? {} : { index: inst.index_key }),
      provider_name: provider(r), schema_version: 0,
      values: inst.attributes, sensitive_values: inst.sensitive_attributes?.length ? { password: true } : {}, depends_on: inst.dependencies ?? [],
    })),
  );
  const byAddr = new Map(prior.map((r: any) => [r.address, r]));
  const changed = (address: string, values: Record<string, unknown>) => ({ ...byAddr.get(address), values: { ...byAddr.get(address).values, ...values } });
  const aws = 'registry.terraform.io/hashicorp/aws';
  const created = (type: string, name: string, values: Record<string, unknown>) => ({ address: `${type}.${name}`, mode: 'managed', type, name, provider_name: aws, schema_version: 0, values, sensitive_values: {} });

  const db = changed('aws_db_instance.main', { storage_encrypted: true });
  for (const k of ['id', 'arn', 'address']) delete db.values[k];
  const planned = [
    ...prior.filter((r: any) => !['aws_dynamodb_table.sessions', 'aws_launch_template.app', 'aws_autoscaling_group.app', 'aws_db_instance.main'].includes(r.address)),
    changed('aws_launch_template.app', { instance_type: 't3.medium' }),
    changed('aws_autoscaling_group.app', { desired_capacity: 4 }),
    db,
    created('aws_eip', 'nat', { domain: 'vpc', tags: { Name: 'nat-eip' } }),
    created('aws_nat_gateway', 'main', { connectivity_type: 'public', subnet_id: 'subnet-pub-a', tags: { Name: 'main-nat' } }),
    created('aws_security_group', 'bastion', {
      name: 'bastion-sg', vpc_id: 'vpc-111111', egress: [],
      ingress: [{ protocol: 'tcp', from_port: 22, to_port: 22, cidr_blocks: ['0.0.0.0/0'], security_groups: [] }],
    }),
    created('aws_instance', 'bastion', { ami: 'ami-0abc1234', instance_type: 't3.small', subnet_id: 'subnet-pub-a', tags: { Name: 'bastion' }, root_block_device: [{ volume_size: 8, volume_type: 'gp2' }] }),
  ];
  const unknown: Record<string, Record<string, unknown>> = {
    'aws_eip.nat': { id: true, allocation_id: true, public_ip: true, association_id: true, arn: true },
    'aws_nat_gateway.main': { id: true, allocation_id: true, public_ip: true, network_interface_id: true },
    'aws_security_group.bastion': { id: true, arn: true },
    'aws_instance.bastion': { id: true, arn: true, public_ip: true, associate_public_ip_address: true, vpc_security_group_ids: true },
    'aws_db_instance.main': { id: true, arn: true, address: true },
  };
  const actions: Record<string, string[]> = {
    'aws_eip.nat': ['create'], 'aws_nat_gateway.main': ['create'], 'aws_security_group.bastion': ['create'], 'aws_instance.bastion': ['create'],
    'aws_launch_template.app': ['update'], 'aws_autoscaling_group.app': ['update'], 'aws_db_instance.main': ['delete', 'create'], 'aws_dynamodb_table.sessions': ['delete'],
  };
  const after = new Map(planned.map((r: any) => [r.address, r]));
  const addresses = [...new Set([...prior.map((r: any) => r.address), ...planned.map((r: any) => r.address)])];
  const ref = (...refs: string[]) => ({ references: refs });
  return {
    format_version: '1.2',
    terraform_version: '1.9.5',
    planned_values: { root_module: { resources: planned } },
    resource_changes: addresses.map((address) => {
      const b = byAddr.get(address), a = after.get(address);
      const r = a ?? b;
      return {
        address, mode: r.mode, type: r.type, name: r.name, ...(r.index === undefined ? {} : { index: r.index }), provider_name: r.provider_name,
        change: {
          actions: actions[address] ?? ['no-op'], before: b?.values ?? null, after: a?.values ?? null, after_unknown: unknown[address] ?? {},
          before_sensitive: b?.sensitive_values ?? false, after_sensitive: a?.sensitive_values ?? false,
        },
      };
    }),
    prior_state: { format_version: '1.0', terraform_version: '1.9.5', values: { root_module: { resources: prior } } },
    configuration: {
      provider_config: { aws: { name: 'aws', full_name: aws, expressions: { region: { constant_value: 'us-east-1' } } } },
      root_module: {
        resources: [
          { address: 'aws_eip.nat', mode: 'managed', type: 'aws_eip', name: 'nat', expressions: { domain: { constant_value: 'vpc' } } },
          { address: 'aws_nat_gateway.main', mode: 'managed', type: 'aws_nat_gateway', name: 'main', expressions: { allocation_id: ref('aws_eip.nat.id', 'aws_eip.nat'), subnet_id: ref('aws_subnet.public["a"].id', 'aws_subnet.public["a"]', 'aws_subnet.public') } },
          { address: 'aws_security_group.bastion', mode: 'managed', type: 'aws_security_group', name: 'bastion', expressions: { vpc_id: ref('aws_vpc.main.id', 'aws_vpc.main') } },
          { address: 'aws_instance.bastion', mode: 'managed', type: 'aws_instance', name: 'bastion', expressions: { vpc_security_group_ids: ref('aws_security_group.bastion.id', 'aws_security_group.bastion'), subnet_id: ref('aws_subnet.public["a"].id', 'aws_subnet.public["a"]', 'aws_subnet.public') } },
        ],
      },
    },
  };
}

/**
 * A real `terraform show -json` of a new stack (real-plan/main.tf): VPC, counted subnets, EIP + NAT,
 * an instance in a new security group, launch template + ASG, Lambda reading SQS, and a DLQ in a module.
 * Everything is created, so ids and ARNs are unknown and only the configuration's references connect it.
 */
export function realPlan(): any {
  return JSON.parse(readFileSync(new URL('./real-plan/plan.json', import.meta.url), 'utf8'));
}

const row = (usageType: string, price: number, unit: string, attrs: Record<string, string> = {}, extra: Partial<OfferRow> = {}): OfferRow => ({
  sku: `SKU-${usageType}-${price}`, usageType, operation: '', unit, price, from: 0, to: null, desc: '', attrs, ...extra,
});

/** Offline stand-in for the AWS price list with real us-east-1 prices. */
const OFFERS: Record<string, OfferRow[]> = {
  AmazonEC2: [
    row('BoxUsage:t3.micro', 0.0104, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }),
    row('BoxUsage:t3.small', 0.0208, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }),
    row('BoxUsage:t3.medium', 0.0416, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }),
    row('BoxUsage:t4g.small', 0.0168, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }),
    // 1-year No Upfront reservation of the t3.small on-demand SKU above.
    row('BoxUsage:t3.small', 0.013, 'Hrs', { 'Product Family': 'Compute Instance', 'License Model': 'No License required' }, { sku: 'SKU-BoxUsage:t3.small-0.0208', term: 'reserved' }),
    row('EBS:VolumeUsage.gp3', 0.08, 'GB-Mo'),
    row('EBS:VolumeUsage.gp2', 0.1, 'GB-Mo'),
    row('NatGateway-Hours', 0.045, 'Hrs'),
    row('NatGateway-Bytes', 0.045, 'GB'),
  ],
  AmazonVPC: [row('USE1-PublicIPv4:InUseAddress', 0.005, 'Hrs'), row('USE1-PublicIPv4:IdleAddress', 0.005, 'Hrs')],
  AWSELB: [row('LoadBalancerUsage', 0.0225, 'Hrs', {}, { operation: 'LoadBalancing:Application' }), row('LCUUsage', 0.008, 'LCU-Hrs', {}, { operation: 'LoadBalancing:Application' })],
  AWSQueueService: [row('Requests-RBP', 0.0000004, 'Requests')],
  AWSLambda: [row('Request-ARM', 0.0000002, 'Requests'), row('Lambda-GB-Second-ARM', 0.0000133334, 'Lambda-GB-Second')],
  AmazonRDS: [
    row('InstanceUsage:db.t3.micro', 0.018, 'Hrs', { 'Product Family': 'Database Instance', 'Instance Type': 'db.t3.micro', 'Database Engine': 'PostgreSQL', 'Deployment Option': 'Single-AZ', 'License Model': 'No license required' }),
    row('InstanceUsage:db.t4g.micro', 0.016, 'Hrs', { 'Product Family': 'Database Instance', 'Instance Type': 'db.t4g.micro', 'Database Engine': 'PostgreSQL', 'Deployment Option': 'Single-AZ', 'License Model': 'No license required' }),
    row('RDS:GP3-Storage', 0.115, 'GB-Mo', { 'Product Family': 'Database Storage', 'Database Engine': 'PostgreSQL' }),
    row('RDS:ChargedBackupUsage', 0.095, 'GB-Mo', { 'Database Engine': 'Any' }),
  ],
  AmazonDynamoDB: [row('ReadRequestUnits', 0.000000125, 'ReadRequestUnits'), row('WriteRequestUnits', 0.000000625, 'WriteRequestUnits'), row('TimedStorage-ByteHrs', 0.25, 'GB-Mo')],
};

export const fakeOffers = {
  load: async (service: string, region: string) => new OfferSet({ service, region, rows: OFFERS[service] ?? [], fetchedAt: 'now' }),
} as unknown as AwsOffers;
