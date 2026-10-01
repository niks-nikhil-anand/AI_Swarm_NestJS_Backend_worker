import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigurationService } from '../config/configuration';

@Injectable()
export class UserAccessGuard implements CanActivate {
  constructor(private readonly config: ConfigurationService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
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
    if (!principal.capabilities.includes('users'))
      throw new ForbiddenException();
    return true;
  }
}
