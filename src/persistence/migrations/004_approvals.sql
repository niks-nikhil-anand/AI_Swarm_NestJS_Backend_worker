-- A run waiting for an approval decision holds no browser session or lease.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN
  ('QUEUED','RUNNING','AWAITING_APPROVAL','COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED'));

-- Approval of one consequential step, bound to the exact action and page state.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS step integer;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS action jsonb;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS page_hash text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS page_url text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_reason text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_by text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS audit jsonb NOT NULL DEFAULT '[]';
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN
  ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED','REVOKED','CONSUMED'));
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_outcome_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_check CHECK (outcome IS NULL OR outcome IN
  ('SUCCEEDED','FAILED','UNKNOWN'));
-- One approval per run step: a repeated request returns the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_run_step_idx ON approvals (run_id, step);
CREATE INDEX IF NOT EXISTS approvals_scope_idx ON approvals (tenant_id, project_id, id);
