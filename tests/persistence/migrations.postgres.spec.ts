import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MIGRATIONS } from '../../src/persistence/migrate';
import { RunRepository } from '../../src/persistence/run.repository';
import { ApprovalRepository } from '../../src/persistence/approval.repository';
import {
  describePostgres,
  freshDatabase,
  runMigrations,
  service,
} from './postgres-database';

const owner = {
  tenantId: 't',
  projectId: 'p',
  userId: 'u',
  requestId: 'r',
  capabilities: ['browser' as const],
};
const versions = MIGRATIONS.map((file) => file.slice(0, 3));

describePostgres('Migrations on real PostgreSQL', () => {
  test('a fresh database: all migrations apply once, and re-running or racing runners is a no-op', async () => {
    const database = await freshDatabase('fresh', false);
    const db = service(database.url);
    try {
      // Three runners at once, as several containers starting together would.
      await Promise.all([1, 2, 3].map(() => runMigrations(database.url)));
      const applied = await db.query<{ version: string; applied_at: Date }>(
        'SELECT version,applied_at FROM schema_migrations ORDER BY version',
      );
      expect(applied.map((row) => row.version)).toEqual(versions);
      await runMigrations(database.url);
      expect(
        await db.query(
          'SELECT version,applied_at FROM schema_migrations ORDER BY version',
        ),
      ).toEqual(applied);
      const constraints = (
        await db.query<{ conname: string }>(
          "SELECT conname FROM pg_constraint WHERE conrelid='approvals'::regclass ORDER BY 1",
        )
      ).map((row) => row.conname);
      expect(constraints).toEqual(
        expect.arrayContaining([
          'approvals_status_check',
          'approvals_outcome_check',
          'approvals_bound_check',
          'approvals_decided_check',
          'approvals_consumed_check',
          'approvals_outcome_state_check',
        ]),
      );
      expect(
        await db.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid='approvals'::regclass AND NOT tgisinternal",
        ),
      ).toEqual([{ tgname: 'approvals_guard' }]);
    } finally {
      await db.onModuleDestroy();
      await database.drop();
    }
  }, 60000);

  test('an existing Phase 4 database upgrades in place and keeps its data', async () => {
    const database = await freshDatabase('existing', false);
    const db = service(database.url);
    try {
      // The schema as Phase 4 left it: migrations 001-003, recorded by the same runner.
      await db.query(
        'CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const file of MIGRATIONS.slice(0, 3)) {
        await db.query(
          readFileSync('src/persistence/migrations/' + file, 'utf8'),
        );
        await db.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          file.slice(0, 3),
        ]);
      }
      const runs = new RunRepository(db);
      const completed = await runs.create(owner, 'browser', { a: 1 }, 'k1');
      await runs.transition(completed, 'RUNNING');
      await runs.transition(completed, 'COMPLETED', { status: 'COMPLETED' });
      const running = await runs.create(owner, 'browser', { a: 2 }, 'k2');
      await runs.transition(running, 'RUNNING');
      await runs.saveEvidence(completed, 'https://example.com/', {
        url: 'https://example.com/',
        text: 'kept',
      });
      // A row in the original approvals shape (never written by Phase 1-4 code, but legal).
      const legacy = randomUUID();
      await db.query(
        "INSERT INTO approvals(id,run_id,payload_hash,status,expires_at) VALUES($1,$2,$3,'PENDING',now()+interval '1 hour')",
        [legacy, running.id, 'e'.repeat(64)],
      );

      await runMigrations(database.url);

      expect(
        (
          await db.query('SELECT version FROM schema_migrations ORDER BY 1')
        ).map((row) => row.version),
      ).toEqual(versions);
      expect((await runs.get(completed.id, 't', 'p')).status).toBe('COMPLETED');
      expect((await runs.get(running.id, 't', 'p')).status).toBe('RUNNING');
      expect(
        await db.query(
          'SELECT count(*)::int AS n FROM evidence WHERE run_id=$1',
          [completed.id],
        ),
      ).toEqual([{ n: 1 }]);
      // The legacy row is kept, has no scope, so no scoped lookup or consumption matches it.
      const approvals = new ApprovalRepository(db);
      await expect(approvals.get(legacy, 't', 'p')).rejects.toMatchObject({
        code: 'APPROVAL_NOT_FOUND',
      });
      await approvals.closeOpen(running, 'RUN_FAILED');
      expect(
        await db.query('SELECT status FROM approvals WHERE id=$1', [legacy]),
      ).toEqual([{ status: 'PENDING' }]);
      // The upgraded schema supports the full Phase 5 flow.
      expect(await runs.transition(running, 'AWAITING_APPROVAL', {})).toBe(
        true,
      );
      const approval = await approvals.request(
        running,
        3,
        {
          action: { kind: 'submit' },
          payloadHash: 'a'.repeat(64),
          pageHash: 'b'.repeat(64),
          pageUrl: 'https://example.com/form',
        },
        600000,
      );
      await approvals.decide(approval, 'APPROVED', 'approver', 'a'.repeat(64));
      expect(
        await approvals.consume(
          running,
          3,
          approval.id,
          'a'.repeat(64),
          'b'.repeat(64),
          'attempt',
        ),
      ).toMatchObject({ status: 'CONSUMED' });
    } finally {
      await db.onModuleDestroy();
      await database.drop();
    }
  }, 60000);
});
