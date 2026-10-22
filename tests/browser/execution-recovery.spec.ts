import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { BrowserExecutionService } from '../../src/browser/browser-execution.service';
import { RunRepository, type Run } from '../../src/persistence/run.repository';
import type { ArtifactService } from '../../src/artifacts/artifact.service';
import type { SessionManagerService } from '../../src/browser/services/session-manager.service';
import type { BrowserService } from '../../src/browser/services/browser.service';
import type { BrowserAction } from '../../src/browser/contracts/browser-action';
import type { BrowserResult } from '../../src/browser/contracts/browser-result';
import { BrowserError } from '../../src/common/errors/browser.errors';
import { PolicyError } from '../../src/common/errors/policy.errors';
import {
  runBrowserTask,
  summarize,
  type ActivityContext,
} from '../../src/workers/browser/activity-bindings';
import { pgliteDatabase } from '../persistence/pglite-database';
import { ApprovalRepository } from '../../src/persistence/approval.repository';
import type { ConfigurationService } from '../../src/config/configuration';

const owner = {
  tenantId: 't',
  projectId: 'p',
  userId: 'u',
  requestId: 'r',
  capabilities: ['browser' as const],
};
const START = 'https://example.com/start';
const NEXT = 'https://example.com/next';
type Script = Partial<
  Record<BrowserAction['kind'], (action: BrowserAction) => unknown>
>;

/**
 * Real BrowserExecutionService, RunRepository and SQL (PGlite with all migrations); the
 * browser is a scripted fake so every failure point can be triggered deterministically.
 */
function harness(
  db: Awaited<ReturnType<typeof pgliteDatabase>>['db'],
  script: Script = {},
) {
  let url = 'about:blank';
  const executed: BrowserAction['kind'][] = [];
  const closed: string[] = [];
  const inFlight: ((error: Error) => void)[] = [];
  const blockUntilClosed = () =>
    new Promise<never>((_, reject) => inFlight.push(reject));
  const createSession = jest.fn(async () => ({
    id: 'session-' + randomUUID(),
    tabs: new Map([['tab-0', { url: () => url, isClosed: () => false }]]),
  }));
  const sessions = {
    create: createSession,
  } as unknown as SessionManagerService;
  const defaults: Script = {
    open: (action) => {
      url = (action as { url: string }).url;
      return { url };
    },
    click: () => {
      url = NEXT;
      return { clicked: true };
    },
    extract: () => ({ url, title: 'Page ' + url, text: 'Text of ' + url }),
    observe: () => ({ url, title: 't', elements: [] }),
  };
  const browser = {
    execute: jest.fn(
      async (
        _session: string,
        _actor: unknown,
        action: BrowserAction,
      ): Promise<BrowserResult> => {
        executed.push(action.kind);
        const started = Date.now();
        try {
          const data = await (
            script[action.kind] ||
            defaults[action.kind] ||
            (() => ({}))
          )(action);
          return {
            actionId: randomUUID(),
            status: 'success',
            data,
            durationMs: Date.now() - started,
          };
        } catch (error) {
          const e = error as BrowserError;
          return {
            actionId: randomUUID(),
            status: 'failed',
            error: { code: e.code, message: e.message, retryable: e.retryable },
            durationMs: 0,
          };
        }
      },
    ),
    // Closing the session ends any action still in progress, as a real browser close does.
    close: jest.fn(async (id: string) => {
      closed.push(id);
      for (const end of inFlight.splice(0))
        end(new BrowserError('BROWSER_ACTION_FAILED', 'Session closed'));
    }),
  } as unknown as BrowserService;
  const artifacts = {
    save: jest.fn(async () => ({ id: randomUUID() })),
  } as unknown as ArtifactService;
  const runs = new RunRepository(db);
  const approvals = new ApprovalRepository(db);
  const config = {
    value: { approvals: { ttlMs: 600000, distinctApprover: true } },
  } as unknown as ConfigurationService;
  const service = new BrowserExecutionService(
    runs,
    db,
    sessions,
    browser,
    artifacts,
    approvals,
    config,
  );
  return {
    service,
    runs,
    approvals,
    executed,
    closed,
    createSession,
    blockUntilClosed,
    setFingerprint: (next: (action: BrowserAction) => unknown) =>
      (script.fingerprint = next),
  };
}

describe('Execution recovery and failure handling (PGlite, scripted browser)', () => {
  let pg: PGlite, ctx: Awaited<ReturnType<typeof pgliteDatabase>>;
  beforeEach(async () => {
    ctx = await pgliteDatabase();
    pg = ctx.pg;
  });
  afterEach(async () => {
    await pg.close();
  });
  const submit = (runs: RunRepository, steps: unknown[]) =>
    runs.create(
      owner,
      'browser',
      { steps, maxStepAttempts: 1 },
      'k-' + Math.random(),
    );
  const job = (run: Run) => ({ runId: run.id, tenantId: 't', projectId: 'p' });
  const count = async (table: string, run: Run) =>
    (await pg.query(`SELECT 1 FROM ${table} WHERE run_id=$1`, [run.id])).rows
      .length;
  const stored = async (runs: RunRepository, run: Run) =>
    runs.get(run.id, 't', 'p');

  test('a database outage while saving evidence ends the attempt; the retry completes without duplicates', async () => {
    const h = harness(ctx.db);
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    ctx.failNext(/INSERT INTO evidence/);
    await expect(
      h.service.execute(job(run), undefined, () => undefined, {
        attempt: 1,
        final: false,
      }),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_UNAVAILABLE',
      retryable: true,
    });
    // Still RUNNING for the next attempt; the lease was released; the browser was closed.
    const after = await pg.query<{
      status: string;
      lease_owner: string | null;
    }>('SELECT status,lease_owner FROM runs WHERE id=$1', [run.id]);
    expect(after.rows[0]).toEqual({ status: 'RUNNING', lease_owner: null });
    // Closed by the cancellation and again by the cleanup; close is idempotent.
    expect(new Set(h.closed).size).toBe(1);
    const output = (await h.service.execute(
      job(run),
      undefined,
      () => undefined,
      { attempt: 2, final: false },
    )) as { status: string };
    expect(output.status).toBe('COMPLETED');
    expect(await count('evidence', run)).toBe(1);
  });

  test('after a click, a storage outage is never followed by a replayed click', async () => {
    const h = harness(ctx.db);
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'click', target: { kind: 'role', role: 'link', name: 'Next' } },
      { kind: 'read' },
    ]);
    ctx.failNext(/INSERT INTO evidence/);
    await expect(
      h.service.execute(job(run), undefined, () => undefined, {
        attempt: 1,
        final: false,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    const output = (await h.service.execute(
      job(run),
      undefined,
      () => undefined,
      { attempt: 2, final: false },
    )) as {
      status: string;
      warnings: string[];
      steps: { index: number; kind: string; status: string }[];
    };
    expect(output).toMatchObject({
      status: 'PARTIAL',
      warnings: ['RESUME_UNSAFE'],
    });
    expect(output.steps.map((s) => [s.index, s.kind, s.status])).toEqual([
      [0, 'navigate', 'success'],
      [1, 'click', 'success'],
    ]);
    expect(h.executed.filter((kind) => kind === 'click')).toHaveLength(1);
    expect((await stored(h.runs, run)).status).toBe('PARTIAL');
  });

  test('a duplicate attempt waits for the lease and returns the stored result without re-executing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(ctx.db, {
      open: async (action) => {
        await gate;
        return { url: (action as { url: string }).url };
      },
    });
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    const first = h.service.execute(job(run));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const duplicate = h.service.execute(job(run));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The duplicate never started a browser while the first attempt held the lease.
    expect(h.createSession).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(b).toEqual(a);
    expect(h.executed.filter((kind) => kind === 'open')).toHaveLength(1);
    expect(await count('evidence', run)).toBe(1);
  });

  test('a stalled attempt that lost its lease stops without overwriting the run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const h = harness(ctx.db, {
      open: async (action) => {
        if (++calls === 1) await gate;
        return { url: (action as { url: string }).url };
      },
    });
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    const stalled = h.service.execute(job(run), undefined, () => undefined, {
      attempt: 1,
      final: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Its lease expires (no renewals), and Temporal's next attempt takes over and finishes.
    await pg.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    const takeover = (await h.service.execute(
      job(run),
      undefined,
      () => undefined,
      { attempt: 2, final: false },
    )) as { status: string };
    expect(takeover.status).toBe('COMPLETED');
    release();
    await expect(stalled).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await stored(h.runs, run)).status).toBe('COMPLETED');
    expect(await count('evidence', run)).toBe(1);
  });

  test('cancellation through the API keeps completed steps and evidence as a partial result', async () => {
    const h = harness(ctx.db, {
      click: async () => {
        // Cancelled by the API while this step runs.
        await pg.query(
          "UPDATE runs SET status='CANCELLED' WHERE status='RUNNING'",
        );
        return { clicked: true };
      },
    });
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
      { kind: 'click', target: { kind: 'css', selector: 'a' } },
      { kind: 'read' },
    ]);
    await expect(h.service.execute(job(run))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const final = await stored(h.runs, run);
    expect(final.status).toBe('CANCELLED');
    expect(final.output).toMatchObject({
      status: 'CANCELLED',
      partial: true,
      warnings: ['CANCELLED'],
      evidence: [{ url: START }],
    });
    // Closed by the cancellation and again by the cleanup; close is idempotent.
    expect(new Set(h.closed).size).toBe(1);
  });

  test('a cancellation in the database stops a step stuck in progress within one renewal', async () => {
    let block: () => Promise<never> = () => new Promise(() => undefined);
    const h = harness(ctx.db, { extract: () => block() });
    block = h.blockUntilClosed;
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    const started = Date.now();
    const pending = h.service.execute(job(run));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The API cancelled the run; no Temporal cancellation reaches this attempt.
    await pg.query("UPDATE runs SET status='CANCELLED' WHERE id=$1", [run.id]);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(8000);
    // Closed by the cancellation and again by the cleanup; close is idempotent.
    expect(new Set(h.closed).size).toBe(1);
    const lease = await pg.query<{ lease_owner: string | null }>(
      'SELECT lease_owner FROM runs WHERE id=$1',
      [run.id],
    );
    expect(lease.rows[0].lease_owner).toBeNull();
  }, 15000);

  // Phase 6: the API's cancel transition also releases the lease; renewal must still read
  // that as a cancellation (not a takeover), record what ran and report CANCELLED.
  test('an API cancellation during an approved action is a cancellation, with the action recorded', async () => {
    let block: () => Promise<never> = () => new Promise(() => undefined);
    const h = harness(ctx.db, {
      fingerprint: () => ({
        pageHash: 'a'.repeat(64),
        pageUrl: START,
        summary: {
          pageUrl: START,
          element: { tag: 'button', type: 'submit', name: '', text: 'Send' },
          form: { action: NEXT, method: 'POST', fields: [] },
          href: null,
        },
      }),
      approved_activate: () => block(),
    });
    block = h.blockUntilClosed;
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      {
        kind: 'submit',
        target: { kind: 'role', role: 'button', name: 'Send' },
        description: 'Send',
      },
    ]);
    await h.service.execute(job(run));
    const [approval] = await h.approvals.forRun(run);
    await h.approvals.decide(
      approval,
      'APPROVED',
      'approver',
      approval.payload_hash,
    );
    const started = Date.now();
    const pending = h.service.execute(job(run));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(h.executed).toContain('approved_activate');
    await h.runs.transition(await stored(h.runs, run), 'CANCELLED');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10000);
    expect((await stored(h.runs, run)).status).toBe('CANCELLED');
    expect(
      (
        await pg.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM browser_actions WHERE run_id=$1 AND kind='approved_activate'",
          [run.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const [after] = await h.approvals.forRun(run);
    expect(after).toMatchObject({ status: 'CONSUMED', outcome: 'UNKNOWN' });
  }, 20000);

  test('a run cancelled just before completion keeps CANCELLED and records what ran', async () => {
    const h = harness(ctx.db, {
      extract: async () => {
        await pg.query(
          "UPDATE runs SET status='CANCELLED' WHERE status='RUNNING'",
        );
        return { url: START, title: 'Start', text: 'Text' };
      },
    });
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    // The cancel lands between the last action and the final transition.
    h.runs.get = (async (...args: Parameters<RunRepository['get']>) =>
      RunRepository.prototype.get.apply(h.runs, args)) as RunRepository['get'];
    const output = (await h.service
      .execute(job(run))
      .catch((e: unknown) => e)) as { status?: string; code?: string };
    const final = await stored(h.runs, run);
    expect(final.status).toBe('CANCELLED');
    expect(final.output).not.toBeNull();
    expect(output.status ?? output.code).toBe('CANCELLED');
  });

  test('a final infrastructure failure fails the run and keeps completed evidence', async () => {
    let creates = 0;
    const h = harness(ctx.db);
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    await h.service
      .execute(job(run), undefined, () => undefined, {
        attempt: 1,
        final: false,
      })
      .catch(() => undefined);
    const again = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
    ]);
    h.createSession.mockImplementation(async () => {
      creates++;
      throw new BrowserError(
        'BROWSER_LAUNCH_FAILED',
        'Chromium failed to start',
        503,
        true,
      );
    });
    await expect(
      h.service.execute(job(again), undefined, () => undefined, {
        attempt: 1,
        final: false,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
    expect((await stored(h.runs, again)).status).toBe('RUNNING');
    await expect(
      h.service.execute(job(again), undefined, () => undefined, {
        attempt: 3,
        final: true,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
    const final = await stored(h.runs, again);
    expect(final.status).toBe('FAILED');
    expect(final.output).toMatchObject({
      status: 'FAILED',
      partial: true,
      warnings: ['BROWSER_LAUNCH_FAILED'],
    });
    expect(creates).toBe(2);
  });

  test('a policy failure after successful steps is a partial result with their evidence', async () => {
    const h = harness(ctx.db, {
      click: () => {
        throw new PolicyError(
          'APPROVAL_REQUIRED',
          'Consequential actions are not enabled',
        );
      },
    });
    const run = await submit(h.runs, [
      { kind: 'navigate', url: START },
      { kind: 'read' },
      { kind: 'click', target: { kind: 'css', selector: 'button' } },
      { kind: 'read' },
    ]);
    const output = (await h.service.execute(job(run))) as {
      status: string;
      warnings: string[];
    };
    expect(output).toMatchObject({
      status: 'PARTIAL',
      warnings: ['STEP_2_APPROVAL_REQUIRED'],
    });
    expect(await count('evidence', run)).toBe(1);
    expect((await stored(h.runs, run)).status).toBe('PARTIAL');
  });

  test('a finished run is not executed again, and its lease cannot be taken', async () => {
    const h = harness(ctx.db);
    const run = await submit(h.runs, [{ kind: 'navigate', url: START }]);
    const first = await h.service.execute(job(run));
    const again = await h.service.execute(job(run));
    expect(again).toEqual(first);
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(await h.runs.claimLease(run, 'late-attempt', 30000)).toBe(false);
  });

  test('the workflow result references persisted data without copying page text or extracted data', () => {
    const summary = summarize('run-1', {
      status: 'COMPLETED',
      warnings: [],
      steps: [
        {
          index: 0,
          kind: 'read',
          status: 'success',
          attempts: 1,
          result: { url: START, characters: 5000 },
        },
        {
          index: 1,
          kind: 'extract',
          status: 'success',
          attempts: 1,
          result: {
            extractionId: 'x-1',
            evidenceId: 'e-1',
            data: { secretish: 'extracted value' },
          },
        },
      ],
      evidence: [{ url: START, text: 'full page text '.repeat(500) }],
    });
    expect(summary).toEqual({
      runId: 'run-1',
      status: 'COMPLETED',
      steps: [
        { index: 0, kind: 'read', status: 'success', attempts: 1, error: null },
        {
          index: 1,
          kind: 'extract',
          status: 'success',
          attempts: 1,
          error: null,
        },
      ],
      evidenceUrls: [START],
      extractionIds: ['x-1'],
      warnings: [],
      approval: null,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /full page text|extracted value/,
    );
  });
  describe('Phase 5 approval pause and resume', () => {
    const FORM = 'https://example.com/form';
    const PAGE = 'a'.repeat(64);
    const target = { kind: 'role', role: 'button', name: 'Send' };
    const fingerprint = () => ({
      pageHash: PAGE,
      pageUrl: FORM,
      summary: {
        pageUrl: FORM,
        element: { tag: 'button', type: 'submit', name: '', text: 'Send' },
        form: {
          action: 'https://example.com/send',
          method: 'POST',
          fields: [],
        },
        href: null,
      },
    });
    type Output = {
      status: string;
      warnings: string[];
      approval?: { id: string; step: number };
      steps: { index: number; kind: string; status: string }[];
    };
    const exec = (
      h: ReturnType<typeof harness>,
      run: Run,
      attempt = 1,
      final = false,
    ) =>
      h.service.execute(job(run), undefined, () => undefined, {
        attempt,
        final,
      }) as Promise<Output>;
    const paused = async (script: Script = {}) => {
      const h = harness(ctx.db, { fingerprint, ...script });
      const run = await submit(h.runs, [
        { kind: 'navigate', url: FORM },
        { kind: 'submit', target, description: 'Send the support message' },
      ]);
      const output = await exec(h, run);
      const [approval] = await h.approvals.forRun(run);
      return { h, run, output, approval };
    };
    const approve = async (h: ReturnType<typeof harness>, run: Run) => {
      const [approval] = await h.approvals.forRun(run);
      return h.approvals.decide(
        approval,
        'APPROVED',
        'approver',
        approval.payload_hash,
      );
    };
    const activations = (h: ReturnType<typeof harness>) =>
      h.executed.filter((kind) => kind === 'approved_activate').length;

    test('a consequential step pauses the run, releases the browser and lease, and persists the request', async () => {
      const { h, run, output, approval } = await paused();
      expect(output).toMatchObject({
        status: 'AWAITING_APPROVAL',
        approval: { id: approval.id, step: 1 },
      });
      expect((await stored(h.runs, run)).status).toBe('AWAITING_APPROVAL');
      expect(approval).toMatchObject({ status: 'PENDING', step: 1 });
      expect(h.closed).toHaveLength(1);
      expect(activations(h)).toBe(0);
      // No lease is held while waiting: another worker could claim the run at once.
      expect(await h.runs.claimLease(run, 'other', 30000)).toBe(true);
      await h.runs.releaseLease(run, 'other');
      // A wake-up while still pending returns the stored state without opening a browser.
      expect(await exec(h, run)).toMatchObject({ status: 'AWAITING_APPROVAL' });
      expect(h.createSession).toHaveBeenCalledTimes(1);
      expect(summarize(run.id, output).approval).toEqual({
        id: approval.id,
        expiresAt: expect.any(String),
        step: 1,
      });
    });

    test('after approval the page is reopened and revalidated, and the action runs exactly once', async () => {
      const { h, run } = await paused({
        approved_activate: () => ({ url: 'https://example.com/sent' }),
      });
      await approve(h, run);
      const output = await exec(h, run);
      expect(output.status).toBe('COMPLETED');
      expect(h.executed).toEqual([
        'open',
        'fingerprint',
        'open',
        'fingerprint',
        'approved_activate',
      ]);
      const [approval] = await h.approvals.forRun(run);
      expect(approval).toMatchObject({
        status: 'CONSUMED',
        outcome: 'SUCCEEDED',
      });
      // A duplicate delivery after completion executes nothing.
      expect(await exec(h, run)).toEqual(output);
      expect(activations(h)).toBe(1);
    });

    test.each([
      ['rejected', 'APPROVAL_REJECTED'],
      ['revoked', 'APPROVAL_REVOKED'],
      ['expired', 'APPROVAL_EXPIRED'],
    ])(
      'a %s approval ends the run as partial without a browser',
      async (kind, warning) => {
        const { h, run, approval } = await paused();
        if (kind === 'rejected')
          await h.approvals.decide(
            approval,
            'REJECTED',
            'approver',
            approval.payload_hash,
          );
        if (kind === 'revoked') {
          await approve(h, run);
          await h.approvals.revoke(approval, 'approver');
        }
        if (kind === 'expired')
          await pg.query(
            "UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
            [approval.id],
          );
        const output = await exec(h, run);
        expect(output).toMatchObject({
          status: 'PARTIAL',
          warnings: [warning],
        });
        expect(h.createSession).toHaveBeenCalledTimes(1);
        expect(activations(h)).toBe(0);
        expect((await stored(h.runs, run)).status).toBe('PARTIAL');
      },
    );

    test('a page that changed after approval is refused and the approval retired', async () => {
      const { h, run } = await paused();
      await approve(h, run);
      h.setFingerprint(() => ({ ...fingerprint(), pageHash: 'b'.repeat(64) }));
      const output = await exec(h, run);
      expect(output.status).toBe('PARTIAL');
      expect(output.steps[1]).toMatchObject({
        status: 'failed',
        error: { code: 'APPROVAL_PAGE_CHANGED' },
      });
      expect(activations(h)).toBe(0);
      const [approval] = await h.approvals.forRun(run);
      expect(approval).toMatchObject({
        status: 'CANCELLED',
        decision_reason: 'APPROVAL_PAGE_CHANGED',
      });
    });

    test('a crash after the action started is an unknown outcome and is never replayed', async () => {
      const { h, run } = await paused({
        approved_activate: () => {
          // The click happened; the attempt dies before its result is stored.
          ctx.failNext(/INSERT INTO browser_actions/);
          return { url: 'https://example.com/sent' };
        },
      });
      await approve(h, run);
      await expect(exec(h, run)).rejects.toMatchObject({
        code: 'PERSISTENCE_UNAVAILABLE',
      });
      // Temporal retries: the consumed approval is not a fresh authorization.
      const output = await exec(h, run, 2);
      expect(output.status).toBe('PARTIAL');
      expect(output.warnings).toEqual(['RESUME_UNSAFE', 'OUTCOME_UNKNOWN']);
      expect(activations(h)).toBe(1);
      const [approval] = await h.approvals.forRun(run);
      expect(approval).toMatchObject({
        status: 'CONSUMED',
        outcome: 'UNKNOWN',
      });
    });

    test('a crash before the approval was consumed resumes safely and acts once', async () => {
      const { h, run } = await paused({
        approved_activate: () => ({ url: 'https://example.com/sent' }),
      });
      await approve(h, run);
      ctx.failNext(/SET status='CONSUMED'/);
      await expect(exec(h, run)).rejects.toMatchObject({
        code: 'PERSISTENCE_UNAVAILABLE',
      });
      expect(activations(h)).toBe(0);
      expect((await stored(h.runs, run)).status).toBe('RUNNING');
      const output = await exec(h, run, 2);
      expect(output.status).toBe('COMPLETED');
      expect(activations(h)).toBe(1);
    });

    test('a final infrastructure failure closes the open approval', async () => {
      const { h, run, approval } = await paused();
      await approve(h, run);
      h.createSession.mockRejectedValueOnce(
        new BrowserError('BROWSER_LAUNCH_FAILED', 'down', 503, true),
      );
      await expect(exec(h, run, 3, true)).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_FAILED',
      });
      expect((await stored(h.runs, run)).status).toBe('FAILED');
      expect(
        (await h.approvals.forRun(run)).find((a) => a.id === approval.id),
      ).toMatchObject({ status: 'CANCELLED', decision_reason: 'RUN_FAILED' });
    });

    test('read-only step runs never create approvals', async () => {
      const h = harness(ctx.db);
      const run = await submit(h.runs, [
        { kind: 'navigate', url: START },
        { kind: 'read' },
      ]);
      expect((await exec(h, run)).status).toBe('COMPLETED');
      expect(await h.approvals.forRun(run)).toEqual([]);
      expect(h.executed).toEqual(['open', 'extract']);
    });
  });
  describe('Phase 6 worker shutdown', () => {
    // A Temporal activity context whose cancellation is driven by the test.
    const activityContext = () => {
      const controller = new AbortController();
      let details:
        { workerShutdown: boolean; cancelRequested: boolean } | undefined;
      let reject: (error: Error) => void = () => undefined;
      const cancelled = new Promise<never>((_, fail) => (reject = fail));
      cancelled.catch(() => undefined);
      const end = (workerShutdown: boolean) => {
        details = { workerShutdown, cancelRequested: !workerShutdown };
        controller.abort();
        reject(new Error(workerShutdown ? 'WORKER_SHUTDOWN' : 'CANCELLED'));
      };
      return {
        context: {
          cancellationSignal: controller.signal,
          get cancellationDetails() {
            return details;
          },
          cancelled,
          heartbeat: () => undefined,
          info: { attempt: 1 },
        } as unknown as ActivityContext,
        shutdown: () => end(true),
        cancel: () => end(false),
      };
    };

    test('a worker shutdown mid-step releases the browser and lease but does not cancel the run', async () => {
      let block: () => Promise<never> = () => new Promise(() => undefined);
      let blocking = true;
      const h = harness(ctx.db, {
        extract: () =>
          blocking ? block() : { url: START, title: 'T', text: 'Text' },
      });
      block = h.blockUntilClosed;
      const run = await submit(h.runs, [
        { kind: 'navigate', url: START },
        { kind: 'read' },
      ]);
      const activity = activityContext();
      const pending = runBrowserTask(h.service, job(run), activity.context);
      await new Promise((resolve) => setTimeout(resolve, 300));
      activity.shutdown();
      const failure: unknown = await pending.catch((error: unknown) => error);
      const row = await stored(h.runs, run);
      // Not a user cancellation: the run stays open for Temporal's retry.
      expect(row.status).toBe('RUNNING');
      expect(
        (
          await pg.query<{ lease_owner: string | null }>(
            'SELECT lease_owner FROM runs WHERE id=$1',
            [run.id],
          )
        ).rows[0].lease_owner,
      ).toBeNull();
      expect(failure).toMatchObject({
        type: 'WORKER_SHUTDOWN',
        nonRetryable: false,
      });
      expect(new Set(h.closed).size).toBe(1);
      // The next attempt (Temporal retry on a running worker) completes the run.
      blocking = false;
      const output = (await h.service.execute(
        job(run),
        undefined,
        () => undefined,
        {
          attempt: 2,
          final: false,
        },
      )) as { status: string };
      expect(output.status).toBe('COMPLETED');
    }, 15000);

    test('a worker shutdown while waiting for approval keeps the run and its approval', async () => {
      const h = harness(ctx.db, {
        fingerprint: () => ({
          pageHash: 'a'.repeat(64),
          pageUrl: START,
          summary: {
            pageUrl: START,
            element: { tag: 'a', type: '', name: '', text: 'Next' },
            form: null,
            href: NEXT,
          },
        }),
      });
      const run = await submit(h.runs, [
        { kind: 'navigate', url: START },
        {
          kind: 'submit',
          target: { kind: 'role', role: 'link', name: 'Next' },
          description: 'Open next',
        },
      ]);
      await h.service.execute(job(run));
      const activity = activityContext();
      activity.shutdown();
      // A paused run returns its stored state without a browser, whatever the signal says.
      await expect(
        runBrowserTask(h.service, job(run), activity.context),
      ).resolves.toMatchObject({ status: 'AWAITING_APPROVAL' });
      const [approval] = await h.approvals.forRun(run);
      expect(approval.status).toBe('PENDING');
    });

    test('a genuine cancellation still cancels the run', async () => {
      let block: () => Promise<never> = () => new Promise(() => undefined);
      const h = harness(ctx.db, { extract: () => block() });
      block = h.blockUntilClosed;
      const run = await submit(h.runs, [
        { kind: 'navigate', url: START },
        { kind: 'read' },
      ]);
      const activity = activityContext();
      const pending = runBrowserTask(h.service, job(run), activity.context);
      await new Promise((resolve) => setTimeout(resolve, 300));
      activity.cancel();
      // Temporal's own cancellation is rethrown, so the workflow ends CANCELED.
      await expect(pending).rejects.toThrow('CANCELLED');
      expect((await stored(h.runs, run)).status).toBe('CANCELLED');
    }, 15000);
  });
});
