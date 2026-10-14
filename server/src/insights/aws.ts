// Architecture findings for an AWS stack, read straight from terraform state attributes.
// Each rule states what it saw; nothing here guesses at runtime behaviour.

import type { GraphNode, Insight, TfResource } from '../../../shared/types.ts';
import { displayName } from '../graph/catalog.ts';

type Ctx = {
  resources: TfResource[];
  nodeOf: Map<string, string>;
  nodes: GraphNode[];
};

const of = (rs: TfResource[], type: string) => rs.filter((r) => r.type === type);
const truthy = (v: unknown) => v === true || v === 'true';
const ids = (ctx: Ctx, rs: TfResource[]) => [...new Set(rs.map((r) => ctx.nodeOf.get(r.address) ?? r.address))];
const names = (rs: TfResource[]) => rs.map(displayName).join(', ');

export function awsInsights(all: TfResource[], nodeOf: Map<string, string>, nodes: GraphNode[]): Insight[] {
  const resources = all.filter((r) => r.mode === 'managed' && r.provider === 'aws');
  if (!resources.length) return [];
  const ctx: Ctx = { resources, nodeOf, nodes };
  const out: Insight[] = [];
  const add = (i: Insight) => out.push(i);

  const subnets = of(resources, 'aws_subnet');
  const azs = new Set(subnets.map((s) => s.attrs.availability_zone).filter(Boolean));
  const publicSubnetIds = new Set(nodes.filter((n) => n.groupKind === 'subnet' && n.sublabel?.startsWith('public')).map((n) => resources.find((r) => r.address === n.id)?.attrs.id));

  // ── Reliability ──
  const nats = of(resources, 'aws_nat_gateway');
  if (nats.length === 1 && azs.size > 1) {
    add({
      id: 'nat-single', severity: 'medium', category: 'reliability',
      title: 'One NAT gateway serves every AZ',
      detail: `${displayName(nats[0])} sits in one AZ but private subnets in ${azs.size} AZs route through it. If that AZ fails, private workloads in the other AZs lose outbound internet; cross-AZ traffic to it is also billed.`,
      recommendation: 'Run one NAT gateway per AZ for production, or keep one deliberately for non-production to save ~$33/month each.',
      nodes: ids(ctx, nats),
    });
  }
  for (const db of of(resources, 'aws_db_instance')) {
    const a = db.attrs;
    if (!truthy(a.multi_az)) {
      add({
        id: `rds-single-az:${db.address}`, severity: 'medium', category: 'reliability',
        title: `${displayName(db)} is single-AZ`,
        detail: 'The database runs in one availability zone with no standby. An AZ outage or instance failure means downtime until it is restored.',
        recommendation: 'Enable Multi-AZ for production (roughly doubles the instance cost).',
        nodes: ids(ctx, [db]),
      });
    }
    if (Number(a.backup_retention_period) === 0) {
      add({
        id: `rds-no-backup:${db.address}`, severity: 'high', category: 'reliability',
        title: `${displayName(db)} has automated backups disabled`,
        detail: `backup_retention_period = 0: no point-in-time recovery.${truthy(a.skip_final_snapshot) ? ' skip_final_snapshot = true, so deleting the instance also loses the data.' : ''}`,
        recommendation: 'Set backup_retention_period to 7+ days and skip_final_snapshot = false. Backup storage up to the DB size is free.',
        nodes: ids(ctx, [db]),
      });
    }
    if (!truthy(a.deletion_protection)) {
      add({
        id: `rds-no-delete-protect:${db.address}`, severity: 'low', category: 'reliability',
        title: `${displayName(db)} can be deleted by a single apply`,
        detail: 'deletion_protection is off.',
        recommendation: 'Turn on deletion_protection for any database holding real data.',
        nodes: ids(ctx, [db]),
      });
    }
  }
  for (const asg of of(resources, 'aws_autoscaling_group')) {
    const zones = new Set((asg.attrs.vpc_zone_identifier ?? []).map((id: string) => subnets.find((s) => s.attrs.id === id)?.attrs.availability_zone));
    if (zones.size >= 2 && Number(asg.attrs.min_size) >= 2) {
      add({
        id: `asg-ha:${asg.address}`, severity: 'good', category: 'reliability',
        title: `${displayName(asg)} spans ${zones.size} AZs with at least ${asg.attrs.min_size} instances`,
        detail: `Rolling instance refresh${asg.attrs.instance_refresh?.length ? ' is configured' : ' is not configured'}; health checks use ${asg.attrs.health_check_type}.`,
        nodes: ids(ctx, [asg]),
      });
    } else if (zones.size < 2 || Number(asg.attrs.min_size) < 2) {
      add({
        id: `asg-spof:${asg.address}`, severity: 'medium', category: 'reliability',
        title: `${displayName(asg)} can drop to a single instance or AZ`,
        detail: `min_size = ${asg.attrs.min_size}, ${zones.size} AZ(s).`,
        recommendation: 'Use min_size ≥ 2 across at least two AZs for anything user-facing.',
        nodes: ids(ctx, [asg]),
      });
    }
  }
  const asyncLambdas = of(resources, 'aws_lambda_function').filter((fn) => {
    // Invoked by S3/SNS (async) without a DLQ or on-failure destination.
    const asyncSource = resources.some(
      (r) => r.type === 'aws_lambda_permission' && /s3|sns|events/.test(String(r.attrs.principal)) && String(r.attrs.function_name) === fn.attrs.function_name,
    );
    const hasDlq = (fn.attrs.dead_letter_config ?? []).some((d: any) => d.target_arn);
    const hasDest = resources.some((r) => r.type === 'aws_lambda_function_event_invoke_config' && r.attrs.function_name === fn.attrs.function_name);
    return asyncSource && !hasDlq && !hasDest;
  });
  if (asyncLambdas.length) {
    add({
      id: 'lambda-async-no-dlq', severity: 'low', category: 'reliability',
      title: 'Async-triggered functions drop events after retries',
      detail: `${names(asyncLambdas)} ${asyncLambdas.length > 1 ? 'are' : 'is'} invoked asynchronously (S3/SNS/EventBridge) with no dead-letter queue or on-failure destination; failed events are discarded after 2 retries.`,
      recommendation: 'Add a dead_letter_config or an aws_lambda_function_event_invoke_config with an on-failure destination.',
      nodes: ids(ctx, asyncLambdas),
    });
  }
  const queues = of(resources, 'aws_sqs_queue');
  const withDlq = queues.filter((q) => q.attrs.redrive_policy);
  if (withDlq.length) {
    add({
      id: 'sqs-dlq', severity: 'good', category: 'reliability',
      title: 'Queue failures are captured in a dead-letter queue',
      detail: `${names(withDlq)} redrive${withDlq.length > 1 ? '' : 's'} poison messages instead of retrying forever.`,
      nodes: ids(ctx, withDlq),
    });
  }

  // ── Security ──
  for (const db of of(resources, 'aws_db_instance')) {
    if (!truthy(db.attrs.storage_encrypted)) {
      add({
        id: `rds-unencrypted:${db.address}`, severity: 'high', category: 'security',
        title: `${displayName(db)} storage is not encrypted at rest`,
        detail: 'storage_encrypted = false. Encryption cannot be turned on in place later; it needs a snapshot-and-restore migration.',
        recommendation: 'Set storage_encrypted = true now, while the database is small.',
        nodes: ids(ctx, [db]),
      });
    }
    if (truthy(db.attrs.publicly_accessible)) {
      add({
        id: `rds-public:${db.address}`, severity: 'high', category: 'security',
        title: `${displayName(db)} is publicly accessible`,
        detail: 'publicly_accessible = true gives the database a public endpoint.',
        recommendation: 'Keep databases private; reach them through the app tier or a bastion/SSM.',
        nodes: ids(ctx, [db]),
      });
    } else {
      add({
        id: `rds-private:${db.address}`, severity: 'good', category: 'security',
        title: `${displayName(db)} is private and only reachable from named security groups`,
        detail: 'No public endpoint; ingress is limited by security-group references rather than CIDR ranges.',
        nodes: ids(ctx, [db]),
      });
    }
  }
  for (const lt of of(resources, 'aws_launch_template')) {
    let ud = '';
    try {
      ud = Buffer.from(String(lt.attrs.user_data ?? ''), 'base64').toString('utf8');
    } catch {
      /* not base64 */
    }
    const literal = hardcodedSecret(ud);
    if (literal) {
      add({
        id: `userdata-secret:${lt.address}`, severity: 'high', category: 'security',
        title: 'A credential is hard-coded in instance user data',
        detail: `The launch template ${displayName(lt)} assigns a literal value to ${literal} in user_data. Anyone who can read instance metadata, the launch template, or terraform state can read it. (The value itself is not included in this report.)`,
        recommendation: 'Fetch the secret from Secrets Manager or SSM Parameter Store at boot using the instance role.',
        nodes: ids(ctx, [lt]),
      });
    } else if (/get_secret_value|get-secret-value|secretsmanager|ssm get-parameter|get_parameter/i.test(ud)) {
      add({
        id: `userdata-fetches-secret:${lt.address}`, severity: 'good', category: 'security',
        title: 'Instances fetch credentials at boot instead of storing them',
        detail: `${displayName(lt)}'s user_data reads credentials from ${/ssm/i.test(ud) && !/secretsmanager|secret_value/i.test(ud) ? 'SSM Parameter Store' : 'Secrets Manager'} at runtime via the instance role; no password is written into the template.`,
        nodes: ids(ctx, [lt]),
      });
    }
    const tokens = lt.attrs.metadata_options?.[0]?.http_tokens;
    if (tokens !== 'required') {
      add({
        id: `imdsv1:${lt.address}`, severity: 'medium', category: 'security',
        title: 'Instances allow IMDSv1',
        detail: `metadata_options.http_tokens is ${tokens ? `"${tokens}"` : 'unset'}, so the legacy metadata service, a common SSRF credential-theft path, is enabled.`,
        recommendation: 'Set metadata_options { http_tokens = "required" }.',
        nodes: ids(ctx, [lt]),
      });
    }
  }
  for (const sg of of(resources, 'aws_security_group')) {
    const risky = (sg.attrs.ingress ?? []).filter(
      (r: any) => (r.cidr_blocks ?? []).includes('0.0.0.0/0') && !(Number(r.from_port) === 80 && Number(r.to_port) === 80) && !(Number(r.from_port) === 443 && Number(r.to_port) === 443),
    );
    if (risky.length) {
      add({
        id: `sg-open:${sg.address}`, severity: 'high', category: 'security',
        title: `${displayName(sg)} opens ${risky.map((r: any) => (r.protocol === '-1' ? 'all ports' : `port ${r.from_port === r.to_port ? r.from_port : `${r.from_port}-${r.to_port}`}`)).join(', ')} to the internet`,
        detail: 'Inbound from 0.0.0.0/0 on a port other than HTTP/HTTPS.',
        recommendation: 'Restrict to known CIDRs, or use SSM Session Manager instead of SSH.',
        nodes: ids(ctx, [sg]),
      });
    }
  }
  const publicAsg = of(resources, 'aws_autoscaling_group').filter((a) => (a.attrs.vpc_zone_identifier ?? []).every((id: string) => publicSubnetIds.has(id)));
  if (publicAsg.length && of(resources, 'aws_lb').length) {
    add({
      id: 'app-in-public-subnets', severity: 'medium', category: 'security',
      title: 'App instances run in public subnets behind the load balancer',
      detail: `${names(publicAsg)} launches into public subnets, so each instance gets a public IPv4 address even though traffic arrives via the ALB. Security groups are the only barrier.`,
      recommendation: 'Move the app tier to private subnets (they already route out through the NAT). Also removes the per-instance public IPv4 charge.',
      nodes: ids(ctx, publicAsg),
    });
  }
  const unencryptedQueues = queues.filter((q) => !truthy(q.attrs.sqs_managed_sse_enabled) && !q.attrs.kms_master_key_id);
  if (unencryptedQueues.length) {
    add({
      id: 'sqs-sse', severity: 'low', category: 'security',
      title: 'Queues are not encrypted at rest',
      detail: `${names(unencryptedQueues)}: neither SQS-managed SSE nor KMS is enabled.`,
      recommendation: 'Set sqs_managed_sse_enabled = true (free).',
      nodes: ids(ctx, unencryptedQueues),
    });
  }
  const wildcard: TfResource[] = [];
  for (const p of resources.filter((r) => r.type === 'aws_iam_role_policy' || r.type === 'aws_iam_policy')) {
    try {
      const doc = JSON.parse(p.attrs.policy);
      const sts = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
      if (sts.some((st: any) => st.Effect === 'Allow' && ([st.Action].flat().some((a: string) => a === '*' || a.endsWith(':*')) || [st.Resource].flat().includes('*')))) wildcard.push(p);
    } catch {
      /* ignore */
    }
  }
  if (wildcard.length) {
    add({
      id: 'iam-wildcard', severity: 'medium', category: 'security',
      title: 'IAM policies use wildcards',
      detail: `${names(wildcard)} grant "*" actions or resources.`,
      recommendation: 'Scope policies to the specific actions and ARNs they need.',
      nodes: ids(ctx, wildcard),
    });
  } else if (resources.some((r) => r.type === 'aws_iam_role_policy')) {
    add({
      id: 'iam-scoped', severity: 'good', category: 'security',
      title: 'IAM policies are scoped to specific actions and resources',
      detail: 'No inline policy grants "*" actions or "*" resources.',
      nodes: [],
    });
  }
  const httpsListeners = of(resources, 'aws_lb_listener').filter((l) => l.attrs.protocol === 'HTTPS');
  const redirects = of(resources, 'aws_lb_listener').filter((l) => l.attrs.protocol === 'HTTP' && (l.attrs.default_action ?? []).some((a: any) => a.type === 'redirect'));
  if (httpsListeners.length && redirects.length) {
    add({
      id: 'https-redirect', severity: 'good', category: 'security',
      title: 'HTTP is redirected to HTTPS at the load balancer',
      detail: 'Clients reaching port 80 are sent to the TLS listener.',
      nodes: ids(ctx, [...httpsListeners, ...redirects]),
    });
  }

  // ── Operations ──
  const alarms = of(resources, 'aws_cloudwatch_metric_alarm');
  if (!alarms.length) {
    add({
      id: 'no-alarms', severity: 'medium', category: 'operations',
      title: 'No CloudWatch alarms are defined',
      detail: 'Nothing pages anyone when the ALB returns 5xx, the queue backs up, the DLQ receives messages or the database runs out of storage.',
      recommendation: 'Start with: ALB 5xx rate, ALB unhealthy hosts, SQS DLQ depth > 0, RDS free storage and CPU. About $0.10/alarm/month.',
      nodes: [],
    });
  }
  for (const lb of of(resources, 'aws_lb')) {
    if (!(lb.attrs.access_logs ?? []).some((l: any) => truthy(l.enabled))) {
      add({
        id: `alb-no-logs:${lb.address}`, severity: 'low', category: 'operations',
        title: `${displayName(lb)} access logs are off`,
        detail: 'There is no record of individual requests for debugging or security investigations.',
        recommendation: 'Enable access_logs to an S3 bucket.',
        nodes: ids(ctx, [lb]),
      });
    }
  }
  const shortLogs = of(resources, 'aws_cloudwatch_log_group').filter((g) => Number(g.attrs.retention_in_days) > 0 && Number(g.attrs.retention_in_days) < 30);
  const foreverLogs = of(resources, 'aws_cloudwatch_log_group').filter((g) => !Number(g.attrs.retention_in_days));
  if (shortLogs.length) {
    add({
      id: 'logs-short', severity: 'info', category: 'operations',
      title: `Log retention is short (${[...new Set(shortLogs.map((g) => g.attrs.retention_in_days))].join('/')} days)`,
      detail: `${names(shortLogs)}. Cheap, but may be too short for incident reviews or audit requirements.`,
      recommendation: 'Decide retention per compliance needs (30–90 days is common).',
      nodes: ids(ctx, shortLogs),
    });
  }
  if (foreverLogs.length) {
    add({
      id: 'logs-forever', severity: 'low', category: 'cost',
      title: 'Some log groups never expire',
      detail: `${names(foreverLogs)} keep logs forever; storage cost grows every month.`,
      recommendation: 'Set retention_in_days.',
      nodes: ids(ctx, foreverLogs),
    });
  }
  const untraced = of(resources, 'aws_lambda_function').filter((f) => (f.attrs.tracing_config?.[0]?.mode ?? 'PassThrough') !== 'Active');
  if (untraced.length > 1) {
    add({
      id: 'no-tracing', severity: 'info', category: 'operations',
      title: 'Distributed tracing is off',
      detail: `${untraced.length} functions run without X-Ray tracing, so a request can't be followed across API Gateway → ALB → Lambda/EC2 → database.`,
      recommendation: 'Enable tracing_config { mode = "Active" } where request paths span several services.',
      nodes: ids(ctx, untraced),
    });
  }

  // ── Cost ──
  const oldGen = [...of(resources, 'aws_launch_template'), ...of(resources, 'aws_instance')].filter((r) => /^(t2|m4|c4|r4|m3|c3)\./.test(String(r.attrs.instance_type)));
  if (oldGen.length) {
    add({
      id: 'old-gen', severity: 'low', category: 'cost',
      title: 'Previous-generation instance types',
      detail: `${oldGen.map((r) => `${displayName(r)} (${r.attrs.instance_type})`).join(', ')}.`,
      recommendation: 'Current generations (t3/t4g, m7g…) are cheaper per unit of performance.',
      nodes: ids(ctx, oldGen),
    });
  }
  const gp2 = of(resources, 'aws_ebs_volume').filter((v) => v.attrs.type === 'gp2');
  if (gp2.length) {
    add({
      id: 'ebs-gp2', severity: 'low', category: 'cost',
      title: 'EBS volumes use gp2',
      detail: `${names(gp2)}. gp3 is ~20% cheaper per GB with better baseline performance.`,
      recommendation: 'Change type to gp3 (online, no downtime).',
      nodes: ids(ctx, gp2),
    });
  }

  return out;
}

/**
 * Name of a password-like variable assigned a *literal* value in a script, e.g. DB_PASSWORD="hunter2"
 * or export PGPASSWORD=abc123. References are fine and ignored: ARNs, ${template} / $ENV lookups,
 * function calls, dict lookups (password=creds["password"]).
 */
export function hardcodedSecret(script: string): string | undefined {
  const NAME = String.raw`([A-Za-z_]*(?:password|passwd|pwd|secret|token|api_?key|access_?key)[A-Za-z_]*)`;
  const quoted = new RegExp(`${NAME}\\s*[=:]\\s*(["'])([^"'\\n]*)\\2`, 'gi');
  const bare = new RegExp(`(?:^|\\s|export\\s+)${NAME}=([^\\s"'$({\\[]+)`, 'gim');
  const isReference = (v: string) => !v || v.length < 6 || /^arn:|\$\{|^\$|^<.*>$|changeme|example|placeholder|^\*+$/i.test(v);
  for (const m of script.matchAll(quoted)) if (!isReference(m[3]) && !/_(id|arn|name)$/i.test(m[1])) return m[1];
  for (const m of script.matchAll(bare)) if (!isReference(m[2]) && !/_(id|arn|name)$/i.test(m[1])) return m[1];
  return undefined;
}

/** "local emulator" when every ARN uses the 000000000000 test account (floci, LocalStack, moto). */
export function detectEnvironment(all: TfResource[]): string | undefined {
  const arns = all.map((r) => r.attrs.arn).filter((a): a is string => typeof a === 'string' && a.startsWith('arn:'));
  if (arns.length && arns.every((a) => a.split(':')[4] === '000000000000' || a.split(':')[4] === '')) {
    return 'local AWS emulator (account 000000000000); costs show what the same stack would cost on real AWS';
  }
  return undefined;
}
