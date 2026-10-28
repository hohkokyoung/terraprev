import type { NodeChange } from '../../../shared/compare.ts';

/**
 * Resource types whose destruction loses something that can't be recreated from the .tf files:
 * stored data, queued messages, user accounts, keys, images, logs.
 */
const HOLDS_DATA = new Set([
  'aws_db_instance', 'aws_rds_cluster', 'aws_docdb_cluster', 'aws_neptune_cluster', 'aws_redshift_cluster',
  'aws_dynamodb_table', 'aws_keyspaces_table', 'aws_timestreamwrite_table', 'aws_qldb_ledger',
  'aws_s3_bucket', 'aws_glacier_vault', 'aws_ebs_volume', 'aws_efs_file_system', 'aws_backup_vault',
  'aws_elasticache_cluster', 'aws_elasticache_replication_group', 'aws_memorydb_cluster',
  'aws_opensearch_domain', 'aws_elasticsearch_domain',
  'aws_sqs_queue', 'aws_kinesis_stream', 'aws_msk_cluster',
  'aws_cognito_user_pool', 'aws_secretsmanager_secret', 'aws_kms_key',
  'aws_ecr_repository', 'aws_cloudwatch_log_group',
]);

export const holdsData = (type: string | undefined) => !!type && (HOLDS_DATA.has(type) || type.startsWith('aws_fsx_'));

/** A plan that deletes or replaces one of these loses what it holds. */
export const losesData = (change: NodeChange | undefined, type: string | undefined) =>
  (change === 'removed' || change === 'replaced') && holdsData(type);
