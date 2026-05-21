locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = var.aws_region
  ssm_param_arn = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/${var.project_name}/*"
  ecr_repo_arn  = "arn:aws:ecr:${local.region}:${local.account_id}:repository/${var.project_name}/*"
  log_group_arn = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/${var.project_name}/*"
  task_def_arn  = "arn:aws:ecs:${local.region}:${local.account_id}:task-definition/*"
  task_arn      = "arn:aws:ecs:${local.region}:${local.account_id}:task/${aws_ecs_cluster.afk.name}/*"
}

# ---------------------------------------------------------------------------
# Task execution role — used by the ECS control plane to pull images, fetch
# SSM secret references, and write container logs to CloudWatch.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_execution_extra" {
  statement {
    sid       = "ReadAfkSsmParameters"
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = [local.ssm_param_arn]
  }

  statement {
    sid       = "DecryptDefaultSsmKey"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_execution_extra" {
  name   = "${var.project_name}-task-execution-extra"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_extra.json
}

# ---------------------------------------------------------------------------
# Task role — assumed by the container at runtime. Minimal by design;
# consumers can attach extra policies in their own Terraform if needed.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.project_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  # Required for ECS Exec from inside the container.
  statement {
    sid = "EcsExecSsmMessages"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "WriteRunLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [local.log_group_arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.project_name}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---------------------------------------------------------------------------
# Developer role + policy — what the CLI assumes (or what is attached
# directly to individual developer IAM principals by an admin).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "developer_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
}

resource "aws_iam_role" "developer" {
  name               = "${var.project_name}-developer"
  assume_role_policy = data.aws_iam_policy_document.developer_assume.json
}

data "aws_iam_policy_document" "developer" {
  statement {
    sid = "ManageRuns"
    actions = [
      "ecs:RunTask",
      "ecs:StopTask",
      "ecs:ListTasks",
      "ecs:DescribeTasks",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:ListTaskDefinitions",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.afk.arn]
    }
  }

  # RegisterTaskDefinition and ListTaskDefinitions don't accept the ecs:cluster
  # condition. Allow them unconditionally — RegisterTaskDefinition is
  # account-scoped by nature.
  statement {
    sid = "RegisterTaskDefinitionUnscoped"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTaskDefinitions",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "AttachOnlyToOwnRuns"
    actions   = ["ecs:ExecuteCommand"]
    resources = [local.task_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/afk:owner"
      values   = ["$${aws:userid}"]
    }
  }

  statement {
    sid = "ManageAfkEcrRepositories"
    actions = [
      "ecr:CreateRepository",
      "ecr:DescribeRepositories",
      "ecr:PutLifecyclePolicy",
      "ecr:GetLifecyclePolicy",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:ListImages",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [local.ecr_repo_arn]
  }

  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ManageAfkSsmParameters"
    actions = [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:DeleteParameter",
      "ssm:DescribeParameters",
    ]
    resources = [local.ssm_param_arn]
  }

  statement {
    sid = "ManageAfkLogGroups"
    actions = [
      "logs:CreateLogGroup",
      "logs:PutRetentionPolicy",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartLiveTail",
    ]
    resources = [local.log_group_arn]
  }

  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.task_execution.arn,
      aws_iam_role.task.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "developer" {
  name   = "${var.project_name}-developer"
  policy = data.aws_iam_policy_document.developer.json
}

resource "aws_iam_role_policy_attachment" "developer" {
  role       = aws_iam_role.developer.name
  policy_arn = aws_iam_policy.developer.arn
}
