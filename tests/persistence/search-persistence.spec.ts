import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { DatabaseService } from '../../src/persistence/database.service';
import { RunRepository } from '../../src/persistence/run.repository';
import { SearchExecutionService } from '../../src/search/search-execution.service';
import { SearxngClient } from '../../src/search/clients/searxng.client';
import type { ExecutionContext } from '../../src/common/types/execution-context';

describe('PostgreSQL search persistence', () => {
  let pg: PGlite;
  let db: DatabaseService;
  let runs: RunRepository;
  const ctx: ExecutionContext = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    userId: 'user-a',
    requestId: 'req',
    capabilities: ['search'],
  };
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(
      readFileSync('src/persistence/migrations/001_initial.sql', 'utf8'),
    );
    db = {
      query: async (text: string, values: unknown[] = []) =>
        (await pg.query(text, values)).rows,
      transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        pg.transaction((tx) =>
          work({
            query: (text: string, values: unknown[]) => tx.query(text, values),
          }),
        ),
    } as unknown as DatabaseService;
    runs = new RunRepository(db);
  }, 30000);
  afterAll(async () => {
    await pg.close();
  });
  test('idempotency conflict and ownership are enforced', async () => {
    const run = await runs.create(
      ctx,
      'search',
      { queries: ['one'] },
      'key-one',
    );
    expect(
      (await runs.create(ctx, 'search', { queries: ['one'] }, 'key-one')).id,
    ).toBe(run.id);
    await expect(
      runs.create(ctx, 'search', { queries: ['other'] }, 'key-one'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      runs.get(run.id, 'other', ctx.projectId),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });
  test('duplicate activity delivery persists one result and cancellation cannot regress', async () => {
    const run = await runs.create(
      ctx,
      'search',
      { queries: ['topic'], safeSearch: 1, maxCandidates: 5 },
      'key-two',
    );
    const client = {
      search: jest.fn(async () => ({
        results: [{ url: 'https://example.com', title: 'Example' }],
      })),
    } as unknown as SearxngClient;
    const service = new SearchExecutionService(client, db, runs);
    const job = {
      runId: run.id,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
    };
    await service.execute(job);
    await service.execute(job);
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(await runs.results(run)).toHaveLength(1);
    const cancelled = await runs.create(
      ctx,
      'search',
      { queries: ['topic'] },
      'key-three',
    );
    await runs.transition(cancelled, 'CANCELLED');
    await runs.transition(cancelled, 'RUNNING');
    expect(
      (await runs.get(cancelled.id, ctx.tenantId, ctx.projectId)).status,
    ).toBe('CANCELLED');
  });
  test('resumed discovery preserves persisted partial warnings', async () => {
    const run = await runs.create(
      ctx,
      'search',
      { queries: ['saved'], maxCandidates: 5 },
      'recovery-key',
    );
    await db.query(
      'INSERT INTO search_queries(run_id,query_index,query,status,warning_codes) VALUES($1,0,$2,$3,$4)',
      [run.id, 'saved', 'PARTIAL', JSON.stringify(['ENGINE_PARTIAL_FAILURE'])],
    );
    const client = { search: jest.fn() } as unknown as SearxngClient;
    const service = new SearchExecutionService(client, db, runs);
    const output = await service.execute({
      runId: run.id,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
    });
    expect(output).toMatchObject({
      status: 'PARTIAL',
      warnings: ['ENGINE_PARTIAL_FAILURE'],
    });
    expect(client.search).not.toHaveBeenCalled();
  });
});
