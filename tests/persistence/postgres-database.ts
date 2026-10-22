import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { ConfigurationService } from '../../src/config/configuration';
import { DatabaseService } from '../../src/persistence/database.service';
import { migrate } from '../../src/persistence/migrate';

// Real PostgreSQL (same major version as Compose); suites skip when it is not configured.
export const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;
export const describePostgres = POSTGRES_TEST_URL ? describe : describe.skip;

const withDatabase = (database: string) => {
  const url = new URL(POSTGRES_TEST_URL!);
  url.pathname = '/' + database;
  return url.toString();
};

export async function admin<T>(work: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: POSTGRES_TEST_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A new, empty database; with `migrated`, the project's migration runner is applied. */
export async function freshDatabase(prefix: string, migrated = true) {
  const name = prefix + '_' + randomBytes(6).toString('hex');
  await admin((client) => client.query('CREATE DATABASE ' + name));
  const url = withDatabase(name);
  if (migrated) await runMigrations(url);
  return {
    name,
    url,
    drop: () =>
      admin((client) =>
        client.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)'),
      ),
  };
}

// The production runner (advisory lock, schema_migrations), pointed at the test database.
export async function runMigrations(url: string) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    await migrate();
  } finally {
    process.env.DATABASE_URL = previous;
  }
}

/** An independent pool, as a separate API or worker process would hold. */
export const service = (url: string) =>
  new DatabaseService({
    value: { databaseUrl: url },
  } as unknown as ConfigurationService);
