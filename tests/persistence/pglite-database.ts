import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { DatabaseService } from '../../src/persistence/database.service';
import { MIGRATIONS } from '../../src/persistence/migrate';

/**
 * In-process PostgreSQL with every migration applied, exposed through the parts of
 * DatabaseService the repositories use. `failNext` makes the next matching statement
 * throw, to simulate a database outage at a precise point.
 */
export async function pgliteDatabase() {
  const pg = new PGlite();
  for (const file of MIGRATIONS)
    await pg.exec(readFileSync('src/persistence/migrations/' + file, 'utf8'));
  const failures: RegExp[] = [];
  const check = (text: string) => {
    const index = failures.findIndex((pattern) => pattern.test(text));
    if (index >= 0) {
      failures.splice(index, 1);
      throw new Error('connection terminated unexpectedly');
    }
  };
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      check(text);
      return (await pg.query(text, values)).rows;
    },
    transaction: async <T>(work: (client: unknown) => Promise<T>) =>
      pg.transaction(async (tx) =>
        work({
          query: async (text: string, values: unknown[] = []) => {
            check(text);
            return tx.query(text, values);
          },
        }),
      ),
  } as unknown as DatabaseService;
  return {
    pg,
    db,
    failNext: (pattern: RegExp) => failures.push(pattern),
  };
}
