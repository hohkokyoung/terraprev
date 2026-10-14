import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBase } from '../src/snapshot.ts';
import { fixtureState, SECRET } from './fixture.ts';

const parts = () => buildBase('/tmp/x.tfstate', fixtureState(), 'eu-west-1');

test('parses addresses with index keys and providers', () => {
  const { state } = parts();
  const addrs = state.resources.map((r) => r.address);
  assert.ok(addrs.includes('aws_subnet.public["a"]'));
  assert.equal(state.resources.find((r) => r.type === 'random_password')?.provider, 'random');
});

test('detects region from ARNs, not the default', () => {
  assert.equal(parts().region, 'us-east-1');
});

test('places resources in VPC / subnet containers', () => {
  const nodes = new Map(parts().base.graph.nodes.map((n) => [n.id, n]));
  assert.equal(nodes.get('aws_subnet.public["a"]')?.parentId, 'aws_vpc.main');
  assert.equal(nodes.get('aws_db_instance.main')?.parentId, 'aws_subnet.private', 'RDS sits in the subnet matching its AZ');
  assert.equal(nodes.get('aws_lb.main')?.parentId, 'aws_vpc.main', 'multi-subnet ALB spans the VPC');
  assert.equal(nodes.get('aws_sqs_queue.jobs')?.parentId, 'provider:aws', 'regional services live outside the VPC');
  assert.match(nodes.get('aws_subnet.public["a"]')!.sublabel!, /^public/);
  assert.match(nodes.get('aws_subnet.private')!.sublabel!, /^private/);
});

test('folds listeners, target groups and launch templates into their parents', () => {
  const { base, nodeOf } = parts();
  const ids = new Set(base.graph.nodes.map((n) => n.id));
  assert.ok(!ids.has('aws_lb_listener.http'));
  assert.equal(nodeOf.get('aws_lb_listener.http'), 'aws_lb.main');
  assert.equal(nodeOf.get('aws_lb_target_group.app'), 'aws_lb.main');
  assert.equal(nodeOf.get('aws_launch_template.app'), 'aws_autoscaling_group.app');
});

test('draws one node per ASG instance, spread across subnets', () => {
  const instances = parts().base.graph.nodes.filter((n) => n.virtual && n.type === 'aws_instance');
  assert.equal(instances.length, 3);
  assert.deepEqual(instances.map((n) => n.parentId), ['aws_subnet.public["a"]', 'aws_subnet.public["b"]', 'aws_subnet.public["a"]']);
});

test('derives traffic edges from relationships', () => {
  const edges = parts().base.graph.edges;
  const has = (s: string, t: string, kind: string) => edges.some((e) => e.source === s && e.target === t && e.kind === kind);
  assert.ok(has('aws_lb.main', 'aws_autoscaling_group.app', 'flow'), 'ALB → ASG via target_group_arns');
  assert.ok(has('aws_sqs_queue.jobs', 'aws_lambda_function.worker', 'flow'), 'SQS → Lambda via event source mapping');
  assert.ok(has('internet', 'aws_lb.main', 'flow'), 'internet-facing ALB gets an entry edge');
});

test('hides utility providers and marks IAM as supporting', () => {
  const nodes = parts().base.graph.nodes;
  assert.ok(!nodes.some((n) => n.type === 'random_password'));
  assert.ok(nodes.find((n) => n.id === 'aws_iam_role.worker')?.supporting);
});

test('never sends sensitive values to the browser', () => {
  const json = JSON.stringify(parts().base);
  assert.ok(!json.includes(SECRET), 'secret leaked into snapshot');
});

test('summarises IAM role, policies and security groups per resource', () => {
  const nodes = new Map(parts().base.graph.nodes.map((n) => [n.id, n]));
  const fn = nodes.get('aws_lambda_function.worker')!.access!;
  assert.equal(fn.roles[0].name, 'worker-role');
  assert.deepEqual(fn.roles[0].trustedBy, ['lambda.amazonaws.com']);
  assert.deepEqual(fn.roles[0].policies[0].statements[0], { effect: 'Allow', actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'], resources: ['jobs'] });
  assert.ok(fn.nodeIds.includes('aws_iam_role_policy.worker'), 'expanding reveals the policy node');
  const alb = nodes.get('aws_lb.main')!.access!;
  assert.deepEqual(alb.securityGroups[0].ingress, ['tcp 443 from anywhere']);
  assert.deepEqual(alb.securityGroups[0].egress, ['all outbound']);
});
