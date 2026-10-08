# ---------------------------------------------------------------------------
# Scheduler Lambda — ticks submitted Schedules and launches what is due.
#
# Opt-in (`scheduler_enabled`). Unlike the sweeper's esbuild zip this is a
# container image: afk is Bun-only, so the tick cannot run on nodejs20. The
# image carries bun, git and the AWS CLI and runs `afk schedule tick` — the
# same subcommand a developer runs by hand, not a second implementation of the
# same rules.
#
# The scheduler never builds an image and never kills a Run. `afk schedule
# submit` builds on the developer's laptop and pins the result on every Entry,
# which is what lets this be a Lambda at all: no Docker, no 1.7 GB checkout.
# ---------------------------------------------------------------------------

locals {
  scheduler_repo_root = "${path.module}/../.."

  # Rebuild when anything that ends up in the image changes. A fileset hash
  # rather than a timestamp, so a no-op apply does not push 500 MB.
  scheduler_sources = concat(
    [for f in fileset("${local.scheduler_repo_root}/cli/src", "**/*.ts") :
    "${local.scheduler_repo_root}/cli/src/${f}"],
    [
      "${local.scheduler_repo_root}/cli/package.json",
      "${local.scheduler_repo_root}/cli/bun.lock",
      "${local.scheduler_repo_root}/entrypoint/entrypoint.sh",
    ],
    [for f in fileset("${path.module}/lambda/scheduler", "*") :
    "${path.module}/lambda/scheduler/${f}"],
  )

  scheduler_src_hash = substr(
    sha1(join("", [for f in local.scheduler_sources : filesha1(f)])),
    0, 12,
  )

  scheduler_image = var.scheduler_enabled ? "${aws_ecr_repository.scheduler[0].repository_url}:${local.scheduler_src_hash}" : ""
}

# --- Image ---

resource "aws_ecr_repository" "scheduler" {
  count                = var.scheduler_enabled ? 1 : 0
  name                 = "${var.project_name}/scheduler"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "scheduler" {
  count      = var.scheduler_enabled ? 1 : 0
  repository = aws_ecr_repository.scheduler[0].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 scheduler images."
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

resource "null_resource" "scheduler_image" {
  count = var.scheduler_enabled ? 1 : 0

  triggers = {
    source = local.scheduler_src_hash
    image  = local.scheduler_image
  }

  provisioner "local-exec" {
    working_dir = local.scheduler_repo_root
    interpreter = ["/bin/sh", "-c"]
    command     = <<-CMD
      set -eu
      registry=${local.account_id}.dkr.ecr.${local.region}.amazonaws.com
      aws ecr get-login-password --region ${local.region} \
        | docker login --username AWS --password-stdin "$registry"
      docker build --platform linux/amd64 \
        -f terraform/aws/lambda/scheduler/Dockerfile \
        -t ${local.scheduler_image} .
      docker push ${local.scheduler_image}
    CMD
  }
}

# --- Role + policy ---
#
# Narrowed from the developer policy. Deliberately NOT granted: ssm:StartSession
# (with iam:PassRole already present it would let anything running on this
# principal become the VM role), ECR push, golden-image management,
# ssm:PutParameter, and any terminate — the scheduler does not kill.

resource "aws_iam_role" "scheduler" {
  count              = var.scheduler_enabled ? 1 : 0
  name               = "${var.project_name}-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "scheduler_basic_logging" {
  count      = var.scheduler_enabled ? 1 : 0
  role       = aws_iam_role.scheduler[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "LaunchIntoAfkSubnetsOnly"
    actions   = ["ec2:RunInstances"]
    resources = [local.ec2_subnet_arn]
    condition {
      test     = "StringEquals"
      variable = "ec2:Vpc"
      values   = [aws_vpc.afk.arn]
    }
  }

  statement {
    sid       = "LaunchWithAfkSgOnly"
    actions   = ["ec2:RunInstances"]
    resources = [local.ec2_sg_arn]
    condition {
      test     = "StringEquals"
      variable = "ec2:Vpc"
      values   = [aws_vpc.afk.arn]
    }
  }

  statement {
    sid       = "LaunchFromGoldenAmiOnly"
    actions   = ["ec2:RunInstances"]
    resources = [local.ec2_image_arn]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/afk:golden"
      values   = ["true"]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:Owner"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "LaunchInstanceWithWhitelistedType"
    actions   = ["ec2:RunInstances"]
    resources = [local.ec2_instance_arn]
    condition {
      test     = "StringEquals"
      variable = "ec2:InstanceType"
      values   = var.allowed_instance_types
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/afk:owner"
      values   = ["$${aws:userid}"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/afk:managed"
      values   = ["true"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/afk:run-id"
      values   = ["false"]
    }
  }

  statement {
    sid     = "LaunchAncillaryResources"
    actions = ["ec2:RunInstances"]
    resources = [
      local.ec2_volume_arn,
      local.ec2_nic_arn,
      local.ec2_keypair_arn,
    ]
  }

  statement {
    sid       = "TagAtLaunchOnly"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }

  statement {
    sid = "DescribeInfra"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeImages",
      "ec2:DescribeTags",
      "ec2:DescribeVpcs",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeAvailabilityZones",
    ]
    resources = ["*"]
  }

  # The critical lockdown, kept verbatim from the developer policy: without it
  # the scheduler could attach an arbitrary role to a Run VM.
  statement {
    sid       = "PassVmInstanceRoleOnly"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.vm_instance.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # Read-only on the registry: the scheduler launches images, never builds.
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ReadAfkEcrRepositories"
    actions = [
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:ListImages",
    ]
    resources = [local.ecr_repo_arn]
  }

  statement {
    sid = "ReadAndWriteSchedules"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [aws_dynamodb_table.schedule.arn]
  }

  # Writes a row at launch (recordStart); reads the rest to settle Entries.
  statement {
    sid = "RecordAndReadRunHistory"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.runs.arn,
      "${aws_dynamodb_table.runs.arn}/index/*",
    ]
  }

  # The git token the fire-time `git ls-remote` needs, plus the Run's own
  # secret references resolved into user_data at launch.
  statement {
    sid       = "ReadAfkSsmParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
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

  # A Run's CloudWatch group is created at launch when it does not yet exist.
  statement {
    sid = "EnsureRunLogGroups"
    actions = [
      "logs:CreateLogGroup",
      "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy",
    ]
    resources = [local.log_group_arn]
  }

  statement {
    sid       = "WhoAmI"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  count  = var.scheduler_enabled ? 1 : 0
  name   = "${var.project_name}-scheduler"
  role   = aws_iam_role.scheduler[0].id
  policy = data.aws_iam_policy_document.scheduler.json
}

# --- Lambda function ---

resource "aws_lambda_function" "scheduler" {
  count         = var.scheduler_enabled ? 1 : 0
  function_name = "${var.project_name}-scheduler"
  role          = aws_iam_role.scheduler[0].arn
  package_type  = "Image"
  image_uri     = local.scheduler_image
  architectures = ["x86_64"]
  # A tick launches every due Entry serially enough that a slow EC2 RunInstances
  # can take a while; still far inside Lambda's 15-minute ceiling.
  timeout     = 300
  memory_size = 1024

  environment {
    variables = {
      AFK_CONFIG_JSON     = var.scheduler_config_json
      AFK_ENV_FILE        = var.scheduler_env_file
      AFK_GIT_TOKEN_PARAM = var.scheduler_git_token_param
      AFK_GIT_HOST        = var.scheduler_git_host
      AFK_GIT_USER        = var.scheduler_git_user
    }
  }

  # Catch the mismatch at plan time rather than on every tick: without a host
  # the credential cannot be written, and every Entry's ref resolution fails.
  lifecycle {
    precondition {
      condition     = var.scheduler_git_token_param == "" || var.scheduler_git_host != ""
      error_message = "scheduler_git_host must name the forge host (e.g. gitlab.com) when scheduler_git_token_param is set."
    }
  }

  depends_on = [null_resource.scheduler_image]
}

# --- EventBridge tick ---
#
# This is the tick, not a Schedule: afk's own wake interval, identical for
# every project. `schedule_expression` is Terraform's word for it.

resource "aws_cloudwatch_event_rule" "scheduler" {
  count               = var.scheduler_enabled ? 1 : 0
  name                = "${var.project_name}-scheduler"
  description         = "Tick the AFK scheduler"
  schedule_expression = var.scheduler_tick_expression
}

resource "aws_cloudwatch_event_target" "scheduler" {
  count     = var.scheduler_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scheduler[0].name
  target_id = "${var.project_name}-scheduler"
  arn       = aws_lambda_function.scheduler[0].arn
}

resource "aws_lambda_permission" "scheduler_eventbridge" {
  count         = var.scheduler_enabled ? 1 : 0
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scheduler[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scheduler[0].arn
}
