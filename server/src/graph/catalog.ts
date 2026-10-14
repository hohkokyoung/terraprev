// What we know about each resource type, for drawing it.
// Unknown types still render via `fallbackInfo`; this table only makes them nicer.

import type { Category, TfResource } from '../../../shared/types.ts';

export interface Link {
  /** Identifier(s) of the source (ARN, id, name, or a string containing one). */
  from: unknown;
  to: unknown;
  kind?: 'flow' | 'uses';
  label?: string;
}

export interface TypeInfo {
  category: Category;
  /** Short service tag drawn on the node. */
  short: string;
  supporting?: boolean;
  /** Identifier of the resource this one is folded into (e.g. listener → load balancer). */
  absorbInto?: (a: Record<string, any>) => unknown;
  /** This resource only describes a relationship between two others. */
  links?: (a: Record<string, any>) => Link[];
  /** Attributes whose references point *into* this resource (e.g. ASG target groups → ALB sends to ASG). */
  inboundRefs?: string[];
  /**
   * This resource stores data *about* what it references (a secret holding DB credentials).
   * Draw the dependency the other way: the database uses its secret, not the reverse.
   */
  describes?: boolean;
  details?: (a: Record<string, any>) => [string, unknown][];
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const first = (v: unknown): any => arr(v)[0] ?? {};

const T: Record<string, TypeInfo> = {
  // ── compute ──
  aws_instance: { category: 'compute', short: 'EC2', details: (a) => [['type', a.instance_type], ['ami', a.ami], ['az', a.availability_zone]] },
  aws_autoscaling_group: {
    category: 'compute',
    short: 'ASG',
    inboundRefs: ['target_group_arns'],
    details: (a) => [['desired', a.desired_capacity], ['min / max', `${a.min_size} / ${a.max_size}`], ['health check', a.health_check_type]],
  },
  aws_launch_template: { category: 'compute', short: 'LT', absorbInto: (a) => a.__asg },
  aws_lambda_function: {
    category: 'compute',
    short: 'λ',
    details: (a) => [['runtime', a.runtime], ['memory', a.memory_size && `${a.memory_size} MB`], ['arch', arr(a.architectures).join(', ')], ['timeout', a.timeout && `${a.timeout}s`]],
  },
  aws_lambda_permission: { category: 'compute', short: 'λ', supporting: true, links: (a) => [{ from: a.source_arn, to: a.function_name, kind: 'flow' }] },
  aws_lambda_event_source_mapping: {
    category: 'integration',
    short: 'ESM',
    supporting: true,
    links: (a) => [{ from: a.event_source_arn, to: a.function_name, kind: 'flow', label: `poll ×${a.batch_size ?? ''}`.replace(/ ×$/, '') }],
  },
  aws_ecs_service: { category: 'compute', short: 'ECS', details: (a) => [['desired', a.desired_count], ['launch', a.launch_type]] },
  aws_ecs_cluster: { category: 'compute', short: 'ECS' },
  aws_ecs_task_definition: { category: 'compute', short: 'Task', supporting: true },
  aws_eks_cluster: { category: 'compute', short: 'EKS', details: (a) => [['version', a.version]] },

  // ── network ──
  aws_vpc: { category: 'network', short: 'VPC' },
  aws_subnet: { category: 'network', short: 'Subnet' },
  aws_internet_gateway: { category: 'network', short: 'IGW' },
  aws_nat_gateway: { category: 'network', short: 'NAT', details: (a) => [['public ip', a.public_ip], ['type', a.connectivity_type]] },
  aws_eip: { category: 'network', short: 'EIP', absorbInto: (a) => a.__nat, details: (a) => [['public ip', a.public_ip]] },
  aws_route_table: { category: 'network', short: 'RT', supporting: true },
  aws_route_table_association: { category: 'network', short: 'RT', supporting: true, absorbInto: (a) => a.route_table_id },
  aws_route: { category: 'network', short: 'RT', supporting: true, absorbInto: (a) => a.route_table_id },
  aws_network_acl: { category: 'security', short: 'NACL', supporting: true },
  aws_vpc_endpoint: { category: 'network', short: 'VPCE', details: (a) => [['service', a.service_name], ['type', a.vpc_endpoint_type]] },
  aws_lb: {
    category: 'network',
    short: 'ALB',
    details: (a) => [['type', a.load_balancer_type], ['scheme', a.internal ? 'internal' : 'internet-facing'], ['dns', a.dns_name]],
  },
  aws_lb_listener: {
    category: 'network',
    short: 'Listener',
    absorbInto: (a) => a.load_balancer_arn,
    details: (a) => [[`listener :${a.port}`, a.protocol]],
  },
  aws_lb_listener_rule: { category: 'network', short: 'Rule', absorbInto: (a) => a.listener_arn },
  aws_lb_target_group: {
    category: 'network',
    short: 'TG',
    absorbInto: (a) => a.__lb,
    details: (a) => [[`target group ${a.name}`, `${a.target_type}${a.port ? ':' + a.port : ''}`]],
  },
  aws_lb_target_group_attachment: {
    category: 'network',
    short: 'TG',
    supporting: true,
    links: (a) => [{ from: a.target_group_arn, to: a.target_id, kind: 'flow', label: 'forward' }],
  },
  aws_route53_zone: { category: 'network', short: 'R53' },
  aws_route53_record: { category: 'network', short: 'R53', absorbInto: (a) => a.zone_id },
  aws_cloudfront_distribution: { category: 'network', short: 'CF' },

  // ── api ──
  aws_apigatewayv2_api: { category: 'api', short: 'API GW', details: (a) => [['protocol', a.protocol_type], ['endpoint', a.api_endpoint]] },
  aws_apigatewayv2_stage: { category: 'api', short: 'Stage', absorbInto: (a) => a.api_id, details: (a) => [['stage', a.name]] },
  aws_apigatewayv2_route: { category: 'api', short: 'Route', absorbInto: (a) => a.api_id, details: (a) => [['route', a.route_key]] },
  aws_apigatewayv2_deployment: { category: 'api', short: 'Deploy', absorbInto: (a) => a.api_id },
  aws_apigatewayv2_integration: {
    category: 'api',
    short: 'Integ',
    absorbInto: (a) => a.api_id,
    links: (a) => [{ from: a.api_id, to: a.integration_uri, kind: 'flow', label: a.integration_type?.toLowerCase().replace('_', ' ') }],
  },
  aws_apigatewayv2_authorizer: {
    category: 'api',
    short: 'Auth',
    absorbInto: (a) => a.api_id,
    links: (a) => [{ from: a.api_id, to: first(a.jwt_configuration).issuer ?? a.authorizer_uri, kind: 'uses', label: (a.authorizer_type ?? '').toLowerCase() }],
  },
  aws_api_gateway_rest_api: { category: 'api', short: 'API GW' },

  // ── security / identity ──
  aws_security_group: { category: 'security', short: 'SG', supporting: true },
  aws_security_group_rule: { category: 'security', short: 'SG', supporting: true, absorbInto: (a) => a.security_group_id },
  aws_vpc_security_group_ingress_rule: { category: 'security', short: 'SG', supporting: true, absorbInto: (a) => a.security_group_id },
  aws_vpc_security_group_egress_rule: { category: 'security', short: 'SG', supporting: true, absorbInto: (a) => a.security_group_id },
  aws_cognito_user_pool: { category: 'security', short: 'Cognito', details: (a) => [['tier', a.user_pool_tier]] },
  aws_cognito_user_pool_client: { category: 'security', short: 'Cognito', absorbInto: (a) => a.user_pool_id, details: (a) => [['client', a.name]] },
  aws_cognito_resource_server: { category: 'security', short: 'Cognito', absorbInto: (a) => a.user_pool_id },
  aws_cognito_user_pool_domain: { category: 'security', short: 'Cognito', absorbInto: (a) => a.user_pool_id },
  aws_acm_certificate: { category: 'security', short: 'ACM', details: (a) => [['domain', a.domain_name], ['status', a.status]] },
  aws_secretsmanager_secret: { category: 'security', short: 'Secrets', describes: true },
  aws_secretsmanager_secret_version: { category: 'security', short: 'Secrets', describes: true, absorbInto: (a) => a.secret_id },
  aws_kms_key: { category: 'security', short: 'KMS' },
  aws_ssm_parameter: { category: 'security', short: 'SSM', describes: true },
  aws_kms_alias: { category: 'security', short: 'KMS', absorbInto: (a) => a.target_key_id },
  aws_wafv2_web_acl: { category: 'security', short: 'WAF' },

  // ── data ──
  aws_db_instance: {
    category: 'database',
    short: 'RDS',
    details: (a) => [['engine', `${a.engine} ${a.engine_version ?? ''}`.trim()], ['class', a.instance_class], ['storage', `${a.allocated_storage} GB ${a.storage_type ?? ''}`], ['multi-AZ', a.multi_az ? 'yes' : 'no']],
  },
  aws_db_subnet_group: { category: 'database', short: 'RDS', supporting: true },
  aws_db_parameter_group: { category: 'database', short: 'RDS', supporting: true },
  aws_rds_cluster: { category: 'database', short: 'Aurora', details: (a) => [['engine', a.engine]] },
  aws_rds_cluster_instance: { category: 'database', short: 'Aurora', absorbInto: (a) => a.cluster_identifier, details: (a) => [['instance', a.instance_class]] },
  aws_dynamodb_table: { category: 'database', short: 'DynamoDB', details: (a) => [['billing', a.billing_mode], ['hash key', a.hash_key]] },
  aws_elasticache_cluster: { category: 'database', short: 'Cache', details: (a) => [['engine', a.engine], ['node', a.node_type]] },
  aws_s3_bucket: { category: 'storage', short: 'S3' },
  aws_efs_file_system: { category: 'storage', short: 'EFS' },
  aws_ebs_volume: { category: 'storage', short: 'EBS', details: (a) => [['size', `${a.size} GB ${a.type}`]] },

  // ── integration ──
  aws_sqs_queue: {
    category: 'integration',
    short: 'SQS',
    details: (a) => [['type', a.fifo_queue ? 'FIFO' : 'standard'], ['visibility', `${a.visibility_timeout_seconds}s`]],
    links: (a) => {
      try {
        const p = a.redrive_policy ? JSON.parse(a.redrive_policy) : null;
        return p?.deadLetterTargetArn ? [{ from: a.arn, to: p.deadLetterTargetArn, kind: 'flow', label: `DLQ after ${p.maxReceiveCount}` }] : [];
      } catch {
        return [];
      }
    },
  },
  aws_sqs_queue_policy: { category: 'integration', short: 'SQS', absorbInto: (a) => a.queue_url },
  aws_sns_topic: { category: 'integration', short: 'SNS' },
  aws_sns_topic_subscription: {
    category: 'integration',
    short: 'SNS',
    supporting: true,
    links: (a) => [{ from: a.topic_arn, to: a.endpoint, kind: 'flow', label: a.protocol }],
  },
  aws_cloudwatch_event_rule: { category: 'integration', short: 'EventBridge' },
  aws_cloudwatch_event_target: { category: 'integration', short: 'EventBridge', supporting: true, links: (a) => [{ from: a.rule, to: a.arn, kind: 'flow' }] },
  aws_sfn_state_machine: { category: 'integration', short: 'Step Fn' },

  // ── monitoring ──
  aws_cloudwatch_log_group: { category: 'monitoring', short: 'Logs', details: (a) => [['retention', a.retention_in_days ? `${a.retention_in_days} days` : 'never expires']] },
  aws_cloudwatch_metric_alarm: { category: 'monitoring', short: 'Alarm' },
};

// S3 sub-resources all fold into their bucket.
const S3_CHILD = /^aws_s3_bucket_/;
const IAM = /^aws_iam_/;

export function typeInfo(r: TfResource): TypeInfo {
  if (T[r.type]) return T[r.type];
  if (r.type === 'aws_s3_bucket_notification') {
    return {
      category: 'storage',
      short: 'S3',
      absorbInto: (a) => a.bucket,
      links: (a) => [
        ...arr(a.lambda_function).map((x) => ({ from: a.bucket, to: x.lambda_function_arn, kind: 'flow' as const, label: arr(x.events).join(' ') })),
        ...arr(a.queue).map((x) => ({ from: a.bucket, to: x.queue_arn, kind: 'flow' as const, label: arr(x.events).join(' ') })),
        ...arr(a.topic).map((x) => ({ from: a.bucket, to: x.topic_arn, kind: 'flow' as const, label: arr(x.events).join(' ') })),
      ],
    };
  }
  if (S3_CHILD.test(r.type)) return { category: 'storage', short: 'S3', absorbInto: (a) => a.bucket };
  if (IAM.test(r.type)) return { category: 'security', short: 'IAM', supporting: true };
  return fallbackInfo(r);
}

function fallbackInfo(r: TfResource): TypeInfo {
  const t = r.type;
  const category: Category =
    /instance|function|cluster|container|compute|vm|virtual_machine|app_service|ecs|eks|batch/.test(t) ? 'compute'
    : /db|database|sql|dynamo|redis|cache|cosmos|spanner|firestore/.test(t) ? 'database'
    : /bucket|storage|volume|disk|efs|fsx|blob/.test(t) ? 'storage'
    : /queue|topic|sns|sqs|event|bus|pubsub|stream|kinesis/.test(t) ? 'integration'
    : /api|gateway_rest/.test(t) ? 'api'
    : /iam|role|policy|security|firewall|kms|key|secret|cert|identity/.test(t) ? 'security'
    : /log|alarm|metric|monitor|dashboard/.test(t) ? 'monitoring'
    : /vpc|subnet|network|route|lb|load_balancer|dns|ip|nat|gateway/.test(t) ? 'network'
    : 'other';
  const short = t.replace(/^[a-z0-9]+_/, '').split('_').slice(0, 2).map((w) => w.toUpperCase()).join(' ');
  return { category, short };
}

/** Values that identify a resource, used to resolve references from other resources. */
export const IDENTIFIER_KEYS = ['arn', 'id', 'name', 'function_name', 'bucket', 'dns_name', 'invoke_arn', 'url', 'qualified_arn', 'endpoint', 'address', 'api_endpoint'];

/** Providers that never create cloud infrastructure; excluded from the diagram. */
export const UTILITY_PROVIDERS = new Set(['random', 'archive', 'null', 'time', 'tls', 'local', 'external', 'template', 'http', 'cloudinit', 'terraform']);

export function displayName(r: TfResource): string {
  const a = r.attrs;
  const named = a.tags?.Name ?? a.function_name ?? a.bucket ?? a.identifier ?? a.name;
  if (typeof named === 'string' && named) return named;
  return r.indexKey !== undefined ? `${r.name}[${r.indexKey}]` : r.name;
}
