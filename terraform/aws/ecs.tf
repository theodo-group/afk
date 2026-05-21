resource "aws_cloudwatch_log_group" "exec" {
  count = var.enable_exec_logging ? 1 : 0

  name              = "/${var.project_name}/exec"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "afk" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  configuration {
    execute_command_configuration {
      logging = var.enable_exec_logging ? "OVERRIDE" : "DEFAULT"

      dynamic "log_configuration" {
        for_each = var.enable_exec_logging ? [1] : []

        content {
          cloud_watch_log_group_name     = aws_cloudwatch_log_group.exec[0].name
          cloud_watch_encryption_enabled = false
        }
      }
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "afk" {
  cluster_name       = aws_ecs_cluster.afk.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}
