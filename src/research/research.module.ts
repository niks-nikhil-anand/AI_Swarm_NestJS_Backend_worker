import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RunRepository } from '../persistence/run.repository';
import { DispatchService } from '../temporal/dispatch.service';
import {
  ProjectAccessGuard,
  type AuthorizedRequest,
} from '../common/guards/project-access.guard';
import { SearchRequestSchema } from '../search/contracts/search-request';
import { PolicyError } from '../common/errors/policy.errors';
export const ResearchRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    search: SearchRequestSchema,
  })
  .strict();
@Controller('projects/:projectId/research-runs')
@UseGuards(ProjectAccessGuard)
export class ResearchController {
  constructor(
    private readonly runs: RunRepository,
    private readonly dispatch: DispatchService,
  ) {}
  @Post()
  @HttpCode(202)
  async create(
    @Req() req: AuthorizedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    if (
      !['search', 'browser', 'research'].every((cap) =>
        req.execution.capabilities.includes(
          cap as 'search' | 'browser' | 'research',
        ),
      )
    )
      throw new PolicyError(
        'CAPABILITY_DENIED',
        'Search, browser and research capabilities required',
      );
    const run = await this.runs.create(
      req.execution,
      'research',
      ResearchRequestSchema.parse(body),
      z.string().min(1).max(200).parse(key),
    );
    void this.dispatch.enqueue(run);
    return { runId: run.id, status: run.status };
  }
  @Get(':runId') async get(
    @Req() req: AuthorizedRequest,
    @Param('runId') id: string,
  ) {
    const run = await this.runs.get(
      z.uuid().parse(id),
      req.execution.tenantId,
      req.execution.projectId,
    );
    return { runId: run.id, status: run.status, output: run.output };
  }
}
@Module({ controllers: [ResearchController] })
export class ResearchModule {}
