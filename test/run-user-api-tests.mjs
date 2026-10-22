import { config } from 'dotenv';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
config({ quiet: true });
const keys = ['AUTH_API_TEST_DATABASE_URL', 'USER_API_TEST_DATABASE_URL'];
try {
  const targets = keys.map((key) => {
    const value = process.env[key];
    if (!value)
      throw new Error(
        `${key} is required; no fallback to DATABASE_URL is allowed.`,
      );
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
      throw new Error(`${key} must be a PostgreSQL URL.`);
    return { key, value };
  });
  for (const { key, value } of targets) {
    const pool = new Pool({
      connectionString: value,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    try {
      await pool.query('SELECT 1');
    } catch {
      throw new Error(
        `${key} is unreachable. Start test PostgreSQL and check the explicit test URL.`,
      );
    } finally {
      await pool.end();
    }
  }
  console.log(
    'Explicit user/auth PostgreSQL preflight passed. Running only scoped suites.',
  );
  const child = spawn(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--config',
      'test/jest-user-api.json',
      '--runInBand',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: process.env },
  );
  child.on('error', () => {
    console.error('Could not start scoped Jest runner.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'User API test preflight failed.',
  );
  process.exitCode = 1;
}
