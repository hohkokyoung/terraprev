// Terraform type → what AWS calls it in the console and docs.

const N: Record<string, [service: string, resource: string]> = {
  aws_instance: ['Amazon EC2', 'Instance'],
  aws_launch_template: ['Amazon EC2', 'Launch template'],
  aws_ebs_volume: ['Amazon EBS', 'Volume'],
  aws_eip: ['Amazon EC2', 'Elastic IP address'],
  aws_key_pair: ['Amazon EC2', 'Key pair'],
  aws_autoscaling_group: ['Amazon EC2 Auto Scaling', 'Auto Scaling group'],
  aws_autoscaling_policy: ['Amazon EC2 Auto Scaling', 'Scaling policy'],

  aws_vpc: ['Amazon VPC', 'VPC'],
  aws_subnet: ['Amazon VPC', 'Subnet'],
  aws_internet_gateway: ['Amazon VPC', 'Internet gateway'],
  aws_nat_gateway: ['Amazon VPC', 'NAT gateway'],
  aws_route_table: ['Amazon VPC', 'Route table'],
  aws_route_table_association: ['Amazon VPC', 'Route table association'],
  aws_route: ['Amazon VPC', 'Route'],
  aws_network_acl: ['Amazon VPC', 'Network ACL'],
  aws_security_group: ['Amazon VPC', 'Security group'],
  aws_security_group_rule: ['Amazon VPC', 'Security group rule'],
  aws_vpc_security_group_ingress_rule: ['Amazon VPC', 'Security group inbound rule'],
  aws_vpc_security_group_egress_rule: ['Amazon VPC', 'Security group outbound rule'],
  aws_vpc_endpoint: ['AWS PrivateLink', 'VPC endpoint'],

  aws_lb: ['Elastic Load Balancing', 'Load balancer'],
  aws_lb_listener: ['Elastic Load Balancing', 'Listener'],
  aws_lb_listener_rule: ['Elastic Load Balancing', 'Listener rule'],
  aws_lb_target_group: ['Elastic Load Balancing', 'Target group'],
  aws_lb_target_group_attachment: ['Elastic Load Balancing', 'Target registration'],

  aws_lambda_function: ['AWS Lambda', 'Function'],
  aws_lambda_permission: ['AWS Lambda', 'Resource-based policy statement'],
  aws_lambda_event_source_mapping: ['AWS Lambda', 'Event source mapping (trigger)'],
  aws_lambda_alias: ['AWS Lambda', 'Alias'],

  aws_apigatewayv2_api: ['Amazon API Gateway', 'HTTP / WebSocket API'],
  aws_apigatewayv2_stage: ['Amazon API Gateway', 'Stage'],
  aws_apigatewayv2_route: ['Amazon API Gateway', 'Route'],
  aws_apigatewayv2_integration: ['Amazon API Gateway', 'Integration'],
  aws_apigatewayv2_authorizer: ['Amazon API Gateway', 'Authorizer'],
  aws_api_gateway_rest_api: ['Amazon API Gateway', 'REST API'],

  aws_db_instance: ['Amazon RDS', 'DB instance'],
  aws_db_subnet_group: ['Amazon RDS', 'DB subnet group'],
  aws_db_parameter_group: ['Amazon RDS', 'DB parameter group'],
  aws_rds_cluster: ['Amazon Aurora', 'DB cluster'],
  aws_rds_cluster_instance: ['Amazon Aurora', 'DB instance'],
  aws_dynamodb_table: ['Amazon DynamoDB', 'Table'],
  aws_elasticache_cluster: ['Amazon ElastiCache', 'Cluster'],

  aws_s3_bucket: ['Amazon S3', 'Bucket'],
  aws_s3_bucket_versioning: ['Amazon S3', 'Bucket versioning'],
  aws_s3_bucket_notification: ['Amazon S3', 'Event notification'],
  aws_s3_bucket_public_access_block: ['Amazon S3', 'Block Public Access settings'],
  aws_s3_bucket_policy: ['Amazon S3', 'Bucket policy'],
  aws_s3_bucket_server_side_encryption_configuration: ['Amazon S3', 'Default encryption'],
  aws_s3_bucket_lifecycle_configuration: ['Amazon S3', 'Lifecycle rules'],

  aws_sqs_queue: ['Amazon SQS', 'Queue'],
  aws_sqs_queue_policy: ['Amazon SQS', 'Queue access policy'],
  aws_sns_topic: ['Amazon SNS', 'Topic'],
  aws_sns_topic_subscription: ['Amazon SNS', 'Subscription'],
  aws_cloudwatch_event_rule: ['Amazon EventBridge', 'Rule'],
  aws_cloudwatch_event_target: ['Amazon EventBridge', 'Target'],
  aws_sfn_state_machine: ['AWS Step Functions', 'State machine'],

  aws_cloudwatch_log_group: ['Amazon CloudWatch Logs', 'Log group'],
  aws_cloudwatch_metric_alarm: ['Amazon CloudWatch', 'Alarm'],

  aws_iam_role: ['AWS IAM', 'Role'],
  aws_iam_role_policy: ['AWS IAM', 'Inline policy'],
  aws_iam_policy: ['AWS IAM', 'Customer managed policy'],
  aws_iam_role_policy_attachment: ['AWS IAM', 'Policy attachment'],
  aws_iam_instance_profile: ['AWS IAM', 'Instance profile'],
  aws_iam_user: ['AWS IAM', 'User'],
  aws_cognito_user_pool: ['Amazon Cognito', 'User pool'],
  aws_cognito_user_pool_client: ['Amazon Cognito', 'App client'],
  aws_cognito_resource_server: ['Amazon Cognito', 'Resource server'],
  aws_cognito_user_pool_domain: ['Amazon Cognito', 'Domain'],
  aws_acm_certificate: ['AWS Certificate Manager', 'Certificate'],
  aws_secretsmanager_secret: ['AWS Secrets Manager', 'Secret'],
  aws_secretsmanager_secret_version: ['AWS Secrets Manager', 'Secret value (version)'],
  aws_kms_key: ['AWS KMS', 'Key'],
  aws_ssm_parameter: ['AWS Systems Manager', 'Parameter'],
  aws_route53_zone: ['Amazon Route 53', 'Hosted zone'],
  aws_route53_record: ['Amazon Route 53', 'Record'],
  aws_cloudfront_distribution: ['Amazon CloudFront', 'Distribution'],
  aws_ecs_cluster: ['Amazon ECS', 'Cluster'],
  aws_ecs_service: ['Amazon ECS', 'Service'],
  aws_eks_cluster: ['Amazon EKS', 'Cluster'],
};

/** e.g. { service: 'Amazon RDS', resource: 'DB instance', full: 'Amazon RDS · DB instance' } */
export function awsName(type: string): { service: string; resource: string; full: string } | undefined {
  const hit = N[type];
  if (hit) return { service: hit[0], resource: hit[1], full: `${hit[0]} · ${hit[1]}` };
  if (!type.startsWith('aws_')) return undefined;
  // Fallback: aws_foo_bar_baz → "Foo bar baz"
  const words = type.slice(4).replace(/_/g, ' ');
  const resource = words[0].toUpperCase() + words.slice(1);
  return { service: 'AWS', resource, full: resource };
}
