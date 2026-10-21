import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { ConfigurationService } from '../config/configuration';
import { ServiceError } from '../common/errors/service.error';

// Single-instance limiter; use a shared limiter before deploying API replicas.
@Injectable()
export class AuthRequestGuard implements CanActivate {
  private readonly buckets = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(private readonly config: ConfigurationService) {}
  canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const ownOrigin = `${req.protocol}://${req.headers.host}`;
    if (
      origin &&
      origin !== ownOrigin &&
      !this.config.value.auth.allowedOrigins.includes(origin)
    )
      throw new ServiceError('ORIGIN_DENIED', 'Origin is not allowed', 403);
    if ((req.headers.authorization?.length ?? 0) > 1024)
      throw new ServiceError(
        'INVALID_ARGUMENT',
        'Invalid authorization header',
        400,
      );
    // Independent global-IP and account buckets prevent endpoint/IP rotation bypasses.
    const keys = [`ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`];
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email === 'string')
      keys.push(
        `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`,
      );
    const now = Date.now();
    for (const [key, bucket] of this.buckets)
      if (bucket.until <= now) this.buckets.delete(key);
    for (const key of keys) {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        if (this.buckets.size >= 10000)
          throw new ServiceError(
            'AUTH_CAPACITY',
            'Authentication capacity exceeded',
            503,
            true,
          );
        bucket = { count: 0, until: now + 60000 };
        this.buckets.set(key, bucket);
      }
      if (++bucket.count > this.config.value.auth.rateLimit) {
        res.setHeader(
          'Retry-After',
          Math.max(1, Math.ceil((bucket.until - now) / 1000)),
        );
        throw new ServiceError(
          'RATE_LIMITED',
          'Too many authentication requests',
          429,
          true,
        );
      }
    }
    return true;
  }
}
