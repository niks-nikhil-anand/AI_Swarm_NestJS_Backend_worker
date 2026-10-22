import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database.service';
import type { Run } from './run.repository';
import { ServiceError } from '../common/errors/service.error';

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REVOKED'
  | 'CONSUMED';
export type ApprovalOutcome = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
export interface Approval {
  id: string;
  run_id: string;
  tenant_id: string;
  project_id: string;
  step: number;
  action: Record<string, unknown>;
  payload_hash: string;
  page_hash: string;
  page_url: string;
  status: ApprovalStatus;
  requested_by: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decision_by: string | null;
  decision_reason: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  outcome: ApprovalOutcome | null;
  audit: { at: string; event: string; actor: string; detail?: string }[];
}
// The action, its target and the page state the approver reviews; no field values.
export interface ApprovalProposal {
  action: Record<string, unknown>;
  payloadHash: string;
  pageHash: string;
  pageUrl: string;
}
// Audit entries hold an event, the acting principal (or worker/system) and a short,
// sanitized detail. They never contain page field values, cookies or credentials.
const entry = (event: string, actor: string, detail?: string) =>
  JSON.stringify([
    {
      at: new Date().toISOString(),
      event,
      actor,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    },
  ]);
export const OPEN_APPROVAL: ApprovalStatus[] = ['PENDING', 'APPROVED'];

/**
 * Durable approvals. Every change is one conditional UPDATE on the expected previous
 * status, scoped by tenant and project, so concurrent requests cannot both succeed.
 */
@Injectable()
export class ApprovalRepository {
  constructor(private readonly db: DatabaseService) {}

  // Idempotent per run step: a repeated request returns the existing approval.
  async request(
    run: Run,
    step: number,
    proposal: ApprovalProposal,
    ttlMs: number,
  ) {
    await this.db.query(
      "INSERT INTO approvals(id,run_id,tenant_id,project_id,step,action,payload_hash,page_hash,page_url,status,requested_by,expires_at,audit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,now()+make_interval(secs=>$11::double precision/1000),$12::jsonb) ON CONFLICT (run_id,step) DO NOTHING",
      [
        randomUUID(),
        run.id,
        run.tenant_id,
        run.project_id,
        step,
        JSON.stringify(proposal.action),
        proposal.payloadHash,
        proposal.pageHash,
        proposal.pageUrl,
        run.user_id,
        ttlMs,
        entry('requested', 'worker', 'step ' + step),
      ],
    );
    return (await this.forStep(run, step))!;
  }
  // Scoped lookup: an id alone never finds another tenant's or project's approval.
  async get(id: string, tenantId: string, projectId: string) {
    const rows = await this.db.query<Approval>(
      'SELECT * FROM approvals WHERE id=$1 AND tenant_id=$2 AND project_id=$3',
      [id, tenantId, projectId],
    );
    if (!rows[0])
      throw new ServiceError('APPROVAL_NOT_FOUND', 'Approval not found', 404);
    return rows[0];
  }
  async forStep(run: Run, step: number) {
    return (
      await this.db.query<Approval>(
        'SELECT * FROM approvals WHERE run_id=$1 AND tenant_id=$2 AND project_id=$3 AND step=$4',
        [run.id, run.tenant_id, run.project_id, step],
      )
    )[0];
  }
  async forRun(run: Run) {
    return this.db.query<Approval>(
      'SELECT * FROM approvals WHERE run_id=$1 AND tenant_id=$2 AND project_id=$3 ORDER BY step',
      [run.id, run.tenant_id, run.project_id],
    );
  }
  private async change(
    approval: Pick<Approval, 'id' | 'tenant_id' | 'project_id'>,
    set: string,
    where: string,
    values: unknown[],
    event: string,
    actor: string,
    detail?: string,
  ) {
    const rows = await this.db.query<Approval>(
      `UPDATE approvals SET ${set}, audit=audit||$4::jsonb WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND ${where} RETURNING *`,
      [
        approval.id,
        approval.tenant_id,
        approval.project_id,
        entry(event, actor, detail),
        ...values,
      ],
    );
    return rows[0];
  }
  // Marks a pending or approved approval expired once its deadline passed.
  expireIfDue(approval: Approval, actor = 'system') {
    return this.change(
      approval,
      "status='EXPIRED'",
      "status IN ('PENDING','APPROVED') AND expires_at<=now()",
      [],
      'expired',
      actor,
    );
  }
  // Decision by an authenticated approver on the exact payload they reviewed.
  decide(
    approval: Approval,
    decision: 'APPROVED' | 'REJECTED',
    approver: string,
    payloadHash: string,
    reason?: string,
  ) {
    return this.change(
      approval,
      'status=$5,decision_by=$6,decided_at=now(),decision_reason=$7',
      "status='PENDING' AND expires_at>now() AND payload_hash=$8",
      [decision, approver, reason?.slice(0, 300) ?? null, payloadHash],
      decision === 'APPROVED' ? 'approved' : 'rejected',
      approver,
      reason,
    );
  }
  // Withdraws an approval that has not been used: PENDING → CANCELLED, APPROVED → REVOKED.
  revoke(approval: Approval, actor: string, reason?: string) {
    return this.change(
      approval,
      "status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE 'REVOKED' END,decided_at=COALESCE(decided_at,now()),decision_reason=COALESCE($5,decision_reason)",
      "status IN ('PENDING','APPROVED')",
      [reason?.slice(0, 300) ?? null],
      'revoked',
      actor,
      reason,
    );
  }
  /**
   * Single use: succeeds only for this run, tenant, project and step, while APPROVED and
   * unexpired, and only if the action and page are exactly what was approved.
   */
  async consume(
    run: Run,
    step: number,
    id: string,
    payloadHash: string,
    pageHash: string,
    attemptId: string,
  ) {
    const rows = await this.db.query<Approval>(
      "UPDATE approvals SET status='CONSUMED',consumed_at=now(),consumed_by=$7,audit=audit||$8::jsonb WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND project_id=$4 AND step=$5 AND status='APPROVED' AND expires_at>now() AND payload_hash=$6 AND page_hash=$9 RETURNING *",
      [
        id,
        run.id,
        run.tenant_id,
        run.project_id,
        step,
        payloadHash,
        attemptId,
        entry('consumed', 'worker', 'attempt ' + attemptId),
        pageHash,
      ],
    );
    return rows[0];
  }
  recordOutcome(
    run: Run,
    id: string,
    outcome: ApprovalOutcome,
    detail?: string,
  ) {
    return this.change(
      { id, tenant_id: run.tenant_id, project_id: run.project_id },
      'outcome=$5',
      "status='CONSUMED' AND outcome IS NULL AND run_id=$6",
      [outcome, run.id],
      'outcome-' + outcome.toLowerCase(),
      'worker',
      detail,
    );
  }
  // Approval no longer valid for this page or payload: it can never be consumed.
  invalidate(approval: Approval, reason: string) {
    return this.change(
      approval,
      "status='CANCELLED',decision_reason=COALESCE(decision_reason,$5)",
      "status IN ('PENDING','APPROVED')",
      [reason],
      'invalidated',
      'worker',
      reason,
    );
  }
  // A terminal run leaves no decidable or consumable approval behind.
  async closeOpen(run: Run, reason: string) {
    await this.db.query(
      "UPDATE approvals SET status='CANCELLED',decision_reason=COALESCE(decision_reason,$4),audit=audit||$5::jsonb WHERE run_id=$1 AND tenant_id=$2 AND project_id=$3 AND status IN ('PENDING','APPROVED')",
      [
        run.id,
        run.tenant_id,
        run.project_id,
        reason,
        entry('cancelled', 'system', reason),
      ],
    );
  }
}
