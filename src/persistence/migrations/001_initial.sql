CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL, project_id text NOT NULL, user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('search','browser','research')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED')),
  input jsonb NOT NULL, input_hash text NOT NULL, output jsonb,
  idempotency_key text NOT NULL, dispatch_state text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,project_id,kind,idempotency_key)
);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs (tenant_id,project_id,created_at);
CREATE TABLE IF NOT EXISTS search_queries (
  run_id uuid NOT NULL REFERENCES runs(id), query_index integer NOT NULL,
  query text NOT NULL, status text NOT NULL, warning_codes jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id,query_index)
);
CREATE TABLE IF NOT EXISTS search_results (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), query_index integer NOT NULL,
  canonical_url text NOT NULL, data jsonb NOT NULL,
  UNIQUE (run_id,query_index,canonical_url),
  FOREIGN KEY (run_id,query_index) REFERENCES search_queries(run_id,query_index)
);
CREATE TABLE IF NOT EXISTS browser_actions (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL, kind text NOT NULL, status text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id,sequence)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  object_key text NOT NULL UNIQUE, mime_type text NOT NULL, size bigint NOT NULL,
  checksum text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), source_result_id uuid REFERENCES search_results(id),
  url text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id,url)
);
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id),
  payload_hash text NOT NULL, status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL, decision_by text
);
