import { ExecutionContext } from '@nestjs/common';
import { AuthRequestGuard } from '../../src/auth/auth-request.guard';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';

function fixture(limit = 2) {
  const config = new ConfigurationService(
    loadConfiguration('search', {
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      AUTH_RATE_LIMIT: String(limit),
      AUTH_ALLOWED_ORIGINS: 'https://frontend.example.test',
    }),
  );
  const guard = new AuthRequestGuard(config);
  const setHeader = jest.fn();
  const context = (
    ip: string | undefined,
    email?: unknown,
    headers: Record<string, string> = {},
  ) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { host: 'api.example.test', ...headers },
          protocol: 'https',
          ip,
          socket: { remoteAddress: 'fallback-ip' },
          body: { email },
        }),
        getResponse: () => ({ setHeader }),
      }),
    }) as unknown as ExecutionContext;
  return { guard, context, setHeader };
}
afterEach(() => jest.restoreAllMocks());
test('account limits survive IP rotation and email normalization', () => {
  const { guard, context } = fixture();
  guard.canActivate(context('one', 'person@example.test'));
  guard.canActivate(context('two', ' PERSON@EXAMPLE.TEST '));
  expect(() =>
    guard.canActivate(context('three', 'person@example.test')),
  ).toThrow('Too many');
  expect(guard.canActivate(context('four', 'other@example.test'))).toBe(true);
});
test('IP limits survive email rotation; Retry-After remains bounded', () => {
  const { guard, context, setHeader } = fixture();
  guard.canActivate(context('one', 'first@example.test'));
  guard.canActivate(context('one', 'second@example.test'));
  expect(() => guard.canActivate(context('one', 'third@example.test'))).toThrow(
    'Too many',
  );
  const value = setHeader.mock.calls.find(
    ([key]) => key === 'Retry-After',
  )?.[1];
  expect(value).toBeGreaterThanOrEqual(1);
  expect(value).toBeLessThanOrEqual(60);
});
test('expired buckets are cleared and requests recover without global fake timers', () => {
  const { guard, context } = fixture(1);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  guard.canActivate(context('one'));
  expect(() => guard.canActivate(context('one'))).toThrow('Too many');
  clock.mockReturnValue(160001);
  expect(guard.canActivate(context('one'))).toBe(true);
});
test('bucket cap bounds distinct clients and expired buckets release capacity', () => {
  const { guard, context } = fixture(10000);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  for (let i = 0; i < 5000; i++)
    guard.canActivate(context(`ip-${i}`, `person-${i}@example.test`));
  expect(() => guard.canActivate(context('overflow'))).toThrow(
    'Authentication capacity exceeded',
  );
  clock.mockReturnValue(160001);
  expect(guard.canActivate(context('recovered'))).toBe(true);
});
test('same-origin and configured origins work; disallowed origins and oversized headers are rejected with no-store', () => {
  const { guard, context, setHeader } = fixture(10);
  expect(
    guard.canActivate(
      context(undefined, undefined, { origin: 'https://api.example.test' }),
    ),
  ).toBe(true);
  expect(
    guard.canActivate(
      context('two', undefined, { origin: 'https://frontend.example.test' }),
    ),
  ).toBe(true);
  expect(() =>
    guard.canActivate(
      context('three', undefined, { origin: 'https://evil.example.test' }),
    ),
  ).toThrow('Origin is not allowed');
  expect(() =>
    guard.canActivate(
      context('four', undefined, { authorization: 'x'.repeat(1025) }),
    ),
  ).toThrow('Invalid authorization header');
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
