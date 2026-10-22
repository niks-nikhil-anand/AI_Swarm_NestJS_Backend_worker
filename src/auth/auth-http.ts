import type { INestApplication } from '@nestjs/common';

// Shared with the focused HTTP fixture so CORS tests exercise production settings.
export function configureAuthCors(app: INestApplication, origins: string[]) {
  if (origins.length)
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      credentials: false,
    });
}
