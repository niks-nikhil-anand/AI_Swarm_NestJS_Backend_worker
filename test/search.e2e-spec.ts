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
import { TemporalService } from '../src/temporal/temporal.service';
import { DispatchService } from '../src/temporal/dispatch.service';
import { ApiExceptionFilter } from '../src/common/errors/api-exception.filter';

describe('Authorized asynchronous search API', () => {
  let app: INestApplication, pg: PGlite;
  const token = 'test-token-'.repeat(5);
  const auth = 'Bearer ' + token;
  const enqueue = jest.fn(async () => undefined);
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(
      readFileSync('src/persistence/migrations/001_initial.sql', 'utf8'),
    );
    const db = {
      query: async (text: string, values: unknown[] = []) =>
        (await pg.query(text, values)).rows,
    };
    const config = new ConfigurationService(
      loadConfiguration('api', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        AUTH_CREDENTIALS: JSON.stringify([
          {
            token,
            tenantId: 'test',
            userId: 'tester',
            projectIds: ['demo'],
            capabilities: ['search'],
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
  }, 30000);
  afterAll(async () => {
    await app.close();
    await pg.close();
  });
  test('rejects unauthenticated and cross-project requests', async () => {
    await request(app.getHttpServer())
      .post('/projects/demo/search-runs')
      .send({ queries: ['topic'] })
      .expect(401);
    await request(app.getHttpServer())
      .post('/projects/other/search-runs')
      .set('Authorization', auth)
      .send({ queries: ['topic'] })
      .expect(403);
  });
  test('validates payloads, enqueues once per persisted identity and prevents idempotency drift', async () => {
    await request(app.getHttpServer())
      .post('/projects/demo/search-runs')
      .set('Authorization', auth)
      .set('Idempotency-Key', 'bad')
      .send({ queries: [] })
      .expect(400);
    const endpoint = '/projects/demo/search-runs';
    const create = () =>
      request(app.getHttpServer())
        .post(endpoint)
        .set('Authorization', auth)
        .set('Idempotency-Key', 'stable')
        .send({ queries: ['topic'] });
    const first = await create().expect(202),
      second = await create().expect(202);
    expect(second.body.runId).toBe(first.body.runId);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', auth)
      .set('Idempotency-Key', 'stable')
      .send({ queries: ['different'] })
      .expect(409);
    await request(app.getHttpServer())
      .get(endpoint + '/' + first.body.runId)
      .set('Authorization', auth)
      .expect(200);
    await request(app.getHttpServer())
      .post(endpoint + '/' + first.body.runId + '/cancel')
      .set('Authorization', auth)
      .expect(201);
    const status = await request(app.getHttpServer())
      .get(endpoint + '/' + first.body.runId)
      .set('Authorization', auth)
      .expect(200);
    expect(status.body.status).toBe('CANCELLED');
    expect(enqueue).toHaveBeenCalled();
  });
});
