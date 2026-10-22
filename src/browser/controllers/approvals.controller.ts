import {
  Body,
  Controller,
  Get,
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
import { ApprovalsService } from '../services/approvals.service';

// A run's submit step requests the approval; these operations inspect, decide and cancel it.
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}
  @Get('browser-runs/:runId/approvals') async list(
    @Req() req: AuthorizedRequest,
    @Param('runId') runId: string,
  ) {
    return {
      runId,
      approvals: await this.approvals.list(req.execution, runId),
    };
  }
  @Get('approvals/:approvalId') get(
    @Req() req: AuthorizedRequest,
    @Param('approvalId') id: string,
  ) {
    return this.approvals.get(req.execution, id);
  }
  @Post('approvals/:approvalId/approve') @HttpCode(200) approve(
    @Req() req: AuthorizedRequest,
    @Param('approvalId') id: string,
    @Body() body: unknown,
  ) {
    return this.approvals.decide(req.execution, id, 'APPROVED', body);
  }
  @Post('approvals/:approvalId/reject') @HttpCode(200) reject(
    @Req() req: AuthorizedRequest,
    @Param('approvalId') id: string,
    @Body() body: unknown,
  ) {
    return this.approvals.decide(req.execution, id, 'REJECTED', body);
  }
  @Post('approvals/:approvalId/cancel') @HttpCode(200) cancel(
    @Req() req: AuthorizedRequest,
    @Param('approvalId') id: string,
    @Body() body: unknown,
  ) {
    return this.approvals.cancel(req.execution, id, body);
  }
}
