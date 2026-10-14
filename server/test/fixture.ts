// A small but realistic state: VPC with public/private subnets, ALB → ASG, SQS → Lambda, RDS with a sensitive password.

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
