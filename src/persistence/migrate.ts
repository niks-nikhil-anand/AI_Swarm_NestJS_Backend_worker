import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigurationService,
  loadConfiguration,
} from '../config/configuration';
import { DatabaseService } from './database.service';

// Applied in order, each once, inside one locked transaction.
export const MIGRATIONS = [
  '001_initial.sql',
  '002_extractions.sql',
  '003_hardening.sql',
  '004_approvals.sql',
  '005_approval_integrity.sql',
];
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
      for (const file of MIGRATIONS) {
        const version = file.slice(0, 3);
        const found = await client.query(
          'SELECT version FROM schema_migrations WHERE version=$1',
          [version],
        );
        if (found.rows.length) continue;
        await client.query(
          await readFile(
            join(process.cwd(), 'src/persistence/migrations', file),
            'utf8',
          ),
        );
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES ($1)',
          [version],
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
