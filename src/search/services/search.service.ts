import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RunRepository } from '../../persistence/run.repository';
import { DispatchService } from '../../temporal/dispatch.service';
import { TemporalService } from '../../temporal/temporal.service';
import { SearchRequestSchema } from '../contracts/search-request';
import type { ExecutionContext } from '../../common/types/execution-context';
import { PolicyError } from '../../common/errors/policy.errors';

@Injectable()
export class SearchService {
  constructor(
    private readonly runs: RunRepository,
    private readonly dispatch: DispatchService,
    private readonly temporal: TemporalService,
  ) {}
  async create(ctx: ExecutionContext, input: unknown, key: unknown) {
    if (!ctx.capabilities.includes('search'))
      throw new PolicyError('CAPABILITY_DENIED', 'Search capability required');
    const request = SearchRequestSchema.parse(input);
    const idempotency = z.string().min(1).max(200).parse(key);
    const run = await this.runs.create(ctx, 'search', request, idempotency);
    void this.dispatch.enqueue(run);
    return { runId: run.id, status: run.status };
  }
  async get(ctx: ExecutionContext, id: string) {
    return this.runs.get(z.uuid().parse(id), ctx.tenantId, ctx.projectId);
  }
  async results(ctx: ExecutionContext, id: string, offset = 0) {
    const run = await this.get(ctx, id);
    return (await this.runs.results(run)).slice(offset, offset + 50);
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
