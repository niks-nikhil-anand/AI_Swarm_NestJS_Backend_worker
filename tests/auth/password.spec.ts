import { PasswordService } from '../../src/users/password.service';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';

const config = () =>
  new ConfigurationService(
    loadConfiguration('search', {
      DATABASE_URL: 'postgresql://user:password@localhost/test',
      AUTH_HASH_CONCURRENCY: '1',
    }),
  );
test('verifies existing scrypt format and rejects wrong, null and attacker-controlled hashes', async () => {
  const passwords = new PasswordService(config());
  const hash = await passwords.hash('A password with spaces ');
  expect(await passwords.verify('A password with spaces ', hash)).toBe(true);
  expect(await passwords.verify('A password with spaces', hash)).toBe(false);
  expect(await passwords.verify('anything', null)).toBe(false);
  expect(
    await passwords.verify('anything', hash.replace('32768', '999999999')),
  ).toBe(false);
  expect(await passwords.verify('anything', 'x'.repeat(10000))).toBe(false);
});
test('bounds concurrent hashing and releases capacity after completion', async () => {
  const passwords = new PasswordService(config());
  const first = passwords.hash('first password');
  await expect(passwords.hash('second password')).rejects.toMatchObject({
    status: 503,
    code: 'AUTH_CAPACITY',
  });
  await first;
  await expect(passwords.hash('third password')).resolves.toMatch(/^scrypt\$/);
});

test('hashes identical passwords with independent salts and both remain verifiable', async () => {
  const passwords = new PasswordService(config());
  const first = await passwords.hash('Identical user password');
  const second = await passwords.hash('Identical user password');
  expect(first).not.toBe(second);
  expect(await passwords.verify('Identical user password', first)).toBe(true);
  expect(await passwords.verify('Identical user password', second)).toBe(true);
});
test.each([
  [
    'unsupported work factor',
    `scrypt$999999999$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`,
  ],
  [
    'unsupported parallelism',
    `scrypt$32768$8$999999$${'00'.repeat(16)}$${'00'.repeat(64)}`,
  ],
  [
    'invalid salt hex',
    `scrypt$32768$8$3$${'zz'.repeat(16)}$${'00'.repeat(64)}`,
  ],
  ['truncated digest', `scrypt$32768$8$3$${'00'.repeat(16)}$00`],
  [
    'unexpected algorithm',
    `bcrypt$32768$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`,
  ],
  ['oversized stored hash', 'x'.repeat(10000)],
])(
  'rejects %s without accepting attacker-selected hash parameters',
  async (_label, hash) => {
    const passwords = new PasswordService(config());
    expect(await passwords.verify('Untrusted password', hash)).toBe(false);
    // Capacity remains available after rejection, demonstrating cleanup of the bounded work slot.
    expect(await passwords.hash('Next valid password')).toMatch(
      /^scrypt\$32768\$8\$3\$/,
    );
  },
);
