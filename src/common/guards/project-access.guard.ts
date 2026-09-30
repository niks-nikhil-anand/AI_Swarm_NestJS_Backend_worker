import {
  CanActivate,
  ExecutionContext as NestContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigurationService } from '../../config/configuration';
import type { ExecutionContext } from '../types/execution-context';

export type AuthorizedRequest = Request & { execution: ExecutionContext };
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(private readonly config: ConfigurationService) {}
  canActivate(context: NestContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const header = request.headers.authorization || '';
    if (!header.startsWith('Bearer ') || header.length > 1024)
      throw new UnauthorizedException();
    const supplied = createHash('sha256').update(header.slice(7)).digest();
    const principal = this.config.value.principals.find((item) =>
      timingSafeEqual(
        supplied,
        createHash('sha256').update(item.token).digest(),
      ),
    );
    if (!principal) throw new UnauthorizedException();
    const projectId = String(request.params.projectId || '');
    if (!principal.projectIds.includes(projectId))
      throw new ForbiddenException();
    request.execution = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      projectId,
      requestId: randomUUID(),
      capabilities: principal.capabilities,
    };
    return true;
  }
}
