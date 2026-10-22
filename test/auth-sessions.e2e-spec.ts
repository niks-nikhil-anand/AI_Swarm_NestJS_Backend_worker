import request from 'supertest';
import {
  UserApiFixture,
  testPassword,
  headers,
  digest,
} from './helpers/user-api-test-app';
const live = process.env.AUTH_API_TEST_DATABASE_URL ? describe : describe.skip;
live('User auth session isolation and HTTP controls', () => {
  const f = new UserApiFixture();
  beforeAll(() => f.start(process.env.AUTH_API_TEST_DATABASE_URL), 60000);
  beforeEach(() => f.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.close());
  test.each(['malformed', 'expired', 'revoked'])(
    'logout is empty, no-store and idempotent for %s tokens',
    async (kind) => {
      const user = await f.user();
      if (kind === 'expired') await f.expire(user.accessToken);
      if (kind === 'revoked')
        await f.db.authSession.updateMany({ data: { revokedAt: new Date() } });
      const token = kind === 'malformed' ? 'bad' : user.accessToken;
      for (let i = 0; i < 2; i++) {
        const result = await request(f.app.getHttpServer())
          .post('/auth/logout')
          .set(headers(token))
          .expect(204);
        expect(result.text).toBe('');
        expect(result.headers['cache-control']).toBe('no-store');
      }
    },
  );
  test('logout body cannot revoke another user session', async () => {
    const first = await f.user(),
      other = await f.user();
    await request(f.app.getHttpServer())
      .post('/auth/logout')
      .set(headers(first.accessToken))
      .send({ userId: other.user.id, accessToken: other.accessToken })
      .expect(204);
    await f.me(first.accessToken).expect(401);
    await f.me(other.accessToken).expect(200);
  });
  test('failed logout does not claim revocation or alter another session', async () => {
    const user = await f.user(),
      other = await f.user();
    await f.failRevocation(async () => {
      const result = await request(f.app.getHttpServer())
        .post('/auth/logout')
        .set(headers(user.accessToken))
        .expect(500);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toEqual({
        error: {
          code: 'REQUEST_FAILED',
          message: 'Service unavailable',
          retryable: false,
        },
      });
    });
    await f.me(user.accessToken).expect(200);
    await f.me(other.accessToken).expect(200);
  });
  test('logout-all revokes every caller session and leaves all other-user sessions active', async () => {
    const first = await f.user(),
      other = await f.user();
    const first2 = await f.login(first.user.email).expect(200),
      other2 = await f.login(other.user.email).expect(200);
    await request(f.app.getHttpServer())
      .post('/auth/logout-all')
      .set(headers(first.accessToken))
      .expect(204)
      .expect('');
    for (const token of [first.accessToken, first2.body.accessToken])
      await f.me(token).expect(401);
    for (const token of [other.accessToken, other2.body.accessToken])
      await f.me(token).expect(200);
    expect(
      (
        await f.db.authSession.findMany({ where: { userId: first.user.id } })
      ).every((s) => s.revokedAt !== null),
    ).toBe(true);
    expect(
      (
        await f.db.authSession.findMany({ where: { userId: other.user.id } })
      ).every((s) => s.revokedAt === null),
    ).toBe(true);
  });
  test('concurrent logout-all requests allow one success, deny stale work and retain fully revoked state', async () => {
    const user = await f.user();
    const results = await Promise.all(
      [1, 2].map(() =>
        request(f.app.getHttpServer())
          .post('/auth/logout-all')
          .set(headers(user.accessToken)),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
    expect(
      (await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }))
        .credentialVersion,
    ).toBe(1);
    expect(
      (await f.db.authSession.findMany()).every((s) => s.revokedAt !== null),
    ).toBe(true);
  });
  test('logout-all rolls back both version and session changes if revocation fails', async () => {
    const user = await f.user();
    const before = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    await f.failRevocation(async () => {
      await request(f.app.getHttpServer())
        .post('/auth/logout-all')
        .set(headers(user.accessToken))
        .expect(500);
    });
    expect(
      await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
    ).toEqual(before);
    expect(
      (await f.db.authSession.findMany()).every((s) => s.revokedAt === null),
    ).toBe(true);
    await f.me(user.accessToken).expect(200);
  });
  const protectedRoutes = [
    ['get', '/auth/me'],
    ['put', '/auth/me'],
    ['delete', '/auth/me'],
    ['post', '/auth/logout-all'],
  ] as const;
  for (const [method, path] of protectedRoutes) {
    test.each(['missing', 'malformed', 'expired', 'revoked'])(
      `${method.toUpperCase()} ${path} rejects %s session and disables caching`,
      async (kind) => {
        const user = await f.user();
        if (kind === 'expired') await f.expire(user.accessToken);
        if (kind === 'revoked')
          await f.db.authSession.updateMany({
            data: { revokedAt: new Date() },
          });
        let req = request(f.app.getHttpServer())[method](path);
        if (kind !== 'missing')
          req = req.set(
            headers(kind === 'malformed' ? 'bad' : user.accessToken),
          );
        const result = await req
          .send({ name: 'Never applied', currentPassword: testPassword })
          .expect(401);
        expect(result.headers['cache-control']).toBe('no-store');
        expect(
          (await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }))
            .deletedAt,
        ).toBeNull();
      },
    );
  }
  test.each([
    'register',
    'login',
    'logout',
    'logout-all',
    'get',
    'put',
    'delete',
  ])('%s successful responses are no-store', async (operation) => {
    const user = await f.user();
    const server = f.app.getHttpServer();
    let result;
    switch (operation) {
      case 'register':
        result = await f.register().expect(201);
        break;
      case 'login':
        result = await f.login(user.user.email).expect(200);
        break;
      case 'logout':
        result = await request(server)
          .post('/auth/logout')
          .set(headers(user.accessToken))
          .expect(204);
        break;
      case 'logout-all':
        result = await request(server)
          .post('/auth/logout-all')
          .set(headers(user.accessToken))
          .expect(204);
        break;
      case 'get':
        result = await f.me(user.accessToken).expect(200);
        break;
      case 'put':
        result = await request(server)
          .put('/auth/me')
          .set(headers(user.accessToken))
          .send({ name: 'Updated' })
          .expect(200);
        break;
      default:
        result = await request(server)
          .delete('/auth/me')
          .set(headers(user.accessToken))
          .send({ currentPassword: testPassword })
          .expect(204);
    }
    expect(result.headers['cache-control']).toBe('no-store');
  });
  test.each(['register', 'login'])(
    '%s rejected responses are no-store',
    async (route) => {
      const result = await request(f.app.getHttpServer())
        .post(`/auth/${route}`)
        .send({})
        .expect(400);
      expect(result.headers['cache-control']).toBe('no-store');
    },
  );
  test('expired sessions fail immediately without any cleanup job deleting the record', async () => {
    const user = await f.user();
    await f.expire(user.accessToken);
    await f.me(user.accessToken).expect(401);
    const session = await f.db.authSession.findUniqueOrThrow({
      where: { tokenHash: digest(user.accessToken) },
    });
    expect(session.revokedAt).toBeNull();
    expect(session.expiresAt.getTime()).toBeLessThan(Date.now());
  });
  test('CORS preflight uses production origin, method and authorization-header settings', async () => {
    const origin = 'https://frontend.example.test';
    const allowed = await request(f.app.getHttpServer())
      .options('/auth/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    expect(allowed.headers['access-control-allow-methods'].split(',')).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
    ]);
    expect(
      allowed.headers['access-control-allow-headers'].toLowerCase(),
    ).toContain('authorization');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const denied = await request(f.app.getHttpServer())
      .options('/auth/me')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const user = await f.user();
    const actual = await f
      .me(user.accessToken)
      .set('Origin', origin)
      .expect(200);
    expect(actual.headers['access-control-allow-origin']).toBe(origin);
    await f
      .me(user.accessToken)
      .set('Origin', 'https://evil.example.test')
      .expect(403);
  });
  test('admin email change revokes all sessions; admin profile change preserves them', async () => {
    const user = await f.user();
    const second = await f.login(user.user.email).expect(200);
    await request(f.app.getHttpServer())
      .put(`/users/${user.user.id}`)
      .set(headers(f.adminToken))
      .send({ name: 'Admin profile update' })
      .expect(200);
    for (const token of [user.accessToken, second.body.accessToken])
      await f.me(token).expect(200);
    await request(f.app.getHttpServer())
      .put(`/users/${user.user.id}`)
      .set(headers(f.adminToken))
      .send({ email: 'admin-changed@example.test' })
      .expect(200);
    for (const token of [user.accessToken, second.body.accessToken])
      await f.me(token).expect(401);
    await f.login('admin-changed@example.test').expect(200);
  });
  test.each(['get', 'put', 'delete'] as const)(
    'user token cannot %s another user through the admin API',
    async (method) => {
      const first = await f.user(),
        second = await f.user();
      await request(f.app.getHttpServer())
        [method](`/users/${second.user.id}`)
        .set(headers(first.accessToken))
        .send({ name: 'Forbidden' })
        .expect(401);
      expect((await f.me(second.accessToken).expect(200)).body).toEqual(
        second.user,
      );
    },
  );
  test('failed admin email conflict preserves credentials and every existing session', async () => {
    const first = await f.user(),
      second = await f.user();
    const session2 = await f.login(first.user.email).expect(200);
    const before = await f.db.user.findUniqueOrThrow({
      where: { id: first.user.id },
    });
    await request(f.app.getHttpServer())
      .put(`/users/${first.user.id}`)
      .set(headers(f.adminToken))
      .send({
        email: second.user.email,
        password: 'Should not persist password',
      })
      .expect(409);
    expect(
      await f.db.user.findUniqueOrThrow({ where: { id: first.user.id } }),
    ).toEqual(before);
    for (const token of [first.accessToken, session2.body.accessToken])
      await f.me(token).expect(200);
    await f.login(first.user.email).expect(200);
  });
});

live('User API PostgreSQL outage handling', () => {
  const f = new UserApiFixture();
  beforeAll(() => f.start(process.env.AUTH_API_TEST_DATABASE_URL, true), 60000);
  afterAll(() => f.close());
  test('actual unavailable database never authenticates, creates a user or reports successful logout', async () => {
    const server = f.app.getHttpServer();
    const calls = [
      () =>
        request(server)
          .post('/auth/register')
          .send({ email: 'outage@example.test', password: testPassword }),
      () =>
        request(server)
          .post('/auth/login')
          .send({ email: 'outage@example.test', password: testPassword }),
      () =>
        request(server)
          .get('/auth/me')
          .set(headers(`swu_${'a'.repeat(43)}`)),
      () =>
        request(server)
          .post('/auth/logout')
          .set(headers(`swu_${'a'.repeat(43)}`)),
    ];
    for (const call of calls) {
      const result = await call().expect(500);
      expect(result.body).toEqual({
        error: {
          code: 'REQUEST_FAILED',
          message: 'Service unavailable',
          retryable: false,
        },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(result.body)).not.toMatch(
        /postgres|127\.0\.0\.1|password|tokenHash/,
      );
    }
    expect(
      (await f.pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0]
        .count,
    ).toBe(0);
  });
});
