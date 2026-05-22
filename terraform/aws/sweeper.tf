# ---------------------------------------------------------------------------
# Sweeper Lambda — terminates AFK-managed EC2 instances past their timeout.
# Backstop for crashed agents that never reached `shutdown -h now`.
#
# Code lives in lambda/sweeper/. Built with esbuild at `terraform apply` time
# via the null_resource below.
# ---------------------------------------------------------------------------

locals {
  sweeper_src_dir = "${path.module}/lambda/sweeper"
  sweeper_dist    = "${path.module}/lambda/sweeper/dist/index.js"
}

resource "null_resource" "sweeper_build" {
  triggers = {
    source = filesha256("${local.sweeper_src_dir}/index.ts")
    pkg    = filesha256("${local.sweeper_src_dir}/package.json")
  }

  provisioner "local-exec" {
    working_dir = local.sweeper_src_dir
    command     = "npm install --silent && npm run build --silent"
  }
}

data "archive_file" "sweeper" {
  type        = "zip"
  source_file = local.sweeper_dist
  output_path = "${path.module}/lambda/sweeper/dist/sweeper.zip"

  depends_on = [null_resource.sweeper_build]
}

# --- Role + policy ---

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sweeper" {
  name               = "${var.project_name}-sweeper-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sweeper_basic_logging" {
  role       = aws_iam_role.sweeper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "sweeper" {
  statement {
    sid       = "DescribeAllInstances"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "TerminateAfkManagedOnly"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/afk:managed"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "sweeper" {
  name   = "${var.project_name}-sweeper"
  role   = aws_iam_role.sweeper.id
  policy = data.aws_iam_policy_document.sweeper.json
}

# --- Lambda function ---

resource "aws_lambda_function" "sweeper" {
  function_name    = "${var.project_name}-sweeper"
  role             = aws_iam_role.sweeper.arn
  filename         = data.archive_file.sweeper.output_path
  source_code_hash = data.archive_file.sweeper.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      SWEEPER_GRACE_MINUTES = tostring(var.sweeper_grace_minutes)
    }
  }
}

# --- EventBridge schedule ---

resource "aws_cloudwatch_event_rule" "sweeper" {
  name                = "${var.project_name}-sweeper"
  description         = "Trigger AFK sweeper Lambda"
  schedule_expression = var.sweeper_schedule_expression
}

resource "aws_cloudwatch_event_target" "sweeper" {
  rule      = aws_cloudwatch_event_rule.sweeper.name
  target_id = "${var.project_name}-sweeper"
  arn       = aws_lambda_function.sweeper.arn
}

resource "aws_lambda_permission" "sweeper_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweeper.arn
}
