import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  ProjectAccessGuard,
  type AuthorizedRequest,
} from '../common/guards/project-access.guard';
import { ArtifactService } from './artifact.service';
@Controller('projects/:projectId/artifacts')
@UseGuards(ProjectAccessGuard)
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}
  @Get(':artifactId') async get(
    @Req() req: AuthorizedRequest,
    @Param('artifactId') id: string,
    @Res() response: Response,
  ) {
    const file = await this.artifacts.get(req.execution, id);
    response.setHeader('content-type', file.mimeType);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-disposition', 'attachment');
    response.send(file.data);
  }
}
