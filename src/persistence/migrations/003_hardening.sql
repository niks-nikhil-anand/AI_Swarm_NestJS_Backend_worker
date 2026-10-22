-- Execution lease: one attempt executes a run at a time. A new attempt may take over
-- only after the previous owner stopped renewing (lease expired).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Replayed steps reuse their artifact instead of storing a duplicate.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_idempotency_idx
  ON artifacts (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
