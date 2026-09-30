import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigurationService,
  loadConfiguration,
} from '../config/configuration';
import { DatabaseService } from './database.service';

export async function migrate() {
  config({ quiet: true });
  const db = new DatabaseService(
    new ConfigurationService(loadConfiguration('migration')),
  );
  try {
    await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(834923)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const found = await client.query(
        'SELECT version FROM schema_migrations WHERE version=$1',
        ['001'],
      );
      if (!found.rows.length) {
        await client.query(
          await readFile(
            join(process.cwd(), 'src/persistence/migrations/001_initial.sql'),
            'utf8',
          ),
        );
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES ($1)',
          ['001'],
        );
      }
    });
  } finally {
    await db.onModuleDestroy();
  }
}
if (require.main === module)
  void migrate().catch(() => {
    console.error('Database migration failed (connection details redacted)');
    process.exitCode = 1;
  });
