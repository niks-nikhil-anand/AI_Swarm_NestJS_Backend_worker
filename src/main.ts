import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigurationService } from './config/configuration';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const express = await import('express');
  app.use(express.json({ limit: '64kb' }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigurationService).value.port, '0.0.0.0');
}
void bootstrap().catch(() => {
  console.error('API startup failed: check validated configuration');
  process.exitCode = 1;
});
