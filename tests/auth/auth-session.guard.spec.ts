import { ExecutionContext } from '@nestjs/common';
import { AuthSessionGuard } from '../../src/auth/auth-session.guard';
import { AuthService } from '../../src/auth/auth.service';
const context = (req: object) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as ExecutionContext;
test.each([
  undefined,
  'Bearer bad',
  'Basic secret',
  'Bearer swu_short',
  'Bearer legacy-admin-token',
])(
  'session guard rejects %s without any configured-token fallback',
  async (authorization) => {
    const authenticate = jest.fn();
    const guard = new AuthSessionGuard({
      authenticate,
    } as unknown as AuthService);
    await expect(
      guard.canActivate(context({ headers: { authorization } })),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID', status: 401 });
    expect(authenticate).not.toHaveBeenCalled();
  },
);
test('verified identity is attached from session lookup and request-supplied identities are ignored', async () => {
  const identity = {
    userId: 'owner',
    sessionId: 'session',
    credentialVersion: 3,
  };
  const authenticate = jest.fn().mockResolvedValue(identity);
  const guard = new AuthSessionGuard({
    authenticate,
  } as unknown as AuthService);
  const req = {
    headers: { authorization: `Bearer swu_${'a'.repeat(43)}` },
    auth: { userId: 'attacker' },
  };
  await expect(guard.canActivate(context(req))).resolves.toBe(true);
  expect(req.auth).toEqual(identity);
});
test('revoked session failure propagates without granting a supplied identity', async () => {
  const error = new Error('Invalid session');
  const guard = new AuthSessionGuard({
    authenticate: jest.fn().mockRejectedValue(error),
  } as unknown as AuthService);
  await expect(
    guard.canActivate(
      context({ headers: { authorization: `Bearer swu_${'a'.repeat(43)}` } }),
    ),
  ).rejects.toThrow(error);
});
