import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ProjectAccessGuard,
  type AuthorizedRequest,
} from '../../common/guards/project-access.guard';
import { BrowserRunsService } from '../services/browser-runs.service';
@Controller('projects/:projectId/browser-runs')
@UseGuards(ProjectAccessGuard)
export class BrowserController {
  constructor(private readonly runs: BrowserRunsService) {}
  @Post() @HttpCode(202) create(
    @Req() req: AuthorizedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.runs.create(req.execution, body, key);
  }
  @Get(':runId') async get(
    @Req() req: AuthorizedRequest,
    @Param('runId') id: string,
  ) {
    const run = await this.runs.get(req.execution, id);
    return { runId: run.id, status: run.status, output: run.output };
  }
  // Structured results with their source evidence, in step order.
  @Get(':runId/extractions') async extractions(
    @Req() req: AuthorizedRequest,
    @Param('runId') id: string,
  ) {
    return {
      runId: id,
      extractions: await this.runs.extractions(req.execution, id),
    };
  }
  @Post(':runId/cancel') cancel(
    @Req() req: AuthorizedRequest,
    @Param('runId') id: string,
  ) {
    return this.runs.cancel(req.execution, id);
  }
}
