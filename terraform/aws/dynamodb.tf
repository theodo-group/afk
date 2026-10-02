# ---------------------------------------------------------------------------
# DynamoDB table — persistent Run history.
#
# Rows are written by the CLI at `afk run` time and completed by the Run VM
# itself, which records its exit code from user_data just before shutting down.
# The sweeper Lambda is the backstop: it reconciles the rows of VMs that died
# without getting that far, and it loses the race deliberately — both writers
# condition on `status = running`, so the first one to land keeps the row.
# EC2's DescribeInstances only retains terminated instances for ~1 hour, so
# this table is the system of record for "what Runs happened beyond the last
# hour."
#
# Schema:
#   pk:       run_id                              (canonical lookup)
#   GSI1:     owner + started_at_iso              ("my runs in the last week")
#   GSI2:     repo  + started_at_iso              ("runs for this repo")
#
# Other attributes (not indexed): branch, sha, image, instance_type, spot,
# status, exit_code, stopped_at, instance_id, timeout_hours.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "runs" {
  name         = "${var.project_name}-runs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "run_id"

  attribute {
    name = "run_id"
    type = "S"
  }

  attribute {
    name = "owner"
    type = "S"
  }

  attribute {
    name = "repo"
    type = "S"
  }

  attribute {
    name = "started_at"
    type = "S"
  }

  global_secondary_index {
    name            = "by-owner"
    hash_key        = "owner"
    range_key       = "started_at"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by-repo"
    hash_key        = "repo"
    range_key       = "started_at"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = false
  }
}

# ---------------------------------------------------------------------------
# DynamoDB table — submitted Schedules.
#
# Written by `afk schedule submit` from a developer's laptop and by the
# orchestrator Lambda on every tick. One Schedule's Entries share a partition,
# so reading one back is a single Query; the tick reads every Entry with a
# Scan, which stays cheap because terminal Entries are the only thing that
# accumulates and a Schedule holds a handful of them.
#
# Schema:
#   pk:  schedule_id                       (the `schedule:` id in the file)
#   sk:  entry_id                          (unique within that Schedule)
#
# Other attributes: state, trigger (JSON string — DynamoDB maps are not worth
# widening the CLI's AttrValue for), ref, command, image, owner, timeout_hours,
# on_demand, instance_type, submitted_at, not_before, run_id, launched_at,
# settled_at, outcome, reason.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "schedule" {
  name         = "${var.project_name}-schedule"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "schedule_id"
  range_key    = "entry_id"

  attribute {
    name = "schedule_id"
    type = "S"
  }

  attribute {
    name = "entry_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }
}
