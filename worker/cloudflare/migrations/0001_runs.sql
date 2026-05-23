-- D1 schema for Run history. Applied via `wrangler d1 execute … --file=…`
-- as part of the `afk init --provider cloudflare` bootstrap.

CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  branch         TEXT,
  sha            TEXT,
  image          TEXT,
  resource_id    TEXT,
  status         TEXT NOT NULL,        -- RUNNING | STOPPED
  started_at     TEXT NOT NULL,        -- ISO 8601
  stopped_at     TEXT,
  exit_code      INTEGER,
  timeout_hours  REAL NOT NULL,
  backend_details TEXT                 -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_runs_owner_started ON runs(owner, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_branch_started ON runs(branch, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
