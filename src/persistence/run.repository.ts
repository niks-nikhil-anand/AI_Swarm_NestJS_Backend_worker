import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from './database.service';
import type { ExecutionContext } from '../common/types/execution-context';
import { ServiceError } from '../common/errors/service.error';

export type RunKind = 'search' | 'browser' | 'research';
export interface Run {
  id: string;
  tenant_id: string;
  project_id: string;
  user_id: string;
  kind: RunKind;
  status: string;
  input: Record<string, unknown>;
  input_hash: string;
  output: unknown;
  dispatch_state: string;
}
export interface Extraction {
  step: number;
  url: string;
  instruction: string;
  schemaHash: string;
  schema: unknown;
  data: unknown;
  missing: string[];
  evidenceId: string;
  modelCalls: number;
  modelTokens: number;
  retrievedAt: string;
}
const terminal = ['COMPLETED', 'PARTIAL', 'NO_RESULTS', 'FAILED', 'CANCELLED'];
// Valid run lifecycle: QUEUED → RUNNING → COMPLETED | PARTIAL | NO_RESULTS | FAILED | CANCELLED,
// with RUNNING ⇄ AWAITING_APPROVAL while a consequential step waits for a decision.
export const RUN_TRANSITIONS: Record<string, readonly string[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['RUNNING', 'AWAITING_APPROVAL', ...terminal],
  AWAITING_APPROVAL: ['RUNNING', 'PARTIAL', 'FAILED', 'CANCELLED'],
};

@Injectable()
export class RunRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(
    ctx: ExecutionContext,
    kind: RunKind,
    input: Record<string, unknown>,
    key: string,
  ): Promise<Run> {
    const hash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const rows = await this.db.query<Run>(
      'INSERT INTO runs(id,tenant_id,project_id,user_id,kind,input,input_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,project_id,kind,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *',
      [
        randomUUID(),
        ctx.tenantId,
        ctx.projectId,
        ctx.userId,
        kind,
        input,
        hash,
        key,
      ],
    );
    if (rows[0].input_hash !== hash)
      throw new ServiceError(
        'IDEMPOTENCY_CONFLICT',
        'Key already used for a different request',
        409,
      );
    return rows[0];
  }
  async get(id: string, tenantId: string, projectId: string): Promise<Run> {
    const rows = await this.db.query<Run>(
      'SELECT * FROM runs WHERE id=$1 AND tenant_id=$2 AND project_id=$3',
      [id, tenantId, projectId],
    );
    if (!rows[0]) throw new ServiceError('RUN_NOT_FOUND', 'Run not found', 404);
    return rows[0];
  }
  /**
   * Applies a lifecycle transition if it is valid from the run's current status, and
   * reports whether it did. Terminal statuses never change; RUNNING → RUNNING is an
   * idempotent re-entry by a retried attempt.
   */
  async transition(run: Run, status: string, output?: unknown) {
    const from = Object.keys(RUN_TRANSITIONS).filter((source) =>
      RUN_TRANSITIONS[source].includes(status),
    );
    if (!from.length) throw new Error('Invalid run status ' + status);
    const rows = await this.db.query(
      // A finished or approval-waiting run holds no lease. Releasing it in the same
      // statement means a database failure right after the transition cannot leave it
      // held (the attempt's own release would otherwise be a second write).
      'UPDATE runs SET status=$4,output=COALESCE($5::jsonb,output),updated_at=now(),lease_owner=CASE WHEN $4=ANY($7::text[]) THEN NULL ELSE lease_owner END,lease_expires_at=CASE WHEN $4=ANY($7::text[]) THEN NULL ELSE lease_expires_at END WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND status=ANY($6::text[]) RETURNING id',
      [
        run.id,
        run.tenant_id,
        run.project_id,
        status,
        output === undefined ? null : JSON.stringify(output),
        from,
        [...terminal, 'AWAITING_APPROVAL'],
      ],
    );
    return rows.length > 0;
  }
  // Partial output for a run that ended (cancelled, failed) without a final output.
  async recordTerminalOutput(run: Run, output: unknown) {
    await this.db.query(
      'UPDATE runs SET output=$4::jsonb,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND status=ANY($5::text[]) AND output IS NULL',
      [run.id, run.tenant_id, run.project_id, JSON.stringify(output), terminal],
    );
  }
  /**
   * Execution lease: one attempt runs a run at a time. Taken when free, already owned,
   * or expired (the previous owner stopped renewing); never for a terminal run.
   */
  async claimLease(run: Run, owner: string, ttlMs: number) {
    const rows = await this.db.query(
      'UPDATE runs SET lease_owner=$4,lease_expires_at=now()+make_interval(secs=>$5::double precision/1000) WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND NOT(status=ANY($6::text[])) AND (lease_owner IS NULL OR lease_owner=$4 OR lease_expires_at<now()) RETURNING id',
      [run.id, run.tenant_id, run.project_id, owner, ttlMs, terminal],
    );
    return rows.length > 0;
  }
  // Returns the run status when still owned (so the owner also learns about a
  // cancellation), or undefined when the lease was lost.
  async renewLease(run: Run, owner: string, ttlMs: number) {
    const rows = await this.db.query<{ status: string }>(
      'UPDATE runs SET lease_expires_at=now()+make_interval(secs=>$5::double precision/1000) WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND lease_owner=$4 RETURNING status',
      [run.id, run.tenant_id, run.project_id, owner, ttlMs],
    );
    return rows[0]?.status;
  }
  async releaseLease(run: Run, owner: string) {
    await this.db.query(
      'UPDATE runs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND lease_owner=$4',
      [run.id, run.tenant_id, run.project_id, owner],
    );
  }
  async markDispatched(run: Run) {
    await this.db.query(
      "UPDATE runs SET dispatch_state='DISPATCHED',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND project_id=$3",
      [run.id, run.tenant_id, run.project_id],
    );
  }
  async active(): Promise<Run[]> {
    return this.db.query<Run>(
      "SELECT * FROM runs WHERE dispatch_state='DISPATCHED' AND status IN ('QUEUED','RUNNING','AWAITING_APPROVAL') ORDER BY updated_at LIMIT 50",
    );
  }
  // Waiting runs whose approval was decided or ran out: their workflow must be woken.
  async awaitingDecision(): Promise<Run[]> {
    return this.db.query<Run>(
      "SELECT r.* FROM runs r JOIN approvals a ON a.run_id=r.id WHERE r.status='AWAITING_APPROVAL' AND r.dispatch_state='DISPATCHED' AND (a.status<>'PENDING' OR a.expires_at<=now()) ORDER BY r.updated_at LIMIT 50",
    );
  }
  async pending(): Promise<Run[]> {
    return this.db.query<Run>(
      "SELECT * FROM runs WHERE dispatch_state='PENDING' AND status='QUEUED' ORDER BY created_at LIMIT 50",
    );
  }
  async results(run: Run) {
    return this.db.query(
      "SELECT id,data FROM search_results WHERE run_id=$1 ORDER BY query_index,(data->>'rank')::integer",
      [run.id],
    );
  }
  async saveEvidence(
    run: Run,
    url: string,
    data: unknown,
    sourceId?: string,
    db: Pick<DatabaseService, 'query'> = this.db,
  ) {
    const rows = await db.query<{ id: string }>(
      'INSERT INTO evidence(id,run_id,source_result_id,url,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,url) DO UPDATE SET data=EXCLUDED.data RETURNING id',
      [randomUUID(), run.id, sourceId || null, url, data],
    );
    return rows[0].id;
  }
  /**
   * Source evidence and the extraction made from it, in one transaction: an extraction
   * never exists without the evidence of the page it came from, and a replayed step
   * updates both rows instead of adding new ones.
   */
  async saveSourcedExtraction(
    run: Run,
    url: string,
    evidence: unknown,
    extraction: Omit<Extraction, 'evidenceId'>,
  ) {
    return this.db.transaction(async (client) => {
      const tx = {
        query: async <T extends QueryResultRow>(
          text: string,
          values: unknown[],
        ) => (await client.query<T>(text, values)).rows,
      };
      const evidenceId = await this.saveEvidence(
        run,
        url,
        evidence,
        undefined,
        tx,
      );
      const extractionId = await this.saveExtraction(
        run,
        { ...extraction, evidenceId },
        tx,
      );
      return { evidenceId, extractionId };
    });
  }
  // One result per run step; a replayed step overwrites its earlier result.
  async saveExtraction(
    run: Run,
    extraction: Extraction,
    db: Pick<DatabaseService, 'query'> = this.db,
  ) {
    const rows = await db.query<{ id: string }>(
      'INSERT INTO extractions(id,run_id,tenant_id,project_id,step,url,instruction,schema_hash,schema,data,missing,evidence_id,model_calls,model_tokens,retrieved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(run_id,step) DO UPDATE SET url=EXCLUDED.url,data=EXCLUDED.data,missing=EXCLUDED.missing,evidence_id=EXCLUDED.evidence_id,model_calls=EXCLUDED.model_calls,model_tokens=EXCLUDED.model_tokens,retrieved_at=EXCLUDED.retrieved_at RETURNING id',
      [
        randomUUID(),
        run.id,
        run.tenant_id,
        run.project_id,
        extraction.step,
        extraction.url,
        extraction.instruction,
        extraction.schemaHash,
        JSON.stringify(extraction.schema),
        JSON.stringify(extraction.data),
        JSON.stringify(extraction.missing),
        extraction.evidenceId,
        extraction.modelCalls,
        extraction.modelTokens,
        extraction.retrievedAt,
      ],
    );
    return rows[0].id;
  }
  // Scoped by tenant and project as well as run: ownership is checked in the query.
  async extractions(run: Run) {
    return this.db.query(
      "SELECT x.id,x.step,x.url,x.instruction,x.schema_hash AS \"schemaHash\",x.data,x.missing,x.model_calls AS \"modelCalls\",x.model_tokens AS \"modelTokens\",x.retrieved_at AS \"retrievedAt\",json_build_object('id',e.id,'url',e.url,'title',e.data->>'title','retrievedAt',e.data->>'retrievedAt') AS evidence FROM extractions x LEFT JOIN evidence e ON e.id=x.evidence_id WHERE x.run_id=$1 AND x.tenant_id=$2 AND x.project_id=$3 ORDER BY x.step",
      [run.id, run.tenant_id, run.project_id],
    );
  }
}
