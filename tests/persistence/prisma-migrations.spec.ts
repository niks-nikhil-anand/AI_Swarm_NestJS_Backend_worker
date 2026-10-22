import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const baselinePath =
  'prisma/migrations/20261022000000_add_run_domain/migration.sql';
const domainTables = [
  'runs', 'search_queries', 'search_results', 'browser_actions',
  'artifacts', 'evidence', 'approvals', 'schema_migrations',
];

async function catalog(db: PGlite) {
  const columns = await db.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, datetime_precision
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [domainTables],
  );
  const constraints = await db.query(
    `SELECT t.relname AS table_name, c.conname, c.contype,
            pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
     JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname='public' AND t.relname=ANY($1::text[])
     ORDER BY t.relname,c.conname`,
    [domainTables],
  );
  const indexes = await db.query(
    `SELECT tablename,indexname,indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename=ANY($1::text[])
     ORDER BY tablename,indexname`,
    [domainTables],
  );
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

test('Prisma migration chain preserves the legacy run-domain catalog and rejects blind onboarding', async () => {
  const legacy = new PGlite();
  const fresh = new PGlite();
  try {
    await legacy.exec(readFileSync('src/persistence/migrations/001_initial.sql', 'utf8'));
    await legacy.exec(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    ); INSERT INTO schema_migrations(version) VALUES ('001');`);
    for (const path of [
      'prisma/migrations/20261001000000_add_users/migration.sql',
      'prisma/migrations/20261001000100_add_accounts_remove_user_tenant/migration.sql',
      baselinePath,
    ]) await fresh.exec(readFileSync(path, 'utf8'));

    expect(await catalog(fresh)).toEqual(await catalog(legacy));
    expect((await fresh.query('SELECT version FROM schema_migrations')).rows)
      .toEqual([{ version: '001' }]);
    expect((await fresh.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('users','accounts')`)).rows)
      .toHaveLength(2);

    await expect(legacy.exec(readFileSync(baselinePath, 'utf8'))).rejects.toThrow();
    await legacy.exec('ROLLBACK');
    expect(await catalog(legacy)).toEqual(await catalog(fresh));
  } finally {
    await legacy.close();
    await fresh.close();
  }
}, 60000);
