import { UserApiFixture, waitFor } from './helpers/user-api-test-app';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PasswordService } from '../src/users/password.service';
import { PrismaService } from '../src/persistence/prisma.service';
import { ConfigurationService } from '../src/config/configuration';

const databaseUrl = process.env.AUTH_API_TEST_DATABASE_URL;
const live = databaseUrl ? describe : describe.skip;
live('Auth API with real Prisma/PostgreSQL', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: PrismaService;
  let config: ConfigurationService;
  const adminToken = 'user-api-admin-test-token-'.repeat(3);
  const password = 'A secure test password';
  const email = () => `${randomUUID()}@example.test`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
  const hash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const register = (address = email()) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: address, password });
  const login = (address: string, secret = password) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: address, password: secret });
  const me = (token: string) =>
    request(app.getHttpServer()).get('/auth/me').set(headers(token));

  const fixture = new UserApiFixture();
  beforeAll(async () => {
    await fixture.start(databaseUrl);
    app = fixture.app;
    pool = fixture.pool;
    db = fixture.db;
    config = fixture.config;
  }, 60000);
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture.close();
  });
  afterEach(() => jest.restoreAllMocks());

  test('registers, normalizes, stores only a token digest, and returns the current public user', async () => {
    const address = email();
    const result = await register(` ${address.toUpperCase()} `).expect(201);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.accessToken).toMatch(/^swu_[A-Za-z0-9_-]{43}$/);
    expect(result.body.user.email).toBe(address);
    expect(Object.keys(result.body.user).sort()).toEqual([
      'avatar',
      'createdAt',
      'email',
      'id',
      'name',
      'updatedAt',
    ]);
    expect((await me(result.body.accessToken).expect(200)).body).toEqual(
      result.body.user,
    );
    const stored = await db.authSession.findUniqueOrThrow({
      where: { tokenHash: hash(result.body.accessToken) },
    });
    expect(JSON.stringify(stored)).not.toContain(result.body.accessToken);
    expect(stored.userId).toBe(result.body.user.id);
    const user = await db.user.findUniqueOrThrow({
      where: { id: stored.userId },
    });
    expect(user.password).not.toBe(password);
    expect(user.password).toMatch(/^scrypt\$/);
    await request(app.getHttpServer())
      .get('/users')
      .set(headers(result.body.accessToken))
      .expect(401);
  });
  test('rejects invalid registration/login bodies and duplicate email races', async () => {
    for (const body of [
      { email: 'bad', password },
      { email: email(), password: 'short' },
      { email: email(), password, role: 'admin' },
      { email: email(), password, tenantId: 'other' },
    ])
      await request(app.getHttpServer())
        .post('/auth/register')
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email() })
      .expect(400);
    const address = email();
    const results = await Promise.all([
      register(address),
      register(address.toUpperCase()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.user.count({ where: { email: address } })).toBe(1);
  });
  test('uses the same error for wrong, unknown, passwordless, disabled and deleted accounts', async () => {
    const created = await register().expect(201);
    const wrong = await login(created.body.user.email, 'Wrong password').expect(
      401,
    );
    expect((await login(email()).expect(401)).body).toEqual(wrong.body);
    await db.user.update({
      where: { id: created.body.user.id },
      data: { password: null },
    });
    expect((await login(created.body.user.email).expect(401)).body).toEqual(
      wrong.body,
    );
    const disabled = await register().expect(201);
    await db.user.update({
      where: { id: disabled.body.user.id },
      data: { disabledAt: new Date() },
    });
    expect((await login(disabled.body.user.email).expect(401)).body).toEqual(
      wrong.body,
    );
    await me(disabled.body.accessToken).expect(401);
    const deleted = await register().expect(201);
    await db.user.update({
      where: { id: deleted.body.user.id },
      data: { deletedAt: new Date() },
    });
    expect((await login(deleted.body.user.email).expect(401)).body).toEqual(
      wrong.body,
    );
  });
  test('logout revokes only the presented session and is idempotent', async () => {
    const created = await register().expect(201);
    const second = await login(created.body.user.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set(headers(created.body.accessToken))
      .expect(204);
    await me(created.body.accessToken).expect(401);
    await me(second.body.accessToken).expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set(headers(created.body.accessToken))
      .expect(204);
    await request(app.getHttpServer()).post('/auth/logout').expect(204);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set(headers(`swu_${'x'.repeat(43)}`))
      .expect(204);
  });
  test('enforces expiry, credential version and the maximum number of sessions', async () => {
    const created = await register().expect(201);
    const tokens = [created.body.accessToken];
    for (let i = 0; i < 3; i++)
      tokens.push(
        (await login(created.body.user.email).expect(200)).body.accessToken,
      );
    await me(tokens[0]).expect(401);
    await me(tokens[1]).expect(200);
    await db.authSession.update({
      where: { tokenHash: hash(tokens[1]) },
      data: {
        createdAt: new Date(Date.now() - 20000),
        expiresAt: new Date(Date.now() - 10000),
      },
    });
    await me(tokens[1]).expect(401);
    await db.user.update({
      where: { id: created.body.user.id },
      data: { credentialVersion: { increment: 1 } },
    });
    await me(tokens[2]).expect(401);
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await me('bad').expect(401);
  });
  test('updates only allowed self fields and preserves sessions for profile changes', async () => {
    const created = await register().expect(201);
    const token = created.body.accessToken;
    for (const body of [
      {},
      { currentPassword: password },
      { id: 'other' },
      { capabilities: ['users'] },
      { name: '' },
      { avatar: 'javascript:alert(1)' },
    ])
      await request(app.getHttpServer())
        .put('/auth/me')
        .set(headers(token))
        .send(body)
        .expect(400);
    const result = await request(app.getHttpServer())
      .put('/auth/me')
      .set(headers(token))
      .send({ name: ' Updated ', avatar: null })
      .expect(200);
    expect(result.body).toMatchObject({
      user: {
        id: created.body.user.id,
        name: 'Updated',
        avatar: null,
        email: created.body.user.email,
      },
      reauthenticationRequired: false,
    });
    await me(token).expect(200);
  });
  test('requires confirmation for credentials, rolls back email conflicts, and revokes every session', async () => {
    const first = await register().expect(201);
    const other = await register().expect(201);
    const token = first.body.accessToken;
    const second = await login(first.body.user.email).expect(200);
    await request(app.getHttpServer())
      .put('/auth/me')
      .set(headers(token))
      .send({ newPassword: 'New secure password' })
      .expect(401);
    await request(app.getHttpServer())
      .put('/auth/me')
      .set(headers(token))
      .send({ email: other.body.user.email, currentPassword: password })
      .expect(409);
    await me(token).expect(200);
    const newEmail = email();
    const result = await request(app.getHttpServer())
      .put('/auth/me')
      .set(headers(token))
      .send({
        email: newEmail,
        newPassword: 'New secure password',
        currentPassword: password,
      })
      .expect(200);
    expect(result.body.reauthenticationRequired).toBe(true);
    await me(token).expect(401);
    await me(second.body.accessToken).expect(401);
    await login(newEmail).expect(401);
    await login(newEmail, 'New secure password').expect(200);
  });
  test('soft-deletes only the current account and denies subsequent use', async () => {
    const created = await register().expect(201);
    const other = await register().expect(201);
    const token = created.body.accessToken;
    await request(app.getHttpServer())
      .delete('/auth/me')
      .set(headers(token))
      .send({ currentPassword: 'wrong' })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/auth/me')
      .set(headers(token))
      .send({ currentPassword: password, userId: other.body.user.id })
      .expect(400);
    await request(app.getHttpServer())
      .delete('/auth/me')
      .set(headers(token))
      .send({ currentPassword: password })
      .expect(204);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: created.body.user.id } }))
        .deletedAt,
    ).not.toBeNull();
    await me(token).expect(401);
    await login(created.body.user.email).expect(401);
    await register(created.body.user.email).expect(409);
    await me(other.body.accessToken).expect(200);
  });
  test('administrator password changes revoke sessions and physical deletion cascades sessions', async () => {
    const created = await register().expect(201);
    await request(app.getHttpServer())
      .put(`/users/${created.body.user.id}`)
      .set(headers(adminToken))
      .send({ password: 'Admin changed password' })
      .expect(200);
    await me(created.body.accessToken).expect(401);
    const second = await login(
      created.body.user.email,
      'Admin changed password',
    ).expect(200);
    await request(app.getHttpServer())
      .delete(`/users/${created.body.user.id}`)
      .set(headers(adminToken))
      .expect(204);
    await me(second.body.accessToken).expect(401);
    expect(
      await db.authSession.count({ where: { userId: created.body.user.id } }),
    ).toBe(0);
  });
  test('logout-all defeats a login verified against an earlier credential version', async () => {
    const created = await register().expect(201);
    const passwords = app.get(PasswordService);
    const original = passwords.verify.bind(passwords);
    let verified!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      verified = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(passwords, 'verify').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      verified();
      await barrier;
      return result;
    });
    const pending = login(created.body.user.email).then((result) => result);
    try {
      await waitFor(entered);
      await request(app.getHttpServer())
        .post('/auth/logout-all')
        .set(headers(created.body.accessToken))
        .expect(204);
    } finally {
      release();
    }
    expect((await pending).status).toBe(401);
    await me(created.body.accessToken).expect(401);
    await login(created.body.user.email).expect(200);
  });
  test('rolls back registration on session persistence failure', async () => {
    const address = email();
    await pool.query(
      `ALTER TABLE auth_sessions ADD CONSTRAINT auth_test_reject CHECK (false) NOT VALID`,
    );
    try {
      await register(address).expect(500);
      expect(await db.user.count({ where: { email: address } })).toBe(0);
    } finally {
      await pool.query(
        'ALTER TABLE auth_sessions DROP CONSTRAINT auth_test_reject',
      );
    }
  });
  test('rejects disallowed origins and oversized credentials; rate limits have Retry-After', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'https://evil.example.test')
      .send({ email: email(), password })
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', 'https://frontend.example.test')
      .expect(204);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(headers('x'.repeat(1100)))
      .expect(400);
    // Temporarily lower only the isolated test instance's limit.
    config.value.auth.rateLimit = 1;
    try {
      const limited = await request(app.getHttpServer())
        .post('/auth/logout')
        .expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['cache-control']).toBe('no-store');
    } finally {
      config.value.auth.rateLimit = 10000;
    }
    config.value.auth.rateLimit = 10000;
  });
  test('cleanup deletes only sufficiently old sessions; live sessions survive', async () => {
    const created = await register().expect(201);
    const old = await db.authSession.create({
      data: {
        userId: created.body.user.id,
        credentialVersion: 0,
        tokenHash: hash(randomUUID()),
        createdAt: new Date(Date.now() - 10 * 86400000),
        expiresAt: new Date(Date.now() - 9 * 86400000),
      },
    });
    const service = app.get(AuthService);
    await (service as unknown as { cleanup(): Promise<void> }).cleanup();
    expect(
      await db.authSession.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    await me(created.body.accessToken).expect(200);
  });
});
