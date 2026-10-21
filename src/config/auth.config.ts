import { z } from 'zod';

export function authConfiguration(env: NodeJS.ProcessEnv) {
  const number = (
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(value ?? fallback);
  const allowedOrigins = (env.AUTH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('Invalid auth origin');
  }
  return {
    sessionTtlSeconds: number(env.AUTH_SESSION_TTL_SECONDS, 86400, 60, 2592000),
    maxActiveSessions: number(env.AUTH_MAX_ACTIVE_SESSIONS, 5, 1, 20),
    rateLimit: number(env.AUTH_RATE_LIMIT, 30, 1, 10000),
    hashConcurrency: number(env.AUTH_HASH_CONCURRENCY, 2, 1, 8),
    allowedOrigins,
  };
}
