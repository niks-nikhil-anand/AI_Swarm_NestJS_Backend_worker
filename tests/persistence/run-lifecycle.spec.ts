import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { RunRepository, type Run } from '../../src/persistence/run.repository';
import { ArtifactService } from '../../src/artifacts/artifact.service';
import { LocalStorage } from '../../src/artifacts/storage/local.storage';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import { pgliteDatabase } from './pglite-database';

const owner = {
  tenantId: 't',
  projectId: 'p',
  userId: 'u',
  requestId: 'r',
  capabilities: ['browser' as const],
};
const extraction = {
  step: 1,
  url: 'https://example.com/',
  instruction: 'title',
  schemaHash: 'h'.repeat(64),
  schema: { type: 'object' },
  data: { title: 'A' },
  missing: [],
  modelCalls: 2,
  modelTokens: 100,
  retrievedAt: '2026-10-22T10:00:00.000Z',
};

describe('Run lifecycle and durable writes (PGlite)', () => {
  let pg: PGlite,
    runs: RunRepository,
    failNext: (pattern: RegExp) => void,
    db: Awaited<ReturnType<typeof pgliteDatabase>>['db'];
  beforeEach(async () => {
    ({ pg, db, failNext } = await pgliteDatabase());
    runs = new RunRepository(db);
  });
  afterEach(async () => {
    await pg.close();
  });
  const create = () =>
    runs.create(owner, 'browser', { steps: [] }, 'k-' + Math.random());
  const status = async (run: Run) => (await runs.get(run.id, 't', 'p')).status;

  test('only valid transitions apply, and the caller learns whether one did', async () => {
    const run = await create();
    expect(await runs.transition(run, 'COMPLETED')).toBe(false);
    expect(await status(run)).toBe('QUEUED');
    expect(await runs.transition(run, 'RUNNING')).toBe(true);
    // A retried attempt re-entering RUNNING is an idempotent no-op transition.
    expect(await runs.transition(run, 'RUNNING')).toBe(true);
    expect(
      await runs.transition(run, 'COMPLETED', { status: 'COMPLETED' }),
    ).toBe(true);
    for (const next of ['RUNNING', 'FAILED', 'CANCELLED', 'PARTIAL'])
      expect(await runs.transition(run, next)).toBe(false);
    expect(await status(run)).toBe('COMPLETED');
    await expect(runs.transition(run, 'QUEUED')).rejects.toThrow(
      'Invalid run status',
    );
  });

  test('a queued run can be cancelled or failed, but not completed', async () => {
    const a = await create();
    expect(await runs.transition(a, 'CANCELLED')).toBe(true);
    const b = await create();
    expect(await runs.transition(b, 'FAILED')).toBe(true);
    const c = await create();
    expect(await runs.transition(c, 'PARTIAL')).toBe(false);
  });

  test('the execution lease admits one attempt until the owner stops renewing', async () => {
    const run = await create();
    expect(await runs.claimLease(run, 'attempt-1', 60000)).toBe(true);
    expect(await runs.claimLease(run, 'attempt-2', 60000)).toBe(false);
    expect(await runs.claimLease(run, 'attempt-1', 60000)).toBe(true);
    expect(await runs.renewLease(run, 'attempt-2', 60000)).toBeUndefined();
    expect(await runs.renewLease(run, 'attempt-1', 60000)).toBe('QUEUED');
    // Expired: the next attempt takes over and the stale owner can no longer renew.
    await pg.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    expect(await runs.claimLease(run, 'attempt-2', 60000)).toBe(true);
    expect(await runs.renewLease(run, 'attempt-1', 60000)).toBeUndefined();
    await runs.releaseLease(run, 'attempt-1');
    expect(await runs.claimLease(run, 'attempt-3', 60000)).toBe(false);
    await runs.releaseLease(run, 'attempt-2');
    expect(await runs.claimLease(run, 'attempt-3', 60000)).toBe(true);
    // Terminal runs cannot be leased again.
    await runs.transition(run, 'RUNNING');
    await runs.transition(run, 'CANCELLED');
    await runs.releaseLease(run, 'attempt-3');
    expect(await runs.claimLease(run, 'attempt-4', 60000)).toBe(false);
  });

  test('terminal output is recorded once, only for runs that ended without one', async () => {
    const run = await create();
    await runs.transition(run, 'CANCELLED');
    await runs.recordTerminalOutput(run, {
      status: 'CANCELLED',
      partial: true,
    });
    await runs.recordTerminalOutput(run, { status: 'overwritten' });
    expect((await runs.get(run.id, 't', 'p')).output).toEqual({
      status: 'CANCELLED',
      partial: true,
    });
    const active = await create();
    await runs.recordTerminalOutput(active, { status: 'x' });
    expect((await runs.get(active.id, 't', 'p')).output).toBeNull();
  });

  test('evidence and extraction are written together and replays update instead of duplicating', async () => {
    const run = await create();
    const first = await runs.saveSourcedExtraction(
      run,
      'https://example.com/',
      { text: 'v1' },
      extraction,
    );
    const again = await runs.saveSourcedExtraction(
      run,
      'https://example.com/',
      { text: 'v2' },
      { ...extraction, data: { title: 'B' } },
    );
    expect(again).toEqual(first);
    const rows = await pg.query<{ evidence_id: string; data: unknown }>(
      'SELECT evidence_id,data FROM extractions WHERE run_id=$1',
      [run.id],
    );
    expect(rows.rows).toEqual([
      { evidence_id: first.evidenceId, data: { title: 'B' } },
    ]);
    expect(
      (await pg.query('SELECT 1 FROM evidence WHERE run_id=$1', [run.id])).rows,
    ).toHaveLength(1);
    // Foreign keys hold: the extraction points at evidence of the same run.
    const joined = await pg.query(
      'SELECT 1 FROM extractions x JOIN evidence e ON e.id=x.evidence_id AND e.run_id=x.run_id WHERE x.run_id=$1',
      [run.id],
    );
    expect(joined.rows).toHaveLength(1);
  });

  test('a failure while writing the extraction rolls back its evidence', async () => {
    const run = await create();
    failNext(/INSERT INTO extractions/);
    await expect(
      runs.saveSourcedExtraction(
        run,
        'https://example.com/',
        { text: 'v1' },
        extraction,
      ),
    ).rejects.toThrow();
    expect(
      (await pg.query('SELECT 1 FROM evidence WHERE run_id=$1', [run.id])).rows,
    ).toEqual([]);
    expect(
      (await pg.query('SELECT 1 FROM extractions WHERE run_id=$1', [run.id]))
        .rows,
    ).toEqual([]);
  });

  test('a replayed screenshot reuses its artifact and stored file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    const artifacts = new ArtifactService(
      new LocalStorage(
        new ConfigurationService(
          loadConfiguration('search', {
            DATABASE_URL: 'postgresql://u:p@localhost/db',
            ARTIFACT_ROOT: root,
          }),
        ),
      ),
      db,
    );
    const run = await create();
    const first = await artifacts.save(
      run,
      Buffer.from('png-1'),
      'image/png',
      'step-0-screenshot',
    );
    const replay = await artifacts.save(
      run,
      Buffer.from('png-2'),
      'image/png',
      'step-0-screenshot',
    );
    expect(replay.id).toBe(first.id);
    expect(
      (await pg.query('SELECT 1 FROM artifacts WHERE run_id=$1', [run.id]))
        .rows,
    ).toHaveLength(1);
    expect(readdirSync(root)).toEqual([first.id]);
    // Without a key, artifacts stay independent (capture behaviour unchanged).
    await artifacts.save(run, Buffer.from('a'));
    await artifacts.save(run, Buffer.from('b'));
    expect(
      (await pg.query('SELECT 1 FROM artifacts WHERE run_id=$1', [run.id]))
        .rows,
    ).toHaveLength(3);
  });
  // Phase 6: no second write is needed to release a finished or waiting run's lease.
  test('a terminal or approval-waiting transition releases the lease in the same statement', async () => {
    for (const status of ['COMPLETED', 'AWAITING_APPROVAL']) {
      const run = await create();
      expect(await runs.claimLease(run, 'owner', 30000)).toBe(true);
      await runs.transition(run, 'RUNNING');
      expect(
        (await pg.query('SELECT lease_owner FROM runs WHERE id=$1', [run.id]))
          .rows,
      ).toEqual([{ lease_owner: 'owner' }]);
      // Even with the attempt's own release failing (database gone), nothing is held.
      failNext(/lease_owner=NULL/);
      await runs.transition(run, status, { status });
      await runs.releaseLease(run, 'owner').catch(() => undefined);
      expect(
        (
          await pg.query(
            'SELECT lease_owner,lease_expires_at FROM runs WHERE id=$1',
            [run.id],
          )
        ).rows,
      ).toEqual([{ lease_owner: null, lease_expires_at: null }]);
    }
  });
});
