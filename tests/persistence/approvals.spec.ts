import type { PGlite } from '@electric-sql/pglite';
import { RunRepository, type Run } from '../../src/persistence/run.repository';
import { ApprovalRepository } from '../../src/persistence/approval.repository';
import { ApprovalsService } from '../../src/browser/services/approvals.service';
import { BrowserRunsService } from '../../src/browser/services/browser-runs.service';
import type { TemporalService } from '../../src/temporal/temporal.service';
import { DispatchService } from '../../src/temporal/dispatch.service';
import type { ConfigurationService } from '../../src/config/configuration';
import type { AuditService } from '../../src/common/logger/audit.service';
import type {
  Capability,
  ExecutionContext,
} from '../../src/common/types/execution-context';
import { pgliteDatabase } from './pglite-database';

const principal = (
  userId: string,
  capabilities: Capability[] = ['browser'],
  tenantId = 't',
  projectId = 'p',
): ExecutionContext => ({
  tenantId,
  projectId,
  userId,
  requestId: 'r',
  capabilities,
});
const submitter = principal('submitter');
const approver = principal('approver', ['approve']);
const PAYLOAD = 'a'.repeat(64);
const PAGE = 'b'.repeat(64);
const proposal = {
  action: {
    kind: 'submit',
    description: 'Send the message',
    form: { action: 'https://example.com/send', method: 'POST' },
  },
  payloadHash: PAYLOAD,
  pageHash: PAGE,
  pageUrl: 'https://example.com/form',
};

describe('Approvals: repository and decision service (PGlite)', () => {
  let pg: PGlite,
    runs: RunRepository,
    approvals: ApprovalRepository,
    service: ApprovalsService,
    signals: string[],
    audit: { event: string; outcome: string; ids: unknown }[],
    distinctApprover: boolean;
  beforeEach(async () => {
    const ctx = await pgliteDatabase();
    pg = ctx.pg;
    runs = new RunRepository(ctx.db);
    approvals = new ApprovalRepository(ctx.db);
    signals = [];
    audit = [];
    distinctApprover = true;
    service = new ApprovalsService(
      runs,
      approvals,
      {
        signal: async (run: Run) => {
          signals.push(run.id);
        },
      } as unknown as TemporalService,
      {
        get value() {
          return { approvals: { ttlMs: 600000, distinctApprover } };
        },
      } as unknown as ConfigurationService,
      {
        record: (event: string, ids: unknown, outcome: string) =>
          audit.push({ event, ids, outcome }),
      } as unknown as AuditService,
    );
  });
  afterEach(async () => {
    await pg.close();
  });
  // A run paused at step 1 with a pending approval, as the worker leaves it.
  const waiting = async (ttlMs = 600000) => {
    const run = await runs.create(
      submitter,
      'browser',
      { steps: [] },
      'k-' + Math.random(),
    );
    await runs.transition(run, 'RUNNING');
    await runs.transition(run, 'AWAITING_APPROVAL', {
      status: 'AWAITING_APPROVAL',
    });
    const approval = await approvals.request(run, 1, proposal, ttlMs);
    return { run: await runs.get(run.id, 't', 'p'), approval };
  };
  const expire = (id: string) =>
    pg.query(
      "UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );

  test('a request is durable, idempotent per run step, and holds no field values', async () => {
    const { run, approval } = await waiting();
    const again = await approvals.request(
      run,
      1,
      { ...proposal, payloadHash: 'c'.repeat(64) },
      600000,
    );
    expect(again.id).toBe(approval.id);
    expect(again.payload_hash).toBe(PAYLOAD);
    expect(approval).toMatchObject({
      run_id: run.id,
      tenant_id: 't',
      project_id: 'p',
      step: 1,
      status: 'PENDING',
      requested_by: 'submitter',
      page_hash: PAGE,
      page_url: 'https://example.com/form',
    });
    expect(
      new Date(approval.expires_at).getTime() -
        new Date(approval.created_at).getTime(),
    ).toBeGreaterThan(590000);
    expect(approval.audit).toEqual([
      expect.objectContaining({ event: 'requested', actor: 'worker' }),
    ]);
  });

  test('an approver approves the exact payload; the decision is audited and wakes the workflow', async () => {
    const { run, approval } = await waiting();
    const view = await service.decide(approver, approval.id, 'APPROVED', {
      payloadHash: PAYLOAD,
    });
    expect(view).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'approver',
      runId: run.id,
    });
    expect(view.decidedAt).toBeTruthy();
    expect(signals).toEqual([run.id]);
    expect(audit.at(-1)).toMatchObject({
      event: 'approval.approve',
      outcome: 'APPROVED',
    });
    expect(view.audit.map((e) => e.event)).toEqual(['requested', 'approved']);
  });

  test('rejection records the reason and cannot be reversed', async () => {
    const { approval } = await waiting();
    await expect(
      service.decide(approver, approval.id, 'REJECTED', { reason: 'no' }),
    ).resolves.toMatchObject({ status: 'REJECTED', decisionReason: 'no' });
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
  });

  test('approving needs the approve capability, a distinct principal and the reviewed payload hash', async () => {
    const { approval } = await waiting();
    await expect(
      service.decide(principal('other'), approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    // The submitter holding the capability still cannot approve its own action.
    await expect(
      service.decide(
        principal('submitter', ['browser', 'approve']),
        approval.id,
        'APPROVED',
        { payloadHash: PAYLOAD },
      ),
    ).rejects.toMatchObject({ code: 'APPROVER_NOT_DISTINCT' });
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {
        payloadHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_PAYLOAD_MISMATCH' });
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {}),
    ).rejects.toThrow();
    expect((await approvals.get(approval.id, 't', 'p')).status).toBe('PENDING');
    expect(audit.map((a) => a.outcome)).toEqual([
      'CAPABILITY_DENIED',
      'APPROVER_NOT_DISTINCT',
      'APPROVAL_PAYLOAD_MISMATCH',
    ]);
    // With distinct approval disabled by configuration, self-approval is allowed.
    distinctApprover = false;
    await expect(
      service.decide(
        principal('submitter', ['browser', 'approve']),
        approval.id,
        'APPROVED',
        { payloadHash: PAYLOAD },
      ),
    ).resolves.toMatchObject({ status: 'APPROVED' });
  });

  test('another tenant or project cannot see, decide or cancel the approval', async () => {
    const { run, approval } = await waiting();
    for (const outsider of [
      principal('approver', ['approve'], 'other-tenant', 'p'),
      principal('approver', ['approve'], 't', 'other-project'),
    ]) {
      await expect(service.get(outsider, approval.id)).rejects.toMatchObject({
        code: 'APPROVAL_NOT_FOUND',
      });
      await expect(
        service.decide(outsider, approval.id, 'APPROVED', {
          payloadHash: PAYLOAD,
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
      await expect(
        service.cancel(outsider, approval.id, {}),
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
      await expect(service.list(outsider, run.id)).rejects.toMatchObject({
        status: 404,
      });
    }
    expect((await approvals.get(approval.id, 't', 'p')).status).toBe('PENDING');
    expect(signals).toEqual([]);
  });

  test('an expired approval cannot be decided or consumed', async () => {
    const { run, approval } = await waiting();
    await expire(approval.id);
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect((await service.get(approver, approval.id)).status).toBe('EXPIRED');
    expect(
      await approvals.consume(run, 1, approval.id, PAYLOAD, PAGE, 'attempt'),
    ).toBeUndefined();
  });

  test('an approval granted and then expired before execution is not consumable', async () => {
    const { run, approval } = await waiting();
    await service.decide(approver, approval.id, 'APPROVED', {
      payloadHash: PAYLOAD,
    });
    await expire(approval.id);
    expect(
      await approvals.consume(run, 1, approval.id, PAYLOAD, PAGE, 'attempt'),
    ).toBeUndefined();
  });

  test('cancel: pending becomes CANCELLED, approved becomes REVOKED, consumed cannot be revoked', async () => {
    const first = await waiting();
    // The run submitter may withdraw its own pending request.
    await expect(
      service.cancel(submitter, first.approval.id, { reason: 'changed mind' }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    const second = await waiting();
    await service.decide(approver, second.approval.id, 'APPROVED', {
      payloadHash: PAYLOAD,
    });
    await expect(
      service.cancel(principal('bystander'), second.approval.id, {}),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      service.cancel(approver, second.approval.id, {}),
    ).resolves.toMatchObject({ status: 'REVOKED' });
    expect(
      await approvals.consume(
        second.run,
        1,
        second.approval.id,
        PAYLOAD,
        PAGE,
        'attempt',
      ),
    ).toBeUndefined();
    const third = await waiting();
    await service.decide(approver, third.approval.id, 'APPROVED', {
      payloadHash: PAYLOAD,
    });
    await approvals.consume(
      third.run,
      1,
      third.approval.id,
      PAYLOAD,
      PAGE,
      'attempt',
    );
    await expect(
      service.cancel(approver, third.approval.id, {}),
    ).rejects.toMatchObject({ code: 'APPROVAL_CONSUMED' });
  });

  test('consumption is bound to run, step, payload and page, and succeeds exactly once', async () => {
    const { run, approval } = await waiting();
    const other = await waiting();
    await service.decide(approver, approval.id, 'APPROVED', {
      payloadHash: PAYLOAD,
    });
    const consume = (
      target: Run,
      step: number,
      payload: string,
      page: string,
      attempt = 'attempt',
    ) => approvals.consume(target, step, approval.id, payload, page, attempt);
    expect(await consume(other.run, 1, PAYLOAD, PAGE)).toBeUndefined();
    expect(await consume(run, 2, PAYLOAD, PAGE)).toBeUndefined();
    expect(await consume(run, 1, 'c'.repeat(64), PAGE)).toBeUndefined();
    expect(await consume(run, 1, PAYLOAD, 'c'.repeat(64))).toBeUndefined();
    expect(
      await approvals.consume(
        { ...run, tenant_id: 'other-tenant' },
        1,
        approval.id,
        PAYLOAD,
        PAGE,
        'attempt',
      ),
    ).toBeUndefined();
    // Concurrent attempts: exactly one consumes.
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((attempt) =>
        consume(run, 1, PAYLOAD, PAGE, attempt),
      ),
    );
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: 'CONSUMED' });
    expect(await consume(run, 1, PAYLOAD, PAGE, 'a5')).toBeUndefined();
    // The outcome is recorded once and only for a consumed approval.
    expect(
      await approvals.recordOutcome(run, approval.id, 'UNKNOWN', 'crash'),
    ).toMatchObject({ outcome: 'UNKNOWN' });
    expect(
      await approvals.recordOutcome(run, approval.id, 'SUCCEEDED'),
    ).toBeUndefined();
    const final = await service.get(approver, approval.id);
    expect(final.audit.map((e) => e.event)).toEqual([
      'requested',
      'approved',
      'consumed',
      'outcome-unknown',
    ]);
  });

  test('a terminal run closes its open approvals, and they can no longer be decided', async () => {
    const { run, approval } = await waiting();
    await runs.transition(run, 'PARTIAL', { status: 'PARTIAL' });
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' });
    const view = await service.get(approver, approval.id);
    expect(view).toMatchObject({
      status: 'CANCELLED',
      decisionReason: 'RUN_PARTIAL',
    });
  });

  test('cancelling a run waiting for approval cancels the approval', async () => {
    const { approval, ...rest } = await waiting();
    await pg.query("UPDATE runs SET dispatch_state='DISPATCHED' WHERE id=$1", [
      rest.run.id,
    ]);
    const run = await runs.get(rest.run.id, 't', 'p');
    const cancelled: string[] = [];
    const runsApi = new BrowserRunsService(
      runs,
      {} as DispatchService,
      {
        cancel: async (r: Run) => {
          cancelled.push(r.id);
        },
      } as unknown as TemporalService,
      approvals,
    );
    await expect(runsApi.cancel(submitter, run.id)).resolves.toEqual({
      status: 'CANCELLED',
    });
    expect(cancelled).toEqual([run.id]);
    expect((await approvals.get(approval.id, 't', 'p')).status).toBe(
      'CANCELLED',
    );
    await expect(
      service.decide(approver, approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' });
  });

  // Phase 6: a decision whose signal is lost still reaches the workflow (redundant signals
  // are harmless), and a Temporal-side cancellation closes the approval.
  test('a lost decision signal is re-delivered by the dispatcher; a cancelled workflow closes the approval', async () => {
    const { run, approval } = await waiting();
    await pg.query("UPDATE runs SET dispatch_state='DISPATCHED' WHERE id=$1", [
      run.id,
    ]);
    const sent: string[] = [];
    let workflow = 'RUNNING';
    const temporal = {
      signal: async (r: Run) => {
        if (!sent.length && !lost) {
          lost = true;
          throw new Error('temporal unavailable');
        }
        sent.push(r.id);
      },
      status: async () => workflow,
    } as unknown as TemporalService;
    let lost = false;
    const decisions = new ApprovalsService(
      runs,
      approvals,
      temporal,
      {
        value: { approvals: { ttlMs: 600000, distinctApprover: true } },
      } as unknown as ConfigurationService,
      { record: () => undefined } as unknown as AuditService,
    );
    // The decision commits even though its signal fails.
    await expect(
      decisions.decide(approver, approval.id, 'APPROVED', {
        payloadHash: PAYLOAD,
      }),
    ).resolves.toMatchObject({ status: 'APPROVED' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).toBe(true);
    expect(sent).toEqual([]);
    const dispatch = new DispatchService(runs, temporal, approvals);
    const reconcile = () =>
      (dispatch as unknown as { reconcile(): Promise<void> }).reconcile();
    await reconcile();
    expect(sent).toEqual([run.id]);
    // The workflow was cancelled in Temporal: the run is cancelled and its approval closed.
    workflow = 'CANCELLED';
    await reconcile();
    expect((await runs.get(run.id, 't', 'p')).status).toBe('CANCELLED');
    expect((await approvals.get(approval.id, 't', 'p')).status).toBe(
      'CANCELLED',
    );
    dispatch.onModuleDestroy();
  });

  test('the dispatcher finds runs whose approval was decided or expired', async () => {
    const decided = await waiting();
    const open = await waiting();
    const expired = await waiting();
    for (const item of [decided, open, expired])
      await pg.query(
        "UPDATE runs SET dispatch_state='DISPATCHED' WHERE id=$1",
        [item.run.id],
      );
    await service.decide(approver, decided.approval.id, 'REJECTED', {});
    await expire(expired.approval.id);
    expect((await runs.awaitingDecision()).map((r) => r.id).sort()).toEqual(
      [decided.run.id, expired.run.id].sort(),
    );
  });
});
