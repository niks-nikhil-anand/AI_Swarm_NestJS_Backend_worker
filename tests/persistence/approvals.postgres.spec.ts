import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../src/persistence/database.service';
import { RunRepository, type Run } from '../../src/persistence/run.repository';
import {
  ApprovalRepository,
  type Approval,
} from '../../src/persistence/approval.repository';
import {
  admin,
  describePostgres,
  freshDatabase,
  service,
} from './postgres-database';

const owner = {
  tenantId: 't',
  projectId: 'p',
  userId: 'submitter',
  requestId: 'r',
  capabilities: ['browser' as const],
};
const PAYLOAD = 'a'.repeat(64);
const PAGE = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const proposal = {
  action: { kind: 'submit', description: 'Send the message' },
  payloadHash: PAYLOAD,
  pageHash: PAGE,
  pageUrl: 'https://forms.fixture.test/form',
};

/**
 * Approval invariants on real PostgreSQL 17, with independent connection pools standing in
 * for separate API and worker processes, and explicit transactions to force overlap.
 */
describePostgres('Approvals on real PostgreSQL (multiple connections)', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;
  // Five processes: each has its own pool, so concurrent statements use distinct sessions.
  let pools: DatabaseService[];
  let runs: RunRepository;
  let repos: ApprovalRepository[];
  beforeAll(async () => {
    database = await freshDatabase('approvals');
    pools = Array.from({ length: 5 }, () => service(database.url));
    runs = new RunRepository(pools[0]);
    repos = pools.map((pool) => new ApprovalRepository(pool));
  }, 60000);
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.onModuleDestroy()));
    await database.drop();
  });
  const raw = async () => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    return client;
  };
  // A run paused at step 1 with a pending approval.
  const pending = async (ttlMs = 600000) => {
    const run = await runs.create(
      owner,
      'browser',
      { steps: [] },
      randomUUID(),
    );
    await runs.transition(run, 'RUNNING');
    await runs.transition(run, 'AWAITING_APPROVAL', {
      status: 'AWAITING_APPROVAL',
    });
    const approval = await repos[0].request(run, 1, proposal, ttlMs);
    return { run, approval };
  };
  const approved = async () => {
    const { run, approval } = await pending();
    const decided = await repos[1].decide(
      approval,
      'APPROVED',
      'approver',
      PAYLOAD,
    );
    return { run, approval: decided! };
  };
  const current = (approval: Approval) => repos[2].get(approval.id, 't', 'p');
  const events = async (approval: Approval) =>
    (await current(approval)).audit.map((entry) => entry.event);

  test('concurrent consumers on separate connections: exactly one wins, every time', async () => {
    for (let round = 0; round < 10; round++) {
      const { run, approval } = await approved();
      const attempts = Array.from({ length: 20 }, (_, i) => 'attempt-' + i);
      const results = await Promise.all(
        attempts.map((attempt, i) =>
          repos[i % repos.length].consume(
            run,
            1,
            approval.id,
            PAYLOAD,
            PAGE,
            attempt,
          ),
        ),
      );
      const winners = results.filter(Boolean);
      expect(winners).toHaveLength(1);
      const stored = await current(approval);
      expect(stored).toMatchObject({
        status: 'CONSUMED',
        consumed_by: winners[0]!.consumed_by,
      });
      expect(stored.audit.filter((e) => e.event === 'consumed')).toHaveLength(
        1,
      );
    }
  }, 60000);

  test('overlapping transactions: the waiting consumer re-checks after the first commits (READ COMMITTED)', async () => {
    const { run, approval } = await approved();
    const first = await raw();
    try {
      await first.query('BEGIN');
      // Holds the row lock until COMMIT, as an in-flight consumer would.
      const taken = await first.query(
        "UPDATE approvals SET status='CONSUMED',consumed_at=now(),consumed_by='first' WHERE id=$1 AND status='APPROVED' RETURNING id",
        [approval.id],
      );
      expect(taken.rowCount).toBe(1);
      const second = repos[3].consume(
        run,
        1,
        approval.id,
        PAYLOAD,
        PAGE,
        'second',
      );
      // The second statement is blocked on the row lock, not yet answered.
      const raced = await Promise.race([
        second.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ]);
      expect(raced).toBe('blocked');
      await first.query('COMMIT');
      expect(await second).toBeUndefined();
      expect((await current(approval)).consumed_by).toBe('first');
    } finally {
      await first.end();
    }
  });

  test('a rolled-back consumption leaves the approval usable, and the waiter then consumes it', async () => {
    const { run, approval } = await approved();
    const first = await raw();
    try {
      await first.query('BEGIN');
      await first.query(
        "UPDATE approvals SET status='CONSUMED',consumed_at=now(),consumed_by='first' WHERE id=$1 AND status='APPROVED'",
        [approval.id],
      );
      const second = repos[3].consume(
        run,
        1,
        approval.id,
        PAYLOAD,
        PAGE,
        'second',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query('ROLLBACK');
      expect(await second).toMatchObject({ consumed_by: 'second' });
    } finally {
      await first.end();
    }
  });

  test('a connection that dies before COMMIT never leaves a consumption behind', async () => {
    const { run, approval } = await approved();
    const victim = await raw();
    victim.on('error', () => undefined);
    await victim.query('BEGIN');
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid as number;
    await victim.query(
      "UPDATE approvals SET status='CONSUMED',consumed_at=now(),consumed_by='victim',audit=audit||'[{\"event\":\"consumed\"}]'::jsonb WHERE id=$1",
      [approval.id],
    );
    await admin((client) =>
      client.query('SELECT pg_terminate_backend($1)', [pid]),
    );
    await victim.end().catch(() => undefined);
    const stored = await current(approval);
    expect(stored).toMatchObject({
      status: 'APPROVED',
      consumed_by: null,
      consumed_at: null,
    });
    expect(stored.audit.map((e) => e.event)).toEqual(['requested', 'approved']);
    expect(
      await repos[4].consume(run, 1, approval.id, PAYLOAD, PAGE, 'retry'),
    ).toMatchObject({ status: 'CONSUMED' });
  });

  test('expired, rejected, revoked and cancelled approvals cannot be consumed', async () => {
    const expired = await approved();
    await pools[0].query(
      "UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.approval.id],
    );
    const rejected = await pending();
    await repos[1].decide(rejected.approval, 'REJECTED', 'approver', PAYLOAD);
    const revoked = await approved();
    await repos[1].revoke(revoked.approval, 'approver');
    const cancelled = await approved();
    await repos[1].closeOpen(cancelled.run, 'RUN_CANCELLED');
    for (const { run, approval } of [expired, rejected, revoked, cancelled])
      expect(
        await repos[2].consume(run, 1, approval.id, PAYLOAD, PAGE, 'x'),
      ).toBeUndefined();
    expect((await current(revoked.approval)).status).toBe('REVOKED');
    expect((await current(cancelled.approval)).status).toBe('CANCELLED');
  });

  test('an approval is bound to its tenant, project, run, step, payload and page', async () => {
    const { run, approval } = await approved();
    const other = await pending();
    const attempts: [Run, number, string, string][] = [
      [{ ...run, tenant_id: 'other' }, 1, PAYLOAD, PAGE],
      [{ ...run, project_id: 'other' }, 1, PAYLOAD, PAGE],
      [other.run, 1, PAYLOAD, PAGE],
      [run, 2, PAYLOAD, PAGE],
      [run, 1, OTHER, PAGE],
      [run, 1, PAYLOAD, OTHER],
    ];
    for (const [target, step, payload, page] of attempts)
      expect(
        await repos[3].consume(target, step, approval.id, payload, page, 'x'),
      ).toBeUndefined();
    expect((await current(approval)).status).toBe('APPROVED');
    expect(
      await repos[3].consume(run, 1, approval.id, PAYLOAD, PAGE, 'right'),
    ).toMatchObject({ status: 'CONSUMED' });
    // A lookup by id alone, outside the tenant and project, finds nothing.
    await expect(repos[0].get(approval.id, 'other', 'p')).rejects.toMatchObject(
      { code: 'APPROVAL_NOT_FOUND' },
    );
  });

  test('concurrent approve and cancel always end in one valid, consistently audited state', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 20; round++) {
      const { approval } = await pending();
      const [decision, revocation] = await Promise.all([
        repos[round % 5].decide(approval, 'APPROVED', 'approver', PAYLOAD),
        repos[(round + 1) % 5].revoke(approval, 'submitter'),
      ]);
      const stored = await current(approval);
      const audit = stored.audit.map((e) => e.event);
      if (stored.status === 'REVOKED') {
        // Approved first, then withdrawn: both took effect, in that order.
        expect(decision).toBeTruthy();
        expect(revocation).toBeTruthy();
        expect(audit).toEqual(['requested', 'approved', 'revoked']);
        expect(stored.decision_by).toBe('approver');
      } else {
        // Cancelled first: the approval never happened.
        expect(stored.status).toBe('CANCELLED');
        expect(decision).toBeUndefined();
        expect(audit).toEqual(['requested', 'revoked']);
        expect(stored.decision_by).toBeNull();
      }
      outcomes.add(stored.status);
    }
    expect(
      [...outcomes].every((s) => ['REVOKED', 'CANCELLED'].includes(s)),
    ).toBe(true);
  }, 60000);

  test('concurrent approve and reject: exactly one decision is recorded', async () => {
    for (let round = 0; round < 10; round++) {
      const { approval } = await pending();
      const results = await Promise.all([
        repos[0].decide(approval, 'APPROVED', 'approver-1', PAYLOAD),
        repos[1].decide(approval, 'REJECTED', 'approver-2', PAYLOAD),
        repos[2].decide(approval, 'APPROVED', 'approver-3', PAYLOAD),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const audit = await events(approval);
      expect(audit).toHaveLength(2);
      expect(['approved', 'rejected']).toContain(audit[1]);
    }
  });

  test('duplicate concurrent requests and approvals create one row and one audit event each', async () => {
    const run = await runs.create(
      owner,
      'browser',
      { steps: [] },
      randomUUID(),
    );
    const requests = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repos[i % 5].request(run, 1, proposal, 600000),
      ),
    );
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
    expect(
      (
        await pools[0].query(
          'SELECT count(*)::int AS n FROM approvals WHERE run_id=$1',
          [run.id],
        )
      )[0].n,
    ).toBe(1);
    const approvals = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repos[i % 5].decide(requests[0], 'APPROVED', 'approver', PAYLOAD),
      ),
    );
    expect(approvals.filter(Boolean)).toHaveLength(1);
    expect(await events(requests[0])).toEqual(['requested', 'approved']);
  });

  test('the database refuses invalid transitions, binding changes and audit rewrites', async () => {
    const { run, approval } = await approved();
    await repos[0].consume(run, 1, approval.id, PAYLOAD, PAGE, 'attempt');
    const refused = async (sql: string) =>
      expect(pools[0].query(sql, [approval.id])).rejects.toThrow();
    // A consumed approval can never become usable again.
    await refused("UPDATE approvals SET status='APPROVED' WHERE id=$1");
    await refused(
      "UPDATE approvals SET payload_hash=repeat('d',64) WHERE id=$1",
    );
    await refused("UPDATE approvals SET page_hash=repeat('d',64) WHERE id=$1");
    await refused("UPDATE approvals SET tenant_id='other' WHERE id=$1");
    await refused(
      "UPDATE approvals SET expires_at=expires_at+interval '1 hour' WHERE id=$1",
    );
    await refused(
      "UPDATE approvals SET consumed_by='someone-else' WHERE id=$1",
    );
    await refused("UPDATE approvals SET audit='[]'::jsonb WHERE id=$1");
    await refused('DELETE FROM approvals WHERE id=$1');
    // A consumed row must say who consumed it; an outcome needs a consumed approval.
    const fresh = await pending();
    await expect(
      pools[0].query("UPDATE approvals SET status='APPROVED' WHERE id=$1", [
        fresh.approval.id,
      ]),
    ).rejects.toThrow(/approvals_decided_check/);
    await expect(
      pools[0].query("UPDATE approvals SET outcome='SUCCEEDED' WHERE id=$1", [
        fresh.approval.id,
      ]),
    ).rejects.toThrow(/approvals_outcome_state_check/);
    // The outcome is written once.
    expect(
      await repos[0].recordOutcome(run, approval.id, 'UNKNOWN', 'crash'),
    ).toBeTruthy();
    await refused("UPDATE approvals SET outcome='SUCCEEDED' WHERE id=$1");
    expect(await events(approval)).toEqual([
      'requested',
      'approved',
      'consumed',
      'outcome-unknown',
    ]);
  });
});
