import request from 'supertest';
import { PasswordService } from '../src/users/password.service';
import { UserLockService } from '../src/users/user-lock.service';
import {
  UserApiFixture,
  testPassword,
  freshEmail,
  headers,
  digest,
  publicFields,
  deferred,
  waitFor,
} from './helpers/user-api-test-app';

const live = process.env.AUTH_API_TEST_DATABASE_URL ? describe : describe.skip;
live('User profile, credential updates and deletion', () => {
  const f = new UserApiFixture();
  beforeAll(() => f.start(process.env.AUTH_API_TEST_DATABASE_URL), 60000);
  beforeEach(() => f.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => f.close());
  test('GET selects only the token owner, ignores userId hints and excludes every private field', async () => {
    const first = await f.user(),
      second = await f.user();
    await f.db.account.create({
      data: {
        userId: first.user.id,
        provider: 'github',
        providerId: freshEmail(),
        accessToken: 'private-get-provider-token',
      },
    });
    const result = await request(f.app.getHttpServer())
      .get('/auth/me')
      .query({ userId: second.user.id })
      .set(headers(first.accessToken))
      .send({ userId: second.user.id })
      .expect(200);
    expect(result.body).toEqual(first.user);
    expect(Object.keys(result.body).sort()).toEqual(publicFields);
    expect(JSON.stringify(result.body)).not.toMatch(
      /password|credentialVersion|tokenHash|sessions|accounts|private-get-provider-token/,
    );
  });
  test.each([
    ['name', { name: ' New name ' }, { name: 'New name' }],
    ['null name', { name: null }, { name: null }],
    [
      'avatar',
      { avatar: 'https://example.test/new.png' },
      { avatar: 'https://example.test/new.png' },
    ],
    ['null avatar', { avatar: null }, { avatar: null }],
  ])(
    'PUT updates %s independently and GET returns persisted profile/timestamps',
    async (_label, body, expected) => {
      const user = await f.user({
        name: 'Original',
        avatar: 'https://example.test/old.png',
      });
      const changed = await request(f.app.getHttpServer())
        .put('/auth/me')
        .set(headers(user.accessToken))
        .send(body)
        .expect(200);
      expect(changed.body).toMatchObject({
        user: expected,
        reauthenticationRequired: false,
      });
      const fetched = await f.me(user.accessToken).expect(200);
      expect(fetched.body).toEqual(changed.body.user);
      expect(fetched.body.email).toBe(user.user.email);
      for (const key of ['createdAt', 'updatedAt'])
        expect(new Date(fetched.body[key]).toISOString()).toBe(
          fetched.body[key],
        );
      expect(new Date(fetched.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(user.user.updatedAt).getTime(),
      );
    },
  );
  test.each(['email', 'password'])(
    'PUT %s alone revokes all sessions and requires reauthentication',
    async (field) => {
      const user = await f.user();
      const second = await f.login(user.user.email).expect(200);
      const nextEmail = field === 'email' ? freshEmail() : user.user.email;
      const nextPassword =
        field === 'password' ? 'New password for isolated test' : testPassword;
      const body =
        field === 'email'
          ? { email: nextEmail, currentPassword: testPassword }
          : { newPassword: nextPassword, currentPassword: testPassword };
      const result = await request(f.app.getHttpServer())
        .put('/auth/me')
        .set(headers(user.accessToken))
        .send(body)
        .expect(200);
      expect(result.body.reauthenticationRequired).toBe(true);
      for (const token of [user.accessToken, second.body.accessToken])
        await f.me(token).expect(401);
      const sessions = await f.db.authSession.findMany({
        where: { userId: user.user.id },
      });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      await f.login(nextEmail, nextPassword).expect(200);
      if (field === 'email') await f.login(user.user.email).expect(401);
      else await f.login(user.user.email, testPassword).expect(401);
    },
  );
  test.each([
    ['email missing confirmation', { email: 'changed@example.test' }, 401],
    [
      'email wrong confirmation',
      { email: 'changed@example.test', currentPassword: 'wrong' },
      401,
    ],
    [
      'email null confirmation',
      { email: 'changed@example.test', currentPassword: null },
      400,
    ],
    [
      'password missing confirmation',
      { newPassword: 'A new valid password' },
      401,
    ],
    [
      'password wrong confirmation',
      { newPassword: 'A new valid password', currentPassword: 'wrong' },
      401,
    ],
    [
      'password null confirmation',
      { newPassword: 'A new valid password', currentPassword: null },
      400,
    ],
  ])(
    'PUT rejects %s and leaves state unchanged',
    async (_label, body, status) => {
      const user = await f.user();
      const before = await f.db.user.findUniqueOrThrow({
        where: { id: user.user.id },
      });
      await request(f.app.getHttpServer())
        .put('/auth/me')
        .set(headers(user.accessToken))
        .send(body)
        .expect(status as number);
      expect(
        await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
      ).toEqual(before);
      await f.me(user.accessToken).expect(200);
    },
  );
  test('PUT unchanged normalized email does not require password confirmation or revoke sessions', async () => {
    const user = await f.user();
    const result = await request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(user.accessToken))
      .send({ email: ` ${user.user.email.toUpperCase()} ` })
      .expect(200);
    expect(result.body.reauthenticationRequired).toBe(false);
    await f.me(user.accessToken).expect(200);
  });
  test('PUT body cannot select another user and query hints do not change its target', async () => {
    const first = await f.user(),
      second = await f.user({ name: 'Untouched' });
    await request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(first.accessToken))
      .send({ userId: second.user.id, name: 'Hacked' })
      .expect(400);
    const result = await request(f.app.getHttpServer())
      .put('/auth/me')
      .query({ userId: second.user.id })
      .set(headers(first.accessToken))
      .send({ name: 'Self only' })
      .expect(200);
    expect(result.body.user.id).toBe(first.user.id);
    expect((await f.me(second.accessToken).expect(200)).body.name).toBe(
      'Untouched',
    );
  });
  test.each(['update', 'delete'])(
    'passwordless account cannot bypass %s confirmation',
    async (operation) => {
      const user = await f.user();
      await f.db.user.update({
        where: { id: user.user.id },
        data: { password: null },
      });
      const before = await f.db.user.findUniqueOrThrow({
        where: { id: user.user.id },
      });
      const route = request(f.app.getHttpServer());
      if (operation === 'update')
        await route
          .put('/auth/me')
          .set(headers(user.accessToken))
          .send({
            newPassword: 'Valid new password',
            currentPassword: testPassword,
          })
          .expect(401);
      else
        await route
          .delete('/auth/me')
          .set(headers(user.accessToken))
          .send({ currentPassword: testPassword })
          .expect(401);
      expect(
        await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
      ).toEqual(before);
      await f.me(user.accessToken).expect(200);
    },
  );
  test('concurrent credential updates based on the same version cannot both succeed', async () => {
    const user = await f.user();
    const passwords = f.app.get(PasswordService),
      original = passwords.verify.bind(passwords);
    const both = deferred(),
      release = deferred();
    let arrived = 0;
    jest.spyOn(passwords, 'verify').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++arrived === 2) both.resolve();
      await release.promise;
      return result;
    });
    const first = request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(user.accessToken))
      .send({
        newPassword: 'First replacement password',
        currentPassword: testPassword,
      })
      .then((r) => r);
    const second = request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(user.accessToken))
      .send({
        newPassword: 'Second replacement password',
        currentPassword: testPassword,
      })
      .then((r) => r);
    try {
      await waitFor(both.promise);
    } finally {
      release.resolve();
    }
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(
      (await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }))
        .credentialVersion,
    ).toBe(1);
    expect(
      (await f.db.authSession.findMany()).every((s) => s.revokedAt !== null),
    ).toBe(true);
  });
  test.each(['email', 'password'])(
    'PUT %s rollback preserves the profile, credentials and sessions when revocation fails',
    async (field) => {
      const user = await f.user();
      const before = await f.db.user.findUniqueOrThrow({
        where: { id: user.user.id },
      });
      const body =
        field === 'email'
          ? { email: freshEmail(), currentPassword: testPassword }
          : {
              newPassword: 'New password rollback fixture',
              currentPassword: testPassword,
            };
      await f.failRevocation(async () => {
        await request(f.app.getHttpServer())
          .put('/auth/me')
          .set(headers(user.accessToken))
          .send(body)
          .expect(500);
      });
      expect(
        await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
      ).toEqual(before);
      expect(
        (await f.db.authSession.findMany()).every((s) => s.revokedAt === null),
      ).toBe(true);
      await f.me(user.accessToken).expect(200);
    },
  );
  test('DELETE revokes every caller session, retains user/accounts, and does not touch another user', async () => {
    const user = await f.user(),
      other = await f.user();
    await f.db.account.create({
      data: {
        userId: user.user.id,
        provider: 'google',
        providerId: freshEmail(),
        accessToken: 'retained-provider-fixture',
      },
    });
    const second = await f.login(user.user.email).expect(200);
    await request(f.app.getHttpServer())
      .delete('/auth/me')
      .set(headers(user.accessToken))
      .send({ currentPassword: testPassword })
      .expect(204)
      .expect('');
    const stored = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    expect(stored.deletedAt).not.toBeNull();
    expect(await f.db.account.count({ where: { userId: user.user.id } })).toBe(
      1,
    );
    expect(
      (
        await f.db.authSession.findMany({ where: { userId: user.user.id } })
      ).every((s) => s.revokedAt !== null),
    ).toBe(true);
    for (const token of [user.accessToken, second.body.accessToken])
      await f.me(token).expect(401);
    await request(f.app.getHttpServer())
      .delete('/auth/me')
      .set(headers(user.accessToken))
      .send({ currentPassword: testPassword })
      .expect(401);
    expect(
      await f.db.user.findUniqueOrThrow({ where: { id: user.user.id } }),
    ).toEqual(stored);
    expect((await f.me(other.accessToken).expect(200)).body).toEqual(
      other.user,
    );
  });
  test.each([
    {},
    { currentPassword: null },
    { currentPassword: 7 },
    { currentPassword: 'x', id: 'other' },
  ])('DELETE rejects malformed body %j', async (body) => {
    const user = await f.user();
    await request(f.app.getHttpServer())
      .delete('/auth/me')
      .set(headers(user.accessToken))
      .send(body)
      .expect(400);
    await f.me(user.accessToken).expect(200);
  });
  test('DELETE rollback restores account version and sessions on revocation failure', async () => {
    const user = await f.user();
    const before = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    await f.failRevocation(async () => {
      await request(f.app.getHttpServer())
        .delete('/auth/me')
        .set(headers(user.accessToken))
        .send({ currentPassword: testPassword })
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
  test('DELETE defeats a paused login without creating a session', async () => {
    const user = await f.user();
    const passwords = f.app.get(PasswordService),
      original = passwords.verify.bind(passwords);
    const entered = deferred(),
      release = deferred();
    jest.spyOn(passwords, 'verify').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const pending = f.login(user.user.email).then((r) => r);
    try {
      await waitFor(entered.promise);
      await request(f.app.getHttpServer())
        .delete('/auth/me')
        .set(headers(user.accessToken))
        .send({ currentPassword: testPassword })
        .expect(204);
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe(401);
    expect(await f.db.authSession.count()).toBe(1);
    await f.me(user.accessToken).expect(401);
  });
  test('DELETE wins over a profile update paused before its user lock; account cannot resurrect', async () => {
    const user = await f.user({ name: 'Original' });
    const locks = f.app.get(UserLockService),
      original = locks.lock.bind(locks);
    const entered = deferred(),
      release = deferred();
    jest.spyOn(locks, 'lock').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await original(...args);
    });
    const pending = request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(user.accessToken))
      .send({ name: 'Should not persist' })
      .then((r) => r);
    try {
      await waitFor(entered.promise);
      await request(f.app.getHttpServer())
        .delete('/auth/me')
        .set(headers(user.accessToken))
        .send({ currentPassword: testPassword })
        .expect(204);
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe(401);
    const stored = await f.db.user.findUniqueOrThrow({
      where: { id: user.user.id },
    });
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.name).toBe('Original');
    expect(
      (
        await f.db.authSession.findUniqueOrThrow({
          where: { tokenHash: digest(user.accessToken) },
        })
      ).revokedAt,
    ).not.toBeNull();
  });
});
