import { authConfiguration } from './auth.config';
import { Injectable, DynamicModule, Global, Module } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { browserConfiguration, ConfigurationError } from './browser.config';
import { approvalConfiguration } from './approval.config';
import { searxngConfiguration } from './searxng.config';
import { securityConfiguration } from './security.config';

export type ProcessRole =
  'api' | 'search' | 'browser' | 'orchestration' | 'migration';
export const integer = (
  value: string | undefined,
  fallback: number,
  max: number,
) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .parse(value ?? fallback);

export function loadConfiguration(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    const databaseUrl = z.string().url().parse(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
      throw new Error();
    return {
      role,
      auth: authConfiguration(env),
      databaseUrl,
      port: integer(env.PORT, 3000, 65535),
      search: searxngConfiguration(env),
      browser: role === 'browser' ? browserConfiguration(env) : undefined,
      approvals: approvalConfiguration(env),
      principals: role === 'api' ? securityConfiguration(env) : [],
      temporal: {
        address: env.TEMPORAL_ADDRESS || 'localhost:7233',
        namespace: env.TEMPORAL_NAMESPACE || 'default',
        orchestrationQueue:
          env.TEMPORAL_ORCHESTRATION_QUEUE || 'swarm-orchestration',
        searchQueue: env.TEMPORAL_SEARCH_QUEUE || 'swarm-search',
        browserQueue: env.TEMPORAL_BROWSER_QUEUE || 'swarm-browser',
      },
      artifactRoot: env.ARTIFACT_ROOT || '.data/artifacts',
    };
  } catch (error) {
    if (error instanceof ConfigurationError)
      throw new Error('Invalid configuration: ' + error.message);
    throw new Error(
      'Invalid configuration: check DATABASE_URL, AUTH_CREDENTIALS and process-specific limits (values redacted)',
    );
  }
}
export type Configuration = ReturnType<typeof loadConfiguration>;

@Injectable()
export class ConfigurationService {
  constructor(readonly value: Configuration) {}
}
@Global()
@Module({})
export class ConfigurationModule {
  static forRole(role: ProcessRole): DynamicModule {
    return {
      module: ConfigurationModule,
      providers: [
        {
          provide: ConfigurationService,
          useFactory: () => {
            loadEnv({ quiet: true });
            return new ConfigurationService(loadConfiguration(role));
          },
        },
      ],
      exports: [ConfigurationService],
    };
  }
}
