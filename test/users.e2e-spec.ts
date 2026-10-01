import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID, scrypt } from 'node:crypto';
import request from 'supertest';
import { UsersModule } from '../src/users/users.module';
import { PrismaService } from '../src/persistence/prisma.service';
import {
  ConfigurationModule,
  ConfigurationService,
  loadConfiguration,
} from '../src/config/configuration';
import { ApiExceptionFilter } from '../src/common/errors/api-exception.filter';

// Uses a newly created schema, never the application's users/accounts tables.
const databaseUrl = process.env.USER_API_TEST_DATABASE_URL;
const live = databaseUrl ? describe : describe.skip;

live('User CRUD API with real Prisma/PostgreSQL', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: PrismaService;
  let schemaCreated = false;
  const schema = `user_api_test_${randomUUID().replaceAll('-', '_')}`;
  const adminToken = 'users-admin-test-token-'.repeat(3);
  const searchToken = 'search-only-test-token-'.repeat(3);
  const headers = { Authorization: `Bearer ${adminToken}` };
  const password = 'A secure test password';
  const freshEmail = () => `${randomUUID()}@example.test`;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await pool.query(`SET search_path TO "${schema}"`);
    for (const migration of [
      '20261001000000_add_users',
      '20261001000100_add_accounts_remove_user_tenant',
    ]) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      );
    }
    const url = new URL(databaseUrl!);
    url.searchParams.set('schema', schema);
    const config = new ConfigurationService(
      loadConfiguration('api', {
        DATABASE_URL: url.toString(),
        AUTH_CREDENTIALS: JSON.stringify([
          {
            token: adminToken,
            tenantId: 'test',
            userId: 'admin',
            projectIds: ['test'],
            capabilities: ['users'],
          },
          {
            token: searchToken,
            tenantId: 'test',
            userId: 'reader',
            projectIds: ['test'],
            capabilities: ['search'],
          },
        ]),
      }),
    );
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRole('api'), UsersModule],
    })
      .overrideProvider(ConfigurationService)
      .useValue(config)
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    db = app.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      if (pool) {
        try {
          if (schemaCreated)
            await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    }
  });

  test('requires a valid bearer token with the users capability', async () => {
    const server = app.getHttpServer();
    for (const method of ['post', 'get', 'put', 'delete'] as const) {
      const path = ['put', 'delete'].includes(method)
        ? '/users/missing'
        : '/users';
      await request(server)[method](path).expect(401);
      await request(server)
        [method](path)
        .set('Authorization', 'Bearer bad')
        .expect(401);
      await request(server)
        [method](path)
        .set('Authorization', `Bearer ${searchToken}`)
        .expect(403);
    }
  });

  test('rejects invalid bodies, unsupported fields and invalid pagination', async () => {
    for (const body of [
      { email: 'invalid', password },
      { email: freshEmail(), password: 'short' },
      { email: freshEmail() },
      { email: freshEmail(), password, avatar: 'not a URL' },
      { email: freshEmail(), password, avatar: 'javascript:alert(1)' },
      { email: freshEmail(), password, accounts: [] },
      { email: freshEmail(), password, tenantId: 'unwanted' },
    ]) {
      await request(app.getHttpServer())
        .post('/users')
        .set(headers)
        .send(body)
        .expect(400);
    }
    await request(app.getHttpServer())
      .put('/users/missing')
      .set(headers)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .put('/users/missing')
      .set(headers)
      .send({ password: null })
      .expect(400);
    for (const query of [
      'take=0',
      'take=101',
      'skip=-1',
      'take=1.5',
      'take=abc',
    ]) {
      await request(app.getHttpServer())
        .get(`/users?${query}`)
        .set(headers)
        .expect(400);
    }
    expect(await db.user.count()).toBe(0);
  });

  test('creates, retrieves, updates and deletes a user without exposing secrets', async () => {
    const email = freshEmail();
    const created = await request(app.getHttpServer())
      .post('/users')
      .set(headers)
      .send({
        email: ` ${email.toUpperCase()} `,
        password,
        name: ' Tester ',
        avatar: 'https://example.test/avatar.png',
      })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({
      email,
      name: 'Tester',
      avatar: 'https://example.test/avatar.png',
    });
    expect(created.body).not.toHaveProperty('password');
    const stored = await db.user.findUniqueOrThrow({ where: { id } });
    expect(stored.password).toMatch(/^scrypt\$32768\$8\$3\$/);
    const [, n, r, p, salt, digest] = stored.password!.split('$');
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        Buffer.from(salt, 'hex'),
        64,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
    expect(key.toString('hex')).toBe(digest);
    await db.account.create({
      data: {
        userId: id,
        provider: 'google',
        providerId: randomUUID(),
        accessToken: 'private-access-token',
      },
    });
    const fetched = await request(app.getHttpServer())
      .get(`/users/${id}`)
      .set(headers)
      .expect(200);
    expect(fetched.body).toEqual(created.body);
    expect(JSON.stringify(fetched.body)).not.toContain('private-access-token');
    const updated = await request(app.getHttpServer())
      .put(`/users/${id}`)
      .set(headers)
      .send({
        name: 'Updated',
        avatar: null,
        password: 'A different secure password',
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      email,
      name: 'Updated',
      avatar: null,
    });
    expect(updated.body).not.toHaveProperty('password');
    const changed = await db.user.findUniqueOrThrow({ where: { id } });
    expect(changed.password).not.toBe(stored.password);
    expect(changed.updatedAt.getTime()).toBeGreaterThanOrEqual(
      stored.updatedAt.getTime(),
    );
    await request(app.getHttpServer())
      .delete(`/users/${id}`)
      .set(headers)
      .expect(204)
      .expect('');
    expect(await db.account.count({ where: { userId: id } })).toBe(0);
    await request(app.getHttpServer())
      .get(`/users/${id}`)
      .set(headers)
      .expect(404);
    await request(app.getHttpServer())
      .put(`/users/${id}`)
      .set(headers)
      .send({ name: 'Missing' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/users/${id}`)
      .set(headers)
      .expect(404);
  });

  test('returns 409 for concurrent duplicate emails and conflicting updates', async () => {
    const email = freshEmail();
    const outcomes = await Promise.all([
      request(app.getHttpServer())
        .post('/users')
        .set(headers)
        .send({ email, password }),
      request(app.getHttpServer())
        .post('/users')
        .set(headers)
        .send({ email, password }),
    ]);
    expect(outcomes.map((item) => item.status).sort()).toEqual([201, 409]);
    expect(outcomes.find((item) => item.status === 409)!.body.error.code).toBe(
      'EMAIL_IN_USE',
    );
    const second = await request(app.getHttpServer())
      .post('/users')
      .set(headers)
      .send({ email: freshEmail(), password })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/users/${second.body.id}`)
      .set(headers)
      .send({ email: email.toUpperCase() })
      .expect(409);
  });

  test('lists users with bounded pagination and no passwords or accounts', async () => {
    const result = await request(app.getHttpServer())
      .get('/users?skip=0&take=1')
      .set(headers)
      .expect(200);
    expect(result.body).toMatchObject({ total: 2, skip: 0, take: 1 });
    expect(result.body.data).toHaveLength(1);
    const next = await request(app.getHttpServer())
      .get('/users?skip=1&take=1')
      .set(headers)
      .expect(200);
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].id).not.toBe(result.body.data[0].id);
    for (const user of [...result.body.data, ...next.body.data]) {
      expect(user).not.toHaveProperty('password');
      expect(user).not.toHaveProperty('accounts');
    }
    const all = await request(app.getHttpServer())
      .get('/users')
      .set(headers)
      .expect(200);
    expect(all.body).toMatchObject({ total: 2, skip: 0, take: 20 });
    expect(all.body.data).toHaveLength(2);
  });
});
