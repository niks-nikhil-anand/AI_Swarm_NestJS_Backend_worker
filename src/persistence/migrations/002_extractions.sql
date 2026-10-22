-- Caller-defined structured extraction results, linked to the run, tenant and the
-- evidence row holding the source page text they were extracted from.
CREATE TABLE IF NOT EXISTS extractions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  tenant_id text NOT NULL, project_id text NOT NULL,
  step integer NOT NULL,
  url text NOT NULL,
  instruction text NOT NULL,
  schema_hash text NOT NULL, schema jsonb NOT NULL,
  data jsonb NOT NULL,
  missing jsonb NOT NULL DEFAULT '[]',
  evidence_id uuid REFERENCES evidence(id),
  model_calls integer NOT NULL, model_tokens integer NOT NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step)
);
CREATE INDEX IF NOT EXISTS extractions_project_idx ON extractions (tenant_id, project_id, run_id);
