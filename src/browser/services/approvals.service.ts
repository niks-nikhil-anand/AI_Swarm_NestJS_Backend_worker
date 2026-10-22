import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ExecutionContext } from '../../common/types/execution-context';
import { RunRepository, type Run } from '../../persistence/run.repository';
import {
  ApprovalRepository,
  type Approval,
} from '../../persistence/approval.repository';
import { TemporalService } from '../../temporal/temporal.service';
import { ConfigurationService } from '../../config/configuration';
import { AuditService } from '../../common/logger/audit.service';
import { PolicyError } from '../../common/errors/policy.errors';
import { ServiceError } from '../../common/errors/service.error';
import { TERMINAL_STATUSES } from '../../temporal/task-queues';

const ApproveSchema = z
  .object({ payloadHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const ReasonSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();
const OPEN = ['PENDING', 'APPROVED'];

// What an approver reviews and what a caller can inspect: the proposed action without
// field values, the bound hashes, the decision and the outcome.
export function approvalView(approval: Approval) {
  return {
    approvalId: approval.id,
    runId: approval.run_id,
    step: approval.step,
    status: approval.status,
    action: approval.action,
    pageUrl: approval.page_url,
    payloadHash: approval.payload_hash,
    pageHash: approval.page_hash,
    requestedBy: approval.requested_by,
    createdAt: approval.created_at,
    expiresAt: approval.expires_at,
    decidedBy: approval.decision_by,
    decidedAt: approval.decided_at,
    decisionReason: approval.decision_reason,
    consumedAt: approval.consumed_at,
    outcome: approval.outcome,
    audit: approval.audit,
  };
}

/**
 * Approval decisions. Scope comes from the authenticated principal (tenant, project,
 * user), never from the request body; the approval is found by id within that scope and
 * its run is loaded from the approval, not from a caller-supplied run id.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly approvals: ApprovalRepository,
    private readonly temporal: TemporalService,
    private readonly config: ConfigurationService,
    private readonly audit: AuditService,
  ) {}

  private async load(ctx: ExecutionContext, id: string) {
    let approval = await this.approvals.get(
      z.uuid().parse(id),
      ctx.tenantId,
      ctx.projectId,
    );
    if (
      OPEN.includes(approval.status) &&
      new Date(approval.expires_at).getTime() <= Date.now()
    )
      approval = (await this.approvals.expireIfDue(approval)) ?? approval;
    const run = await this.runs.get(
      approval.run_id,
      ctx.tenantId,
      ctx.projectId,
    );
    // A run that ended leaves nothing to decide.
    if (
      TERMINAL_STATUSES.includes(run.status) &&
      OPEN.includes(approval.status)
    ) {
      await this.approvals.closeOpen(run, 'RUN_' + run.status);
      approval = await this.approvals.get(
        approval.id,
        ctx.tenantId,
        ctx.projectId,
      );
    }
    return { approval, run };
  }

  async list(ctx: ExecutionContext, runId: string) {
    const run = await this.runs.get(
      z.uuid().parse(runId),
      ctx.tenantId,
      ctx.projectId,
    );
    return (await this.approvals.forRun(run)).map(approvalView);
  }

  async get(ctx: ExecutionContext, id: string) {
    return approvalView((await this.load(ctx, id)).approval);
  }

  // Every decision attempt is audited by ids and outcome only.
  private record(
    ctx: ExecutionContext,
    event: string,
    outcome: string,
    run?: Run,
    approval?: Approval,
  ) {
    this.audit.record(
      event,
      {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        runId: run?.id,
        actionId: approval?.id,
      },
      outcome,
    );
  }

  // Why a conditional change did not apply, as a typed error.
  private refusal(approval: Approval, payloadHash?: string) {
    if (payloadHash && approval.payload_hash !== payloadHash)
      return new ServiceError(
        'APPROVAL_PAYLOAD_MISMATCH',
        'The decision does not match the proposed action',
        409,
      );
    return new ServiceError(
      'APPROVAL_' + approval.status,
      'The approval is ' + approval.status.toLowerCase(),
      409,
    );
  }

  private wake(run: Run) {
    // The dispatcher re-signals runs whose approval was decided, if this is lost.
    void this.temporal.signal(run, 'approvalDecided').catch(() => undefined);
  }

  async decide(
    ctx: ExecutionContext,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    body: unknown,
  ) {
    const event =
      decision === 'APPROVED' ? 'approval.approve' : 'approval.reject';
    if (!ctx.capabilities.includes('approve')) {
      this.record(ctx, event, 'CAPABILITY_DENIED');
      throw new PolicyError('CAPABILITY_DENIED', 'Approve capability required');
    }
    // Approving requires the hash of the exact action the approver reviewed.
    const payloadHash =
      decision === 'APPROVED'
        ? ApproveSchema.parse(body).payloadHash
        : undefined;
    const reason =
      decision === 'REJECTED'
        ? ReasonSchema.parse(body ?? {}).reason
        : undefined;
    const { approval, run } = await this.load(ctx, id);
    // The principal that submitted the run (and so the action) cannot approve it.
    if (
      decision === 'APPROVED' &&
      this.config.value.approvals?.distinctApprover !== false &&
      (ctx.userId === run.user_id || ctx.userId === approval.requested_by)
    ) {
      this.record(ctx, event, 'APPROVER_NOT_DISTINCT', run, approval);
      throw new PolicyError(
        'APPROVER_NOT_DISTINCT',
        'The run submitter cannot approve its own action',
      );
    }
    if (run.status !== 'AWAITING_APPROVAL' || approval.status !== 'PENDING') {
      const error =
        approval.status === 'PENDING'
          ? new ServiceError(
              'APPROVAL_RUN_NOT_WAITING',
              'The run is not waiting for this approval',
              409,
            )
          : this.refusal(approval);
      this.record(ctx, event, error.code, run, approval);
      throw error;
    }
    const decided = await this.approvals.decide(
      approval,
      decision,
      ctx.userId,
      payloadHash ?? approval.payload_hash,
      reason,
    );
    if (!decided) {
      const error = this.refusal(
        await this.approvals.get(approval.id, ctx.tenantId, ctx.projectId),
        payloadHash,
      );
      this.record(ctx, event, error.code, run, approval);
      throw error;
    }
    this.record(ctx, event, decided.status, run, decided);
    this.wake(run);
    return approvalView(decided);
  }

  // Withdraws an unused approval: by an approver, or by the principal that submitted the run.
  async cancel(ctx: ExecutionContext, id: string, body: unknown) {
    const { reason } = ReasonSchema.parse(body ?? {});
    const { approval, run } = await this.load(ctx, id);
    if (!ctx.capabilities.includes('approve') && ctx.userId !== run.user_id) {
      this.record(ctx, 'approval.cancel', 'CAPABILITY_DENIED', run, approval);
      throw new PolicyError(
        'CAPABILITY_DENIED',
        'Only an approver or the run submitter can cancel an approval',
      );
    }
    const changed = await this.approvals.revoke(approval, ctx.userId, reason);
    if (!changed) {
      const error = this.refusal(
        await this.approvals.get(approval.id, ctx.tenantId, ctx.projectId),
      );
      this.record(ctx, 'approval.cancel', error.code, run, approval);
      throw error;
    }
    this.record(ctx, 'approval.cancel', changed.status, run, changed);
    this.wake(run);
    return approvalView(changed);
  }
}
