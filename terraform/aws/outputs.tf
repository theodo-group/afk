output "aws_region" {
  description = "Region in which AFK is provisioned."
  value       = var.aws_region
}

output "account_id" {
  description = "AWS account ID hosting AFK."
  value       = data.aws_caller_identity.current.account_id
}

output "vpc_id" {
  description = "AFK VPC ID."
  value       = aws_vpc.afk.id
}

output "subnet_ids" {
  description = "Public subnet IDs Runs are launched into. Both AZs included."
  value       = aws_subnet.public[*].id
}

output "security_group_id" {
  description = "Security group attached to every Run VM (deny inbound, allow outbound)."
  value       = aws_security_group.runs.id
}

output "vm_instance_profile_name" {
  description = "Name of the instance profile attached to every Run VM."
  value       = aws_iam_instance_profile.vm_instance.name
}

output "vm_instance_profile_arn" {
  description = "ARN of the instance profile attached to every Run VM."
  value       = aws_iam_instance_profile.vm_instance.arn
}

output "vm_instance_role_arn" {
  description = "Role assumed by every Run VM via its instance profile."
  value       = aws_iam_role.vm_instance.arn
}

output "developer_role_arn" {
  description = "Role developers assume (or whose policy is attached to their principals) to drive AFK."
  value       = aws_iam_role.developer.arn
}

output "developer_policy_arn" {
  description = "Customer-managed policy granting AFK developer permissions. Attach to IAM users/roles directly if not using the developer role."
  value       = aws_iam_policy.developer.arn
}

output "sweeper_function_name" {
  description = "Name of the sweeper Lambda function."
  value       = aws_lambda_function.sweeper.function_name
}

output "runs_table_name" {
  description = "DynamoDB table holding persistent Run history."
  value       = aws_dynamodb_table.runs.name
}

output "allowed_instance_types" {
  description = "Whitelist of instance types developers may launch Runs on."
  value       = var.allowed_instance_types
}

output "max_run_timeout_hours" {
  description = "Hard ceiling on Run duration. CLI rejects --timeout values above this."
  value       = var.max_run_timeout_hours
}
