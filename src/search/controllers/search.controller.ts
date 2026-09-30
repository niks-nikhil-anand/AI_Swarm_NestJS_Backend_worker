import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ProjectAccessGuard,
  type AuthorizedRequest,
} from '../../common/guards/project-access.guard';
import { SearchService } from '../services/search.service';
@Controller('projects/:projectId/search-runs')
@UseGuards(ProjectAccessGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}
  @Post()
  @HttpCode(202)
  create(
    @Req() req: AuthorizedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.search.create(req.execution, body, key);
  }
  @Get(':runId')
  async get(@Req() req: AuthorizedRequest, @Param('runId') id: string) {
    const run = await this.search.get(req.execution, id);
    return {
      runId: run.id,
      status: run.status,
      output: run.output,
      dispatchState: run.dispatch_state,
    };
  }
  @Get(':runId/results')
  results(
    @Req() req: AuthorizedRequest,
    @Param('runId') id: string,
    @Query('offset') offset?: string,
  ) {
    return this.search.results(
      req.execution,
      id,
      z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .parse(offset || 0),
    );
  }
  @Post(':runId/cancel')
  cancel(@Req() req: AuthorizedRequest, @Param('runId') id: string) {
    return this.search.cancel(req.execution, id);
  }
}
