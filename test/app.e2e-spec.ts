import {
  ConfigurationService,
  loadConfiguration,
} from '../src/config/configuration';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigurationService)
      .useValue(
        new ConfigurationService(
          loadConfiguration('api', {
            DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
            AUTH_CREDENTIALS: JSON.stringify([
              {
                token: 'root-http-test-token-'.repeat(3),
                tenantId: 'test',
                userId: 'test',
                projectIds: ['test'],
                capabilities: ['search'],
              },
            ]),
          }),
        ),
      )
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app?.close();
  });
});
