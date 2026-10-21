import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ServiceError } from '../common/errors/service.error';
import { AuthService } from './auth.service';
import { bearer, type AuthIdentity } from './auth.constants';
export type AuthenticatedRequest = Request & { auth: AuthIdentity };
@Injectable()
export class AuthSessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearer(req.headers.authorization);
    if (!token)
      throw new ServiceError('SESSION_INVALID', 'Invalid session', 401);
    req.auth = await this.auth.authenticate(token);
    return true;
  }
}
