import { setupUserSwagger } from '../../src/openapi/swagger';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { json } from 'express';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { UsersModule } from '../../src/users/users.module';
import { PrismaService } from '../../src/persistence/prisma.service';
import {
  ConfigurationModule,
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import { ApiExceptionFilter } from '../../src/common/errors/api-exception.filter';
import { configureAuthCors } from '../../src/auth/auth-http';

export const testPassword = 'A secure test password';
export const freshEmail = () => `${randomUUID()}@example.test`;
export const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
});
export const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const publicFields = [
  'avatar',
  'createdAt',
  'email',
  'id',
  'name',
  'updatedAt',
];

export class UserApiFixture {
  app!: INestApplication;
  db!: PrismaService;
  pool!: Pool;
  config!: ConfigurationService;
  readonly schema = `user_api_test_${randomUUID().replaceAll('-', '_')}`;
  readonly adminToken = 'user-api-admin-test-token-'.repeat(3);
  readonly searchToken = 'user-api-search-test-token-'.repeat(3);
  private schemaCreated = false;
  private closed = false;
  private defaults!: ConfigurationService['value']['auth'];
  async start(
    databaseUrl: string | undefined,
    unreachableRuntime = false,
    options: { swagger?: boolean } = {},
  ) {
    if (!databaseUrl)
      throw new Error('Explicit user/auth PostgreSQL test URL required');
    try {
      this.pool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
      this.schemaCreated = true;
      await this.pool.query(`SET search_path TO "${this.schema}"`);
      for (const migration of readdirSync('prisma/migrations')
        .filter((x) => /^\d/.test(x))
        .sort())
        await this.pool.query(
          readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
        );
      const url = new URL(databaseUrl);
      url.searchParams.set('schema', this.schema);
      if (unreachableRuntime) {
        url.hostname = '127.0.0.1';
        url.port = '1';
      }
      this.config = new ConfigurationService(
        loadConfiguration('api', {
          DATABASE_URL: url.toString(),
          AUTH_RATE_LIMIT: '10000',
          AUTH_MAX_ACTIVE_SESSIONS: '3',
          AUTH_ALLOWED_ORIGINS: 'https://frontend.example.test',
          AUTH_CREDENTIALS: JSON.stringify([
            {
              token: this.adminToken,
              tenantId: 'test',
              userId: 'admin',
              projectIds: ['test'],
              capabilities: ['users'],
            },
            {
              token: this.searchToken,
              tenantId: 'test',
              userId: 'reader',
              projectIds: ['test'],
              capabilities: ['search'],
            },
          ]),
        }),
      );
      this.defaults = structuredClone(this.config.value.auth);
      const module = await Test.createTestingModule({
        imports: [ConfigurationModule.forRole('api'), AuthModule, UsersModule],
      })
        .overrideProvider(ConfigurationService)
        .useValue(this.config)
        .compile();
      this.app = module.createNestApplication({ bodyParser: false });
      this.app.use(json({ limit: '64kb' }));
      this.app.useGlobalFilters(new ApiExceptionFilter());
      configureAuthCors(this.app, this.config.value.auth.allowedOrigins);
      if (options.swagger) setupUserSwagger(this.app);
      // Own one loopback listener for the suite; concurrent Supertest requests
      // must not compete to auto-start/close the same HTTP server.
      await this.app.listen(0, '127.0.0.1');
      this.db = this.app.get(PrismaService);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async reset() {
    this.config.value.auth = structuredClone(this.defaults);
    await this.db.user.deleteMany(); // Only this fixture's generated schema; sessions/accounts cascade.
  }
  async close() {
    if (this.closed) return;
    if (this.schemaCreated && !/^user_api_test_[0-9a-f_]+$/.test(this.schema))
      throw new Error('Refusing unsafe schema teardown');
    this.closed = true;
    try {
      if (this.app) await this.app.close();
    } finally {
      if (this.pool) {
        try {
          if (this.schemaCreated) {
            await this.pool.query('ROLLBACK');
            await this.pool.query(`DROP SCHEMA "${this.schema}" CASCADE`);
            this.schemaCreated = false;
          }
        } finally {
          await this.pool.end();
        }
      }
    }
  }
  register(body: Record<string, unknown> = {}) {
    return request(this.app.getHttpServer())
      .post('/auth/register')
      .send({ email: freshEmail(), password: testPassword, ...body });
  }
  login(email: string, password = testPassword) {
    return request(this.app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
  }
  me(token: string) {
    return request(this.app.getHttpServer())
      .get('/auth/me')
      .set(headers(token));
  }
  async user(body: Record<string, unknown> = {}) {
    const response = await this.register(body).expect(201);
    return response.body as {
      user: {
        id: string;
        email: string;
        name: string | null;
        avatar: string | null;
        createdAt: string;
        updatedAt: string;
      };
      accessToken: string;
      expiresAt: string;
      tokenType: string;
    };
  }
  async expire(token: string) {
    await this.db.authSession.update({
      where: { tokenHash: digest(token) },
      data: {
        createdAt: new Date(Date.now() - 20000),
        expiresAt: new Date(Date.now() - 10000),
      },
    });
  }
  async failRevocation<T>(operation: () => Promise<T>) {
    // A real PostgreSQL trigger forces an error after preceding writes inside the transaction.
    await this.pool
      .query(`CREATE FUNCTION fail_auth_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER fail_auth_revoke BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fail_auth_revoke();`);
    try {
      return await operation();
    } finally {
      await this.pool.query(
        'DROP TRIGGER fail_auth_revoke ON auth_sessions; DROP FUNCTION fail_auth_revoke();',
      );
    }
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function waitFor(promise: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Race fixture barrier was not reached')),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
