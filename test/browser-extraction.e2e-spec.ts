import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  ConfigurationService,
  loadConfiguration,
} from '../src/config/configuration';
import { DatabaseService } from '../src/persistence/database.service';
import { RunRepository } from '../src/persistence/run.repository';
import { TemporalService } from '../src/temporal/temporal.service';
import { DispatchService } from '../src/temporal/dispatch.service';
import { ApiExceptionFilter } from '../src/common/errors/api-exception.filter';
import { MIGRATIONS } from '../src/persistence/migrate';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    prices: { type: 'array', items: { type: ['number', 'null'] } },
  },
  required: ['title'],
};

describe('Structured extraction API', () => {
  let app: INestApplication, pg: PGlite, runs: RunRepository;
  const tokenA = 'tenant-a-token-'.repeat(4);
  const tokenB = 'tenant-b-token-'.repeat(4);
  const enqueue = jest.fn(async () => undefined);
  beforeAll(async () => {
    pg = new PGlite();
    for (const file of MIGRATIONS)
      await pg.exec(readFileSync('src/persistence/migrations/' + file, 'utf8'));
    const db = {
      query: async (text: string, values: unknown[] = []) =>
        (await pg.query(text, values)).rows,
    };
    // Two tenants that both use the project id "demo".
    const config = new ConfigurationService(
      loadConfiguration('api', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        AUTH_CREDENTIALS: JSON.stringify([
          {
            token: tokenA,
            tenantId: 'tenant-a',
            userId: 'a',
            projectIds: ['demo'],
            capabilities: ['browser'],
          },
          {
            token: tokenB,
            tenantId: 'tenant-b',
            userId: 'b',
            projectIds: ['demo'],
            capabilities: ['browser'],
          },
        ]),
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigurationService)
      .useValue(config)
      .overrideProvider(DatabaseService)
      .useValue(db)
      .overrideProvider(TemporalService)
      .useValue({ cancel: jest.fn(), healthy: async () => true })
      .overrideProvider(DispatchService)
      .useValue({ enqueue })
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    runs = module.get(RunRepository);
  }, 30000);
  afterAll(async () => {
    await app.close();
    await pg.close();
  });
  const post = (token: string, body: object, key = 'k-' + Math.random()) =>
    request(app.getHttpServer())
      .post('/projects/demo/browser-runs')
      .set('authorization', 'Bearer ' + token)
      .set('idempotency-key', key)
      .send(body);

  test('rejects unsupported schemas with a typed error naming the step and path', async () => {
    const response = await post(tokenA, {
      steps: [
        { kind: 'navigate', url: 'https://example.com/' },
        {
          kind: 'extract',
          instruction: 'get prices',
          schema: {
            type: 'object',
            properties: { price: { type: 'string', pattern: '^(a+)+$' } },
          },
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'EXTRACT_SCHEMA_INVALID',
      message:
        'Step 1: Extraction schema $.price: keyword "pattern" is not supported for string',
      retryable: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('accepts extraction runs and keeps the capture request unchanged', async () => {
    const extract = await post(tokenA, {
      steps: [
        { kind: 'navigate', url: 'https://example.com/' },
        { kind: 'extract', instruction: 'get the title and prices', schema },
      ],
    });
    expect(extract.status).toBe(202);
    const capture = await post(tokenA, { urls: ['https://example.com/'] });
    expect(capture.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  test('returns persisted results with source evidence, only to the owning tenant', async () => {
    const response = await post(tokenA, {
      steps: [{ kind: 'extract', instruction: 'get the title', schema }],
    });
    const run = await runs.get(response.body.runId, 'tenant-a', 'demo');
    // What the browser worker persists for an extract step.
    const evidenceId = await runs.saveEvidence(run, 'https://example.com/', {
      url: 'https://example.com/',
      title: 'Example Domain',
      text: 'Example text',
      retrievedAt: '2026-10-22T10:00:00.000Z',
    });
    await runs.saveExtraction(run, {
      step: 0,
      url: 'https://example.com/',
      instruction: 'get the title',
      schemaHash: 'h'.repeat(64),
      schema,
      data: { title: 'Example Domain', prices: [1.5, null] },
      missing: ['$.prices[1]'],
      evidenceId,
      modelCalls: 2,
      modelTokens: 1200,
      retrievedAt: '2026-10-22T10:00:00.000Z',
    });
    const owned = await request(app.getHttpServer())
      .get('/projects/demo/browser-runs/' + run.id + '/extractions')
      .set('authorization', 'Bearer ' + tokenA);
    expect(owned.status).toBe(200);
    expect(owned.body.extractions).toEqual([
      expect.objectContaining({
        step: 0,
        url: 'https://example.com/',
        data: { title: 'Example Domain', prices: [1.5, null] },
        missing: ['$.prices[1]'],
        modelCalls: 2,
        modelTokens: 1200,
        evidence: {
          id: evidenceId,
          url: 'https://example.com/',
          title: 'Example Domain',
          retrievedAt: '2026-10-22T10:00:00.000Z',
        },
      }),
    ]);
    // Same project id, other tenant: the run does not exist for them.
    const other = await request(app.getHttpServer())
      .get('/projects/demo/browser-runs/' + run.id + '/extractions')
      .set('authorization', 'Bearer ' + tokenB);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('RUN_NOT_FOUND');
    const anonymous = await request(app.getHttpServer()).get(
      '/projects/demo/browser-runs/' + run.id + '/extractions',
    );
    expect(anonymous.status).toBe(401);
    // Rows are stored with the run's tenant and project.
    const stored = await pg.query<{ tenant_id: string; project_id: string }>(
      'SELECT tenant_id,project_id FROM extractions WHERE run_id=$1',
      [run.id],
    );
    expect(stored.rows).toEqual([
      { tenant_id: 'tenant-a', project_id: 'demo' },
    ]);
  });
});
