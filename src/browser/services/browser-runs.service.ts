import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ExecutionContext } from '../../common/types/execution-context';
import { RunRepository } from '../../persistence/run.repository';
import { DispatchService } from '../../temporal/dispatch.service';
import { TemporalService } from '../../temporal/temporal.service';
import { BrowserRequestSchema } from '../contracts/browser-request';
import { PolicyError } from '../../common/errors/policy.errors';
@Injectable()
export class BrowserRunsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly dispatch: DispatchService,
    private readonly temporal: TemporalService,
  ) {}
  async create(ctx: ExecutionContext, input: unknown, key: unknown) {
    if (!ctx.capabilities.includes('browser'))
      throw new PolicyError('CAPABILITY_DENIED', 'Browser capability required');
    const run = await this.runs.create(
      ctx,
      'browser',
      BrowserRequestSchema.parse(input),
      z.string().min(1).max(200).parse(key),
    );
    void this.dispatch.enqueue(run);
    return { runId: run.id, status: run.status };
  }
  get(ctx: ExecutionContext, id: string) {
    return this.runs.get(z.uuid().parse(id), ctx.tenantId, ctx.projectId);
  }
  async cancel(ctx: ExecutionContext, id: string) {
    const run = await this.get(ctx, id);
    if (!['QUEUED', 'RUNNING'].includes(run.status))
      return { status: run.status };
    await this.runs.transition(run, 'CANCELLED');
    if (run.dispatch_state === 'DISPATCHED')
      await this.temporal.cancel(run).catch(() => undefined);
    return { status: 'CANCELLED' };
  }
}
