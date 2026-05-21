output "aws_region" {
  description = "Region in which AFK is provisioned."
  value       = var.aws_region
}

output "account_id" {
  description = "AWS account ID hosting AFK."
  value       = data.aws_caller_identity.current.account_id
}

output "cluster_name" {
  description = "ECS cluster name. Passed to ecs:RunTask by the CLI."
  value       = aws_ecs_cluster.afk.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.afk.arn
}

output "subnet_ids" {
  description = "Public subnet IDs Runs are launched into. Both AZs included."
  value       = aws_subnet.public[*].id
}

output "security_group_id" {
  description = "Security group attached to every Run (deny inbound, allow outbound)."
  value       = aws_security_group.runs.id
}

output "task_execution_role_arn" {
  description = "Role ECS assumes to launch a Run (pull image, fetch SSM secrets, write logs)."
  value       = aws_iam_role.task_execution.arn
}

output "task_role_arn" {
  description = "Role the Run's container assumes at runtime."
  value       = aws_iam_role.task.arn
}

output "developer_role_arn" {
  description = "Role developers assume (or whose policy is attached to their principals) to drive AFK."
  value       = aws_iam_role.developer.arn
}

output "developer_policy_arn" {
  description = "Customer-managed policy granting AFK developer permissions. Attach to IAM users/roles directly if not using the developer role."
  value       = aws_iam_policy.developer.arn
}

output "max_run_timeout_hours" {
  description = "Hard ceiling on Run duration. CLI rejects --timeout values above this."
  value       = var.max_run_timeout_hours
}
