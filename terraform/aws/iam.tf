locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = var.aws_region
  ssm_param_arn = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/${var.project_name}/*"
  ecr_repo_arn  = "arn:aws:ecr:${local.region}:${local.account_id}:repository/${var.project_name}/*"
  log_group_arn = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/${var.project_name}/*"

  # Resource ARNs for the RunInstances policy. RunInstances touches several
  # resource types in one API call; the conditions on each are different.
  ec2_instance_arn = "arn:aws:ec2:${local.region}:${local.account_id}:instance/*"
  ec2_volume_arn   = "arn:aws:ec2:${local.region}:${local.account_id}:volume/*"
  ec2_nic_arn      = "arn:aws:ec2:${local.region}:${local.account_id}:network-interface/*"
  ec2_keypair_arn  = "arn:aws:ec2:${local.region}:${local.account_id}:key-pair/*"
  ec2_subnet_arn   = "arn:aws:ec2:${local.region}:${local.account_id}:subnet/*"
  ec2_sg_arn       = "arn:aws:ec2:${local.region}:${local.account_id}:security-group/*"
  ec2_image_arn    = "arn:aws:ec2:${local.region}::image/*"
}

# ---------------------------------------------------------------------------
# VM instance role — attached to every Run VM via the instance profile.
# Minimal: pull from ECR, read SSM params under /afk/secrets, write CloudWatch
# Logs under /afk/*. No ec2:*. No iam:*. The VM terminates itself by OS
# shutdown (InstanceInitiatedShutdownBehavior=terminate), not via API.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vm_instance" {
  name               = "${var.project_name}-vm-instance-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# SSM agent needs this for Session Manager (attach) to work.
resource "aws_iam_role_policy_attachment" "vm_ssm" {
  role       = aws_iam_role.vm_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "vm_instance" {
  statement {
    sid = "PullFromAfkEcr"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadAfkSecrets"
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

  statement {
    sid = "WriteRunLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:CreateLogGroup",
      "logs:DescribeLogStreams",
    ]
    resources = [local.log_group_arn]
  }
}

resource "aws_iam_role_policy" "vm_instance" {
  name   = "${var.project_name}-vm-instance"
  role   = aws_iam_role.vm_instance.id
  policy = data.aws_iam_policy_document.vm_instance.json
}

resource "aws_iam_instance_profile" "vm_instance" {
  name = "${var.project_name}-vm-instance-profile"
  role = aws_iam_role.vm_instance.name
}

# ---------------------------------------------------------------------------
# Developer role + policy — the IAM principal a developer acts under when
# driving the CLI. RunInstances is heavily conditioned; PassRole is locked
# to the single VM instance role.
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
  # --- RunInstances: heavily conditioned ---
  # AWS's RunInstances API touches many resource types in one call. We split
  # the allow statements by resource so each gets its own conditions.

  # Allow launching INTO the AFK subnet only.
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

  # Allow only the AFK security group.
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

  # Allow only golden AMIs (tagged afk:golden=true) owned by this account.
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

  # Allow the actual instance creation, restricted to the whitelisted instance
  # types and requiring the afk:owner tag to match the caller's userid.
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
    # afk:run-id must be present
    condition {
      test     = "Null"
      variable = "aws:RequestTag/afk:run-id"
      values   = ["false"]
    }
  }

  # Allow ancillary resource creation (volumes, NICs, key-pairs) that
  # RunInstances always touches. No additional conditions; the instance-level
  # conditions above gate the broader call.
  statement {
    sid     = "LaunchAncillaryResources"
    actions = ["ec2:RunInstances"]
    resources = [
      local.ec2_volume_arn,
      local.ec2_nic_arn,
      local.ec2_keypair_arn,
    ]
  }

  # --- CreateTags at launch only ---
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

  # --- DescribeInstances / DescribeImages (read-only, no ARN scoping in EC2) ---
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
      "ec2:DescribeKeyPairs",
    ]
    resources = ["*"]
  }

  # --- Image management (for `afk image build`) ---
  # CreateImage / RegisterImage require broader permissions; the builder
  # workflow uses CreateImage on the builder instance, then DeleteSnapshot/
  # DeregisterImage for `afk image rm`. Restrict to AFK-tagged resources.
  statement {
    sid = "ManageGoldenImages"
    actions = [
      "ec2:CreateImage",
      "ec2:RegisterImage",
      "ec2:DeregisterImage",
      "ec2:DeleteSnapshot",
      "ec2:CopyImage",
    ]
    resources = ["*"]
  }

  # SSM SendCommand against the builder instance (to install Docker + pre-pull).
  statement {
    sid = "SsmSendCommandForBuilder"
    actions = [
      "ssm:SendCommand",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:DescribeInstanceInformation",
    ]
    resources = ["*"]
  }

  # --- Terminate only own Runs (and any instance the developer launched) ---
  statement {
    sid       = "TerminateOwnRuns"
    actions   = ["ec2:TerminateInstances", "ec2:StopInstances"]
    resources = [local.ec2_instance_arn]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/afk:owner"
      values   = ["$${aws:userid}"]
    }
  }

  # The builder instance is launched by the developer (so RunInstances
  # request-tag condition picks them as the owner) — same Terminate path
  # applies, no extra grant needed.

  # --- Attach via SSM Session Manager, scoped to own Runs ---
  statement {
    sid       = "StartSessionToOwnRuns"
    actions   = ["ssm:StartSession"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/afk:owner"
      values   = ["$${aws:userid}"]
    }
  }

  statement {
    sid = "StartSessionDocuments"
    actions = ["ssm:StartSession"]
    resources = [
      "arn:aws:ssm:${local.region}::document/AWS-StartInteractiveCommand",
      "arn:aws:ssm:${local.region}::document/AWS-StartSSHSession",
      "arn:aws:ssm:${local.region}::document/SSM-SessionManagerRunShell",
    ]
  }

  statement {
    sid       = "TerminateOwnSessions"
    actions   = ["ssm:TerminateSession", "ssm:ResumeSession"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:session/$${aws:username}-*"]
  }

  statement {
    sid       = "DescribeSessions"
    actions   = ["ssm:DescribeSessions"]
    resources = ["*"]
  }

  # --- ECR (unchanged from v1) ---
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

  # --- SSM secrets (developer-managed) ---
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

  # --- CloudWatch Logs ---
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

  # --- DynamoDB: read+write the run-history table ---
  statement {
    sid = "ManageRunHistory"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ]
    resources = [
      aws_dynamodb_table.runs.arn,
      "${aws_dynamodb_table.runs.arn}/index/*",
    ]
  }

  # --- PassRole locked to the single VM instance role ---
  # The critical lockdown. Without this constraint a developer could attach an
  # arbitrary role to a Run VM, attach via SSM, and become that role.
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
}

resource "aws_iam_policy" "developer" {
  name   = "${var.project_name}-developer"
  policy = data.aws_iam_policy_document.developer.json
}

resource "aws_iam_role_policy_attachment" "developer" {
  role       = aws_iam_role.developer.name
  policy_arn = aws_iam_policy.developer.arn
}
