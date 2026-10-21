-- Baseline the existing run-domain schema without changing its semantics.
-- Existing databases require reviewed baselining; see documentation/DATABASE_SETUP.md.
BEGIN;
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL, project_id text NOT NULL, user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('search','browser','research')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED')),
  input jsonb NOT NULL, input_hash text NOT NULL, output jsonb,
  idempotency_key text NOT NULL, dispatch_state text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,project_id,kind,idempotency_key)
);
CREATE INDEX runs_project_idx ON runs (tenant_id,project_id,created_at);
CREATE TABLE search_queries (
  run_id uuid NOT NULL REFERENCES runs(id), query_index integer NOT NULL,
  query text NOT NULL, status text NOT NULL, warning_codes jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id,query_index)
);
CREATE TABLE search_results (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), query_index integer NOT NULL,
  canonical_url text NOT NULL, data jsonb NOT NULL,
  UNIQUE (run_id,query_index,canonical_url),
  FOREIGN KEY (run_id,query_index) REFERENCES search_queries(run_id,query_index)
);
CREATE TABLE browser_actions (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL, kind text NOT NULL, status text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id,sequence)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  object_key text NOT NULL UNIQUE, mime_type text NOT NULL, size bigint NOT NULL,
  checksum text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE evidence (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), source_result_id uuid REFERENCES search_results(id),
  url text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id,url)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  payload_hash text NOT NULL, status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL, decision_by text
);
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('001');
COMMIT;
