import { spawnSync } from 'node:child_process';

test('focused runner fails on missing explicit test URLs and never falls back to application DATABASE_URL', () => {
  const result = spawnSync(process.execPath, ['test/run-user-api-tests.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTH_API_TEST_DATABASE_URL: '',
      USER_API_TEST_DATABASE_URL: '',
      DATABASE_URL: 'postgresql://do-not-use:secret-marker@127.0.0.1/app',
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AUTH_API_TEST_DATABASE_URL is required');
  expect(result.stderr).not.toContain('secret-marker');
  expect(result.stdout).not.toContain('Running only scoped suites');
});
test('focused runner rejects unsupported test URL protocols without revealing credentials', () => {
  const result = spawnSync(process.execPath, ['test/run-user-api-tests.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTH_API_TEST_DATABASE_URL: 'https://secret-marker@example.test',
      USER_API_TEST_DATABASE_URL: '',
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('must be a PostgreSQL URL');
  expect(result.stderr).not.toContain('secret-marker');
});

test('focused runner requires the admin-user test URL before trying any connection', () => {
  const result = spawnSync(process.execPath, ['test/run-user-api-tests.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTH_API_TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
      USER_API_TEST_DATABASE_URL: '',
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('USER_API_TEST_DATABASE_URL is required');
});
test('focused runner fails clearly when explicit test PostgreSQL is unavailable', () => {
  const result = spawnSync(process.execPath, ['test/run-user-api-tests.mjs'], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      AUTH_API_TEST_DATABASE_URL:
        'postgresql://test:secret-marker@127.0.0.1:1/test',
      USER_API_TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AUTH_API_TEST_DATABASE_URL is unreachable');
  expect(result.stderr).not.toContain('secret-marker');
  expect(result.stdout).not.toContain('Running only scoped suites');
});
