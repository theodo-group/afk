# ---------------------------------------------------------------------------
# DynamoDB table — persistent Run history.
#
# Rows are written by the CLI at `afk run` time and updated by the sweeper
# Lambda when EC2 reports the instance terminated. EC2's DescribeInstances
# only retains terminated instances for ~1 hour, so this table is the
# system of record for "what Runs happened beyond the last hour."
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
