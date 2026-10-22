import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ExecutionContext } from '../../common/types/execution-context';
import { RunRepository } from '../../persistence/run.repository';
import { ApprovalRepository } from '../../persistence/approval.repository';
import { DispatchService } from '../../temporal/dispatch.service';
import { TemporalService } from '../../temporal/temporal.service';
import { BrowserRunRequestSchema } from '../contracts/browser-request';
import { PolicyError } from '../../common/errors/policy.errors';
import { ServiceError } from '../../common/errors/service.error';
import { parseExtractionSchema } from '../extraction/extraction-schema';
@Injectable()
export class BrowserRunsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly dispatch: DispatchService,
    private readonly temporal: TemporalService,
    private readonly approvals: ApprovalRepository,
  ) {}
  async create(ctx: ExecutionContext, input: unknown, key: unknown) {
    if (!ctx.capabilities.includes('browser'))
      throw new PolicyError('CAPABILITY_DENIED', 'Browser capability required');
    const request = BrowserRunRequestSchema.parse(input);
    // Rejected before persisting: a run with an unsupported schema never starts.
    if ('steps' in request)
      for (const [index, step] of request.steps.entries())
        if (step.kind === 'extract')
          try {
            parseExtractionSchema(step.schema);
          } catch (error) {
            if (error instanceof ServiceError)
              throw new ServiceError(
                error.code,
                'Step ' + index + ': ' + error.message,
                400,
              );
            throw error;
          }
    const run = await this.runs.create(
      ctx,
      'browser',
      request,
      z.string().min(1).max(200).parse(key),
    );
    void this.dispatch.enqueue(run);
    return { runId: run.id, status: run.status };
  }
  get(ctx: ExecutionContext, id: string) {
    return this.runs.get(z.uuid().parse(id), ctx.tenantId, ctx.projectId);
  }
  // Ownership is enforced twice: the run lookup and the tenant/project-scoped query.
  async extractions(ctx: ExecutionContext, id: string) {
    return this.runs.extractions(await this.get(ctx, id));
  }
  async cancel(ctx: ExecutionContext, id: string) {
    const run = await this.get(ctx, id);
    if (!['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status))
      return { status: run.status };
    await this.runs.transition(run, 'CANCELLED');
    // A cancelled run's approvals can no longer be decided or consumed.
    await this.approvals.closeOpen(run, 'RUN_CANCELLED');
    if (run.dispatch_state === 'DISPATCHED')
      await this.temporal.cancel(run).catch(() => undefined);
    return { status: 'CANCELLED' };
  }
}
