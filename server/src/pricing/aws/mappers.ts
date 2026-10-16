// Terraform resource → AWS Price List SKUs.
// Each mapper declares which offer files it needs, then adds cost components.
// Fixed components are always-on charges (hours × 730); usage components are
// driven by slider values the user sets in the UI.

import { HOURS_PER_MONTH } from '../../../../shared/cost.ts';
import type { TfResource } from '../../../../shared/types.ts';
import type { Query } from './offers.ts';

export interface MapperApi {
  r: TfResource;
  a: Record<string, any>;
  /** Other resources by type, filtered. */
  find(type: string, pred: (r: TfResource) => boolean): TfResource | undefined;
  /** Monthly always-on charge. */
  fixed(service: string, name: string, q: Query, monthlyQty: number, note?: string): void;
  /** Charge scaled by slider values: qty = base × Π usage[key]. */
  usage(service: string, name: string, q: Query, base: number, keys: string[], note?: string): void;
  /** Declare a slider; returns its key. */
  param(id: string, label: string, unit: string, def: number, max: number, scale?: 'log' | 'linear'): string;
  unpriced(reason: string): void;
}

export interface Mapper {
  services: (r: TfResource) => string[];
  price: (m: MapperApi) => void;
}

const H = HOURS_PER_MONTH;

const EC2_INSTANCE = (type: string): Query => ({
  usageType: `BoxUsage:${type}`,
  attrs: { 'Product Family': ['Compute Instance', 'Compute Instance (bare metal)'], 'License Model': ['No License required', ''] },
});
const EBS = (volType: string): Query => ({ usageType: `EBS:VolumeUsage.${volType === 'standard' ? '' : volType}`.replace(/\.$/, '') });
const PUBLIC_IPV4: Query = { usageType: 'PublicIPv4:InUseAddress' };

/** Root disk from a launch template's block_device_mappings, or AWS's common default. */
function rootVolume(blockDevices: any[]): { size: number; type: string; assumed: boolean } {
  const ebs = blockDevices?.[0]?.ebs?.[0] ?? blockDevices?.[0];
  if (ebs?.volume_size) return { size: Number(ebs.volume_size), type: ebs.volume_type || 'gp3', assumed: false };
  return { size: 8, type: 'gp3', assumed: true };
}

export const MAPPERS: Record<string, Mapper> = {
  aws_instance: {
    services: () => ['AmazonEC2', 'AmazonVPC'],
    price(m) {
      const { a } = m;
      m.fixed('AmazonEC2', `Instance (${a.instance_type}, Linux, on-demand)`, EC2_INSTANCE(a.instance_type), H, 'Priced as Linux; Windows/RHEL AMIs cost more.');
      const root = rootVolume(a.root_block_device ?? []);
      m.fixed('AmazonEC2', `Root volume (${root.size} GB ${root.type})`, EBS(root.type), root.size);
      if (a.associate_public_ip_address || a.public_ip) m.fixed('AmazonVPC', 'Public IPv4 address', PUBLIC_IPV4, H);
      // Not yet known (a plan): the subnet decides at launch.
      else if (a.associate_public_ip_address == null && m.find('aws_subnet', (s) => s.attrs.id === a.subnet_id)?.attrs.map_public_ip_on_launch === true) {
        m.fixed('AmazonVPC', 'Public IPv4 address', PUBLIC_IPV4, H, 'Its subnet gives instances a public IPv4 at launch, billed hourly since Feb 2024.');
      }
    },
  },

  aws_autoscaling_group: {
    services: () => ['AmazonEC2', 'AmazonVPC'],
    price(m) {
      const { a } = m;
      const ltId = a.launch_template?.[0]?.id ?? a.mixed_instances_policy?.[0]?.launch_template?.[0]?.launch_template_specification?.[0]?.launch_template_id;
      const lt = m.find('aws_launch_template', (r) => r.attrs.id === ltId);
      const type = lt?.attrs.instance_type;
      const count = Number(a.desired_capacity ?? a.min_size ?? 0);
      if (!type) return m.unpriced('Instance type not found (launch template missing or uses mixed instances)');
      m.fixed('AmazonEC2', `${count} × instance (${type}, Linux, on-demand)`, EC2_INSTANCE(type), H * count, 'Uses desired capacity. Scaling events change this.');
      const root = rootVolume(lt?.attrs.block_device_mappings ?? []);
      m.fixed('AmazonEC2', `${count} × root volume (${root.size} GB ${root.type})`, EBS(root.type), root.size * count, root.assumed ? 'Root volume size not set in launch template; assumed AMI default of 8 GB gp3.' : undefined);
      const subnets = (a.vpc_zone_identifier ?? []).map((id: string) => m.find('aws_subnet', (s) => s.attrs.id === id));
      const ltPublic = lt?.attrs.network_interfaces?.[0]?.associate_public_ip_address;
      const publicIp = ltPublic !== undefined && ltPublic !== '' ? String(ltPublic) === 'true' : subnets.some((s: TfResource | undefined) => s?.attrs.map_public_ip_on_launch);
      if (publicIp) m.fixed('AmazonVPC', `${count} × public IPv4 address`, PUBLIC_IPV4, H * count, 'Instances in public subnets get a public IPv4, billed hourly since Feb 2024.');
    },
  },

  aws_ebs_volume: {
    services: () => ['AmazonEC2'],
    price(m) {
      m.fixed('AmazonEC2', `Volume (${m.a.size} GB ${m.a.type})`, EBS(m.a.type || 'gp3'), Number(m.a.size));
    },
  },

  aws_nat_gateway: {
    services: () => ['AmazonEC2'],
    price(m) {
      m.fixed('AmazonEC2', 'NAT gateway hours', { usageType: 'NatGateway-Hours' }, H);
      const gb = m.param('data', 'Data processed', 'GB / month', 10, 100_000);
      m.usage('AmazonEC2', 'Data processed', { usageType: 'NatGateway-Bytes' }, 1, [gb], 'Every GB leaving private subnets through the NAT is charged, on top of internet data transfer.');
    },
  },

  aws_eip: {
    services: () => ['AmazonVPC'],
    price(m) {
      const attached = m.a.association_id || m.a.instance || m.a.network_interface || m.find('aws_nat_gateway', (n) => n.attrs.allocation_id === m.a.id);
      m.fixed('AmazonVPC', `Public IPv4 address (${attached ? 'in use' : 'idle'})`, { usageType: attached ? 'PublicIPv4:InUseAddress' : 'PublicIPv4:IdleAddress' }, H);
    },
  },

  aws_lb: {
    services: () => ['AWSELB', 'AmazonVPC'],
    price(m) {
      const kind = ({ application: 'Application', network: 'Network', gateway: 'Gateway' } as const)[m.a.load_balancer_type as string] ?? 'Application';
      const op = `LoadBalancing:${kind}`;
      m.fixed('AWSELB', `${kind} load balancer hours`, { usageType: 'LoadBalancerUsage', operation: op }, H);
      const lcu = m.param('lcu', kind === 'Network' ? 'Average NLCUs' : 'Average LCUs', 'capacity units', 1, 100, 'linear');
      m.usage('AWSELB', 'Capacity units', { usageType: kind === 'Gateway' ? 'GLCUUsage' : 'LCUUsage', operation: op }, H, [lcu], 'An LCU covers ~25 new conn/s, 3,000 active conn, 1 GB/h processed, or 1,000 rule evals/s, whichever is highest.');
      const azs = (m.a.subnets ?? []).length || (m.a.subnet_mapping ?? []).length;
      if (!m.a.internal && azs && kind !== 'Gateway') {
        m.fixed('AmazonVPC', `${azs} × public IPv4 address (one per AZ)`, PUBLIC_IPV4, H * azs);
      }
    },
  },

  aws_vpc_endpoint: {
    services: () => ['AmazonVPC'],
    price(m) {
      if (m.a.vpc_endpoint_type === 'Gateway') return; // S3/DynamoDB gateway endpoints are free
      const azs = Math.max(1, (m.a.subnet_ids ?? []).length);
      m.fixed('AmazonVPC', `Interface endpoint hours (${azs} AZ)`, { usageType: 'VpcEndpoint-Hours' }, H * azs);
      const gb = m.param('data', 'Data processed', 'GB / month', 10, 100_000);
      m.usage('AmazonVPC', 'Data processed', { usageType: 'VpcEndpoint-Bytes' }, 1, [gb]);
    },
  },

  aws_db_instance: {
    services: () => ['AmazonRDS'],
    price(m) {
      const { a } = m;
      const engine = RDS_ENGINES[String(a.engine)];
      if (!engine) return m.unpriced(`RDS engine "${a.engine}" not mapped yet (licensed engines need a license model)`);
      const deploy = a.multi_az ? 'Multi-AZ' : 'Single-AZ';
      m.fixed('AmazonRDS', `DB instance (${a.instance_class}, ${engine}, ${deploy})`, {
        attrs: { 'Product Family': 'Database Instance', 'Instance Type': a.instance_class, 'Database Engine': engine, 'Deployment Option': deploy, 'License Model': ['No license required', 'License included', ''] },
      }, H);
      const st = String(a.storage_type || 'gp2');
      const base = ({ gp2: 'GP2-Storage', gp3: 'GP3-Storage', io1: 'PIOPS-Storage', io2: 'PIOPS-Storage-IO2', standard: 'StorageUsage' } as Record<string, string>)[st];
      if (base) {
        m.fixed('AmazonRDS', `Storage (${a.allocated_storage} GB ${st})`, {
          usageType: `RDS:${a.multi_az ? 'Multi-AZ-' : ''}${base}`,
          attrs: { 'Product Family': 'Database Storage', 'Database Engine': [engine, 'Any'] },
        }, Number(a.allocated_storage), st.startsWith('io') ? 'Provisioned IOPS are billed separately (not included).' : undefined);
      }
      const backup = m.param('backup', 'Backup storage beyond DB size', 'GB / month', 0, 10_000);
      m.usage('AmazonRDS', 'Backup storage', { usageType: 'RDS:ChargedBackupUsage', attrs: { 'Database Engine': [engine, 'Any'] } }, 1, [backup], 'Backups up to 100% of provisioned storage are free.');
    },
  },

  aws_lambda_function: {
    services: () => ['AWSLambda'],
    price(m) {
      const arm = (m.a.architectures ?? []).includes('arm64') ? '-ARM' : '';
      const memGb = Number(m.a.memory_size ?? 128) / 1024;
      const inv = m.param('invocations', 'Invocations', 'requests / month', 100_000, 1e10);
      const dur = m.param('duration', 'Average duration', 'ms', 100, 900_000);
      m.usage('AWSLambda', 'Requests', { usageType: `Request${arm}`, free: 'Global-Request' }, 1, [inv]);
      m.usage('AWSLambda', `Compute (${m.a.memory_size} MB${arm ? ', arm64' : ''})`, { usageType: `Lambda-GB-Second${arm}`, free: 'Global-Lambda-GB-Second' }, memGb / 1000, [inv, dur], 'GB-seconds = invocations × duration × memory.');
    },
  },

  aws_apigatewayv2_api: {
    services: () => ['AmazonApiGateway'],
    price(m) {
      if (m.a.protocol_type === 'WEBSOCKET') {
        const msg = m.param('messages', 'Messages', 'messages / month', 1_000_000, 1e10);
        const min = m.param('minutes', 'Connection minutes', 'minutes / month', 100_000, 1e10);
        m.usage('AmazonApiGateway', 'WebSocket messages', { usageType: 'ApiGatewayMessage' }, 1, [msg]);
        m.usage('AmazonApiGateway', 'Connection minutes', { usageType: 'ApiGatewayMinute' }, 1, [min]);
        return;
      }
      const req = m.param('requests', 'Requests', 'requests / month', 1_000_000, 1e10);
      m.usage('AmazonApiGateway', 'HTTP API requests', { usageType: 'ApiGatewayHttpRequest' }, 1, [req], 'Billed per 512 KB chunk.');
    },
  },

  aws_api_gateway_rest_api: {
    services: () => ['AmazonApiGateway'],
    price(m) {
      const req = m.param('requests', 'Requests', 'requests / month', 1_000_000, 1e10);
      m.usage('AmazonApiGateway', 'REST API requests', { usageType: 'ApiGatewayRequest' }, 1, [req]);
    },
  },

  aws_sqs_queue: {
    services: () => ['AWSQueueService'],
    price(m) {
      const req = m.param('requests', 'API requests', 'requests / month', 1_000_000, 1e11);
      m.usage('AWSQueueService', `${m.a.fifo_queue ? 'FIFO' : 'Standard'} requests`, { usageType: m.a.fifo_queue ? 'Requests-FIFO-RBP' : 'Requests-RBP', free: 'Global-Requests' }, 1, [req], 'Send, receive and delete each count; every 64 KB chunk is one request.');
    },
  },

  aws_sns_topic: {
    services: () => ['AmazonSNS'],
    price(m) {
      const pub = m.param('publishes', 'Publishes', 'requests / month', 1_000_000, 1e10);
      m.usage('AmazonSNS', 'Publish requests', { usageType: 'Requests-Tier1' }, 1, [pub], 'Deliveries to SQS and Lambda are free; HTTP/email/SMS deliveries are not included.');
    },
  },

  aws_s3_bucket: {
    services: () => ['AmazonS3'],
    price(m) {
      const gb = m.param('storage', 'Storage (Standard)', 'GB', 10, 1_000_000);
      const put = m.param('put', 'PUT / COPY / POST / LIST', 'requests / month', 10_000, 1e10);
      const get = m.param('get', 'GET / other', 'requests / month', 100_000, 1e10);
      m.usage('AmazonS3', 'Standard storage', { usageType: 'TimedStorage-ByteHrs' }, 1, [gb]);
      m.usage('AmazonS3', 'PUT/COPY/POST/LIST requests', { usageType: 'Requests-Tier1' }, 1, [put]);
      m.usage('AmazonS3', 'GET and other requests', { usageType: 'Requests-Tier2' }, 1, [get]);
    },
  },

  aws_dynamodb_table: {
    services: () => ['AmazonDynamoDB'],
    price(m) {
      const { a } = m;
      const ia = a.table_class === 'STANDARD_INFREQUENT_ACCESS' ? 'IA-' : '';
      if (a.billing_mode === 'PROVISIONED') {
        m.fixed('AmazonDynamoDB', `Provisioned reads (${a.read_capacity} RCU)`, { usageType: `${ia}ReadCapacityUnit-Hrs` }, H * Number(a.read_capacity ?? 0));
        m.fixed('AmazonDynamoDB', `Provisioned writes (${a.write_capacity} WCU)`, { usageType: `${ia}WriteCapacityUnit-Hrs` }, H * Number(a.write_capacity ?? 0));
      } else {
        const r = m.param('reads', 'Read request units', 'RRU / month', 1_000_000, 1e11);
        const w = m.param('writes', 'Write request units', 'WRU / month', 1_000_000, 1e11);
        m.usage('AmazonDynamoDB', 'On-demand reads', { usageType: `${ia}ReadRequestUnits` }, 1, [r]);
        m.usage('AmazonDynamoDB', 'On-demand writes', { usageType: `${ia}WriteRequestUnits` }, 1, [w]);
      }
      const gb = m.param('storage', 'Table storage', 'GB', 1, 100_000);
      m.usage('AmazonDynamoDB', 'Storage', { usageType: `${ia}TimedStorage-ByteHrs` }, 1, [gb]);
    },
  },

  aws_secretsmanager_secret: {
    services: () => ['AWSSecretsManager'],
    price(m) {
      m.fixed('AWSSecretsManager', 'Secret', { usageType: 'AWSSecretsManager-Secrets' }, 1);
      const calls = m.param('calls', 'API calls', 'requests / month', 10_000, 1e9);
      m.usage('AWSSecretsManager', 'API calls', { usageType: 'AWSSecretsManagerAPIRequest' }, 1, [calls]);
    },
  },

  aws_cloudwatch_log_group: {
    services: () => ['AmazonCloudWatch'],
    price(m) {
      const days = Number(m.a.retention_in_days) || 365;
      const gb = m.param('ingest', 'Log ingestion', 'GB / month', 1, 100_000);
      m.usage('AmazonCloudWatch', 'Ingestion (Standard class)', { usageType: 'DataProcessing-Bytes', operation: 'PutLogEvents', free: 'Global-DataProcessing-Bytes' }, 1, [gb]);
      m.usage('AmazonCloudWatch', `Archive storage (~${Math.min(days, 365)} days kept)`, { usageType: 'TimedStorage-ByteHrs', free: 'Global-TimedStorage-ByteHrs' }, Math.min(days, 365) / 30, [gb],
        `Steady-state estimate: ingested GB × retention.${m.a.retention_in_days ? '' : ' Retention is "never expire"; capped at 12 months here.'} AWS compresses logs, so real storage is usually lower.`);
    },
  },

  aws_cloudwatch_metric_alarm: {
    services: () => ['AmazonCloudWatch'],
    price(m) {
      const hi = Number(m.a.period) > 0 && Number(m.a.period) < 60;
      m.fixed('AmazonCloudWatch', `Alarm (${hi ? 'high' : 'standard'} resolution)`, hi ? { usageType: 'CW:HighResAlarmMonitorUsage' } : { usageType: 'CW:AlarmMonitorUsage', free: 'Global-CW:AlarmMonitorUsage' }, 1);
    },
  },

  aws_cognito_user_pool: {
    services: () => ['AmazonCognito'],
    price(m) {
      const tier = String(m.a.user_pool_tier || 'ESSENTIALS');
      const ut = ({ LITE: 'CognitoLiteMAU', ESSENTIALS: 'CognitoEssentialsMAU', PLUS: 'CognitoPlusMAU' } as Record<string, string>)[tier];
      if (!ut) return m.unpriced(`Cognito tier "${tier}" not mapped`);
      const mau = m.param('mau', 'Monthly active users', 'MAU', 1_000, 10_000_000);
      m.usage('AmazonCognito', `${tier[0] + tier.slice(1).toLowerCase()} tier MAUs`, { usageType: ut, free: tier === 'PLUS' ? undefined : 'Global-CognitoFreeTierMAU' }, 1, [mau], 'Lite and Essentials include 10,000 MAU free every month (turn on Free tier to apply).');
    },
  },
};

const RDS_ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

/** Resources that cost nothing by themselves. Shown as $0 explicitly, not "unknown". */
export const FREE_TYPES = [
  /^aws_(vpc|subnet|internet_gateway|egress_only_internet_gateway|route_table|route_table_association|route|main_route_table_association|network_acl|network_acl_rule|default_.*)$/,
  /^aws_(security_group|security_group_rule|vpc_security_group_(ingress|egress)_rule)$/,
  /^aws_iam_/,
  /^aws_lb_(listener|listener_rule|listener_certificate|target_group|target_group_attachment)$/,
  /^aws_(launch_template|launch_configuration|autoscaling_policy|autoscaling_lifecycle_hook|autoscaling_attachment)$/,
  /^aws_db_(subnet_group|parameter_group|option_group)$/,
  /^aws_lambda_(permission|event_source_mapping|alias|layer_version|function_url)$/,
  /^aws_apigatewayv2_(stage|route|integration|authorizer|deployment|route_response|integration_response|vpc_link)$/,
  /^aws_api_gateway_(resource|method|integration|deployment|stage|method_response|integration_response)$/,
  /^aws_cognito_(user_pool_client|resource_server|user_pool_domain|user_group|identity_provider)$/,
  /^aws_s3_bucket_/,
  /^aws_(sqs_queue_policy|sqs_queue_redrive_policy|sns_topic_subscription|sns_topic_policy)$/,
  /^aws_secretsmanager_secret_(version|policy|rotation)$/,
  /^aws_(acm_certificate|acm_certificate_validation)$/,
  /^aws_(key_pair|placement_group|kms_alias|cloudwatch_log_stream|cloudwatch_log_subscription_filter|cloudwatch_event_target)$/,
  /^aws_(eip_association|volume_attachment|network_interface_attachment)$/,
];
