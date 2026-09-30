import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
const terminal = ['COMPLETED', 'PARTIAL', 'NO_RESULTS', 'FAILED', 'CANCELLED'];

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
  async transition(run: Run, status: string, output?: unknown) {
    await this.db.query(
      'UPDATE runs SET status=$4,output=COALESCE($5::jsonb,output),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND NOT(status=ANY($6::text[]))',
      [
        run.id,
        run.tenant_id,
        run.project_id,
        status,
        output === undefined ? null : JSON.stringify(output),
        terminal,
      ],
    );
  }
  async markDispatched(run: Run) {
    await this.db.query(
      "UPDATE runs SET dispatch_state='DISPATCHED',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND project_id=$3",
      [run.id, run.tenant_id, run.project_id],
    );
  }
  async active(): Promise<Run[]> { return this.db.query<Run>("SELECT * FROM runs WHERE dispatch_state='DISPATCHED' AND status IN ('QUEUED','RUNNING') ORDER BY updated_at LIMIT 50"); }
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
  async saveEvidence(run: Run, url: string, data: unknown, sourceId?: string) {
    await this.db.query(
      'INSERT INTO evidence(id,run_id,source_result_id,url,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,url) DO UPDATE SET data=EXCLUDED.data',
      [randomUUID(), run.id, sourceId || null, url, data],
    );
  }
}
