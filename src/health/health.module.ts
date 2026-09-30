import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SearxngClient } from '../search/clients/searxng.client';
@Module({ controllers: [HealthController], providers: [SearxngClient] })
export class HealthModule {}
