import request from 'supertest';
import { Logger } from '@nestjs/common';
import { PasswordService } from '../src/users/password.service';
import {
  UserApiFixture,
  testPassword,
  freshEmail,
  digest,
  publicFields,
} from './helpers/user-api-test-app';

const live = process.env.AUTH_API_TEST_DATABASE_URL ? describe : describe.skip;
live('User auth registration and login boundaries', () => {
  const f = new UserApiFixture();
  beforeAll(() => f.start(process.env.AUTH_API_TEST_DATABASE_URL), 60000);
  beforeEach(() => f.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.close());
  const invalidBodies: [string, unknown][] = [
    ['missing email', { password: testPassword }],
    ['missing password', { email: 'valid@example.test' }],
    ['null email', { email: null, password: testPassword }],
    ['null password', { email: 'valid@example.test', password: null }],
    ['numeric email', { email: 7, password: testPassword }],
    ['array password', { email: 'valid@example.test', password: [] }],
    ['blank email', { email: '   ', password: testPassword }],
    [
      'nested credentials',
      { credentials: { email: 'valid@example.test', password: testPassword } },
    ],
    ['array body', [{ email: 'valid@example.test', password: testPassword }]],
    [
      'unknown token field',
      {
        email: 'valid@example.test',
        password: testPassword,
        accessToken: 'swu_secret_marker',
      },
    ],
    [
      '7-character password',
      { email: 'valid@example.test', password: 'x'.repeat(7) },
    ],
    [
      '129-character password',
      { email: 'valid@example.test', password: 'x'.repeat(129) },
    ],
    [
      'oversized email',
      {
        email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
        password: testPassword,
      },
    ],
  ];
  test.each(invalidBodies)(
    'register rejects %s without data or secret leakage',
    async (_label, body) => {
      const result = await request(f.app.getHttpServer())
        .post('/auth/register')
        .send(body as object)
        .expect(400);
      expect(result.body).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Request rejected',
          retryable: false,
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(testPassword);
      expect(JSON.stringify(result.body)).not.toContain('swu_secret_marker');
      expect(await f.db.user.count()).toBe(0);
      expect(await f.db.authSession.count()).toBe(0);
    },
  );
  test.each(invalidBodies)(
    'login rejects %s without creating a session',
    async (_label, body) => {
      await request(f.app.getHttpServer())
        .post('/auth/login')
        .send(body as object)
        .expect(400);
      expect(await f.db.authSession.count()).toBe(0);
    },
  );
  test.each([8, 128])(
    'register/login accepts exactly %i password characters',
    async (length) => {
      const password = 'x'.repeat(length);
      const user = await f.user({ password });
      await f.login(user.user.email, password).expect(200);
    },
  );
  test('password whitespace is retained rather than trimmed', async () => {
    const user = await f.user({ password: '  a password with spaces  ' });
    await f.login(user.user.email, 'a password with spaces').expect(401);
    await f.login(user.user.email, '  a password with spaces  ').expect(200);
  });
  test('accepts a 254-character email and a 100-character name', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(email.length).toBe(254);
    const user = await f.user({ email, name: 'n'.repeat(100) });
    expect(user.user.email).toBe(email);
    expect(user.user.name).toHaveLength(100);
  });
  test.each([
    ['long name', { name: 'n'.repeat(101) }],
    ['blank name', { name: ' ' }],
    ['long avatar', { avatar: 'https://example.test/' + 'x'.repeat(2048) }],
    ['javascript avatar', { avatar: 'javascript:alert(1)' }],
    ['file avatar', { avatar: 'file:///tmp/avatar.png' }],
  ])('register rejects %s', async (_label, body) => {
    await f.register(body as Record<string, unknown>).expect(400);
  });
  test.each([
    [
      'provided profile',
      { name: ' Person ', avatar: 'https://example.test/avatar.png' },
      { name: 'Person', avatar: 'https://example.test/avatar.png' },
    ],
    [
      'nullable profile',
      { name: null, avatar: null },
      { name: null, avatar: null },
    ],
    [
      'maximum avatar',
      {
        avatar:
          'https://example.test/' +
          'x'.repeat(2048 - 'https://example.test/'.length),
      },
      {
        avatar:
          'https://example.test/' +
          'x'.repeat(2048 - 'https://example.test/'.length),
      },
    ],
  ])('register stores %s', async (_label, input, expected) => {
    const user = await f.user(input);
    expect(user.user).toMatchObject(expected);
    expect((await f.me(user.accessToken).expect(200)).body).toMatchObject(
      expected,
    );
  });
  test('duplicate registration does not change credentials/profile or add a session', async () => {
    const user = await f.user({ name: 'Original' });
    const before = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    await f
      .register({
        email: user.user.email.toUpperCase(),
        password: 'Different secret password',
        name: 'Attacker',
      })
      .expect(409);
    expect(
      await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
    ).toEqual(before);
    expect(
      await f.db.authSession.count({ where: { userId: user.user.id } }),
    ).toBe(1);
    await f.login(user.user.email).expect(200);
  });
  test('login normalizes email, issues unique tokens and uses configured expiry without exposing provider secrets', async () => {
    const user = await f.user();
    await f.db.account.create({
      data: {
        userId: user.user.id,
        provider: 'google',
        providerId: freshEmail(),
        accessToken: 'private-provider-secret',
        refreshToken: 'private-refresh-secret',
      },
    });
    f.config.value.auth.sessionTtlSeconds = 120;
    const before = Date.now();
    const first = await f
      .login(` ${user.user.email.toUpperCase()} `)
      .expect(200);
    const second = await f.login(user.user.email).expect(200);
    expect(
      new Set([
        user.accessToken,
        first.body.accessToken,
        second.body.accessToken,
      ]).size,
    ).toBe(3);
    for (const result of [first, second]) {
      expect(Object.keys(result.body).sort()).toEqual([
        'accessToken',
        'expiresAt',
        'tokenType',
        'user',
      ]);
      expect(Object.keys(result.body.user).sort()).toEqual(publicFields);
      expect(new Date(result.body.expiresAt).getTime()).toBeGreaterThanOrEqual(
        before + 120000,
      );
      expect(new Date(result.body.expiresAt).getTime()).toBeLessThanOrEqual(
        Date.now() + 120000,
      );
      const stored = await f.db.authSession.findUniqueOrThrow({
        where: { tokenHash: digest(result.body.accessToken) },
      });
      expect(stored.expiresAt.toISOString()).toBe(result.body.expiresAt);
      const json = JSON.stringify(result.body);
      expect(json).not.toMatch(
        /password|credentialVersion|tokenHash|private-provider-secret|private-refresh-secret/,
      );
    }
  });
  test('failed login preserves user and session state', async () => {
    const user = await f.user();
    const before = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    const sessions = await f.db.authSession.findMany({
      where: { userId: user.user.id },
    });
    await f.login(user.user.email, 'Wrong secret password').expect(401);
    expect(
      await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
    ).toEqual(before);
    expect(
      await f.db.authSession.findMany({ where: { userId: user.user.id } }),
    ).toEqual(sessions);
  });
  test('login at hash capacity returns 503 without inserting a session', async () => {
    const user = await f.user();
    const passwords = f.app.get(PasswordService);
    f.config.value.auth.hashConcurrency = 1;
    const occupied = passwords.hash('Capacity fixture password');
    try {
      await f.login(user.user.email).expect(503);
    } finally {
      await occupied;
    }
    expect(await f.db.authSession.count()).toBe(1);
    await f.login(user.user.email).expect(200);
  });
  test('auth audit logs never contain raw credentials, token digests or OAuth secrets', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const user = await f.user({ password: 'Unique password audit marker' });
    await f.db.account.create({
      data: {
        userId: user.user.id,
        provider: 'google',
        providerId: freshEmail(),
        accessToken: 'Unique OAuth audit marker',
      },
    });
    const result = await f
      .login(user.user.email, 'Unique password audit marker')
      .expect(200);
    await request(f.app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${result.body.accessToken}`)
      .expect(204);
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain('login_succeeded');
    for (const secret of [
      'Unique password audit marker',
      'Unique OAuth audit marker',
      user.accessToken,
      result.body.accessToken,
      digest(user.accessToken),
      digest(result.body.accessToken),
    ])
      expect(output).not.toContain(secret);
  });
});
