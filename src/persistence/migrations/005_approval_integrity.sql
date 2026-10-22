-- Database-enforced approval integrity (Phase 6). The application changes approvals only
-- through conditional UPDATEs; these rules hold even for a faulty or concurrent writer.

CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are retained for audit' USING ERRCODE = 'check_violation';
  END IF;
  -- What was requested and reviewed never changes; expiry can only move earlier.
  IF NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.step IS DISTINCT FROM OLD.step
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.page_hash IS DISTINCT FROM OLD.page_hash
     OR NEW.page_url IS DISTINCT FROM OLD.page_url
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('CONSUMED', 'REVOKED', 'EXPIRED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'approval transition % -> % denied', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The decision, the consumption and the outcome are each recorded once.
  IF (OLD.decision_by IS NOT NULL AND NEW.decision_by IS DISTINCT FROM OLD.decision_by)
     OR (OLD.consumed_by IS NOT NULL AND (NEW.consumed_by IS DISTINCT FROM OLD.consumed_by
         OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at))
     OR (OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'approval decision, consumption and outcome are write-once'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The audit trail is append-only.
  IF jsonb_array_length(NEW.audit) < jsonb_array_length(OLD.audit) THEN
    RAISE EXCEPTION 'approval audit is append-only' USING ERRCODE = 'check_violation';
  END IF;
  FOR i IN 0 .. jsonb_array_length(OLD.audit) - 1 LOOP
    IF NEW.audit -> i IS DISTINCT FROM OLD.audit -> i THEN
      RAISE EXCEPTION 'approval audit is append-only' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS approvals_guard ON approvals;
CREATE TRIGGER approvals_guard BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_guard();

-- State consistency. NOT VALID: enforced for every new or changed row without failing on
-- rows written by an earlier schema.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_bound_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_bound_check CHECK (
  tenant_id IS NOT NULL AND project_id IS NOT NULL AND step IS NOT NULL
  AND action IS NOT NULL AND page_hash IS NOT NULL AND requested_by IS NOT NULL) NOT VALID;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_decided_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_decided_check CHECK (
  status NOT IN ('APPROVED', 'REJECTED', 'REVOKED', 'CONSUMED')
  OR (decision_by IS NOT NULL AND decided_at IS NOT NULL)) NOT VALID;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_consumed_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_consumed_check CHECK (
  (status = 'CONSUMED') = (consumed_at IS NOT NULL AND consumed_by IS NOT NULL)) NOT VALID;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_outcome_state_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_state_check CHECK (
  outcome IS NULL OR status = 'CONSUMED') NOT VALID;
