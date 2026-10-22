// Phase 6 Compose acceptance suite: approval-gated actions, recovery, egress and secrets on
// the full production-like stack (API, migrate, PostgreSQL, Temporal, orchestration and
// browser workers with Chromium + Stagehand) against a local HTTPS fixture. No request leaves
// for a third-party site: the only allowlisted hosts are the fixture's own names.
//
// Usage: node test/compose/verify.mjs [--keep]
// Requires Docker. Synthetic credentials are generated into a temporary directory and
// deleted at the end, together with the stack and its volumes (unless --keep).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const keep = process.argv.includes('--keep');
// VERIFY_SECTIONS=A,D runs only those scenario sections (all by default).
const only = (process.env.VERIFY_SECTIONS || '').split(',').filter(Boolean);
const want = (name) => !only.length || only.includes(name);
const project = process.env.VERIFY_PROJECT || 'swarm-p6-verify';
const API_PORT = 3200;
const CONTROL_PORT = 58090;
const base = `http://127.0.0.1:${API_PORT}`;
const control = `http://127.0.0.1:${CONTROL_PORT}`;
const FORM = 'https://forms.fixture.test/form';
const SUBMIT = 'https://forms.fixture.test/submit';
const READ = 'https://forms.fixture.test/read';

// ---- synthetic credentials --------------------------------------------------------------
const secret = () => randomBytes(24).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'swarm-verify-'));
const tenantA = 'verify-a-' + secret().slice(0, 8);
const tenantB = 'verify-b-' + secret().slice(0, 8);
const principal = (userId, tenantId, capabilities) => ({
  token: secret(),
  tenantId,
  userId,
  projectIds: ['demo'],
  capabilities,
});
const submitter = principal('submitter-a', tenantA, ['browser']);
const approver = principal('approver-a', tenantA, ['approve']);
const other = principal('approver-b', tenantB, ['approve', 'browser']);
const KEY = 'sk-ant-verify-' + secret();
const DB_PASSWORD = secret();
// A synthetic "sensitive" form value: it must reach the fixture and nowhere else but the
// stored run definition (see the report).
const TYPED = 'SYNTH-' + secret().slice(0, 16);
const envFile = join(dir, 'verify.env');
writeFileSync(
  envFile,
  Object.entries({
    PORT: String(API_PORT),
    POSTGRES_PORT: '55442',
    SEARXNG_PORT: '58081',
    FIXTURE_CONTROL_PORT: String(CONTROL_PORT),
    POSTGRES_PASSWORD: DB_PASSWORD,
    DOCKER_DATABASE_URL: `postgresql://swarm:${DB_PASSWORD}@postgres:5432/swarm_backend`,
    SEARXNG_SECRET: secret(),
    AUTH_CREDENTIALS: JSON.stringify([submitter, approver, other]),
    BROWSER_ALLOWED_DOMAINS: 'forms.fixture.test,private.fixture.test',
    STAGEHAND_ENABLED: 'true',
    VERIFY_ANTHROPIC_API_KEY: KEY,
    APPROVAL_TTL_MS: '60000',
    APPROVAL_REQUIRE_DISTINCT_APPROVER: 'true',
  })
    .map(([k, v]) => `${k}='${v}'`)
    .join('\n') + '\n',
);
const SECRETS = [
  KEY,
  DB_PASSWORD,
  submitter.token,
  approver.token,
  other.token,
];

// ---- process helpers ----------------------------------------------------------------------
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    ...options,
  });
const compose = (...args) =>
  run('docker', [
    'compose',
    '-p',
    project,
    '--env-file',
    envFile,
    '-f',
    'docker-compose.yml',
    '-f',
    'test/compose/docker-compose.verify.yml',
    '--profile',
    'engine',
    ...args,
  ]);
const container = (service) => project + '-' + service + '-1';
const docker = (...args) => run('docker', args);
const inContainer = (service, script, input) =>
  run('docker', ['exec', '-i', container(service), 'sh', '-c', script], {
    input: input ?? '',
  });
const sql = (query) =>
  inContainer(
    'postgres',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|" -v ON_ERROR_STOP=1',
    query + ';',
  ).trim();
const temporal = (...args) =>
  docker(
    'exec',
    container('temporal'),
    'temporal',
    ...args,
    '--address',
    '127.0.0.1:7233',
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- reporting ----------------------------------------------------------------------------
let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  if (ok) passes++;
  else failures++;
  console.log(
    (ok ? 'PASS ' : 'FAIL ') +
      name +
      (detail !== undefined ? ' :: ' + detail : ''),
  );
};
const section = (name) => console.log('\n## ' + name);

// ---- API, fixture and Temporal helpers ----------------------------------------------------
const api = async (who, method, path, body) => {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = 'Bearer ' + who.token;
  if (method === 'POST' && path === '/browser-runs')
    headers['idempotency-key'] = 'p6-' + randomUUID();
  const response = await fetch(
    base + '/projects/demo' + path,
    body
      ? { method, headers, body: JSON.stringify(body) }
      : { method, headers },
  );
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json, text };
};
const responses = [];
const record = (response) => {
  responses.push(response.text);
  return response;
};
const submit = async (steps, who = submitter) => {
  const response = record(await api(who, 'POST', '/browser-runs', { steps }));
  if (response.status !== 202)
    throw new Error('submit failed: ' + response.text);
  return response.body.runId;
};
const getRun = async (id) =>
  record(await api(submitter, 'GET', '/browser-runs/' + id)).body;
const TERMINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'NO_RESULTS'];
const until = async (id, statuses, ms = 180000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const current = await getRun(id);
    if (statuses.includes(current.status)) return current;
  }
  return getRun(id);
};
const approvalOf = async (id) =>
  record(await api(submitter, 'GET', `/browser-runs/${id}/approvals`)).body
    .approvals?.[0];
const decide = (id, verb, body, who = approver) =>
  api(who, 'POST', `/approvals/${id}/${verb}`, body).then(record);
const fixture = async (path, body) =>
  (
    await fetch(
      control + path,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    )
  ).json();
const posts = async () =>
  (await fixture('/requests')).filter((r) => r.method === 'POST');
const waitFor = async (predicate, ms = 60000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500))
    if (await predicate()) return true;
  return false;
};
const workflowStatus = (id) => {
  const described = JSON.parse(
    temporal('workflow', 'describe', '-w', 'swarm-' + id, '-o', 'json'),
  );
  return JSON.stringify(
    described.workflowExecutionInfo?.status ?? described.status,
  );
};
const workflowClosed = async (id, ms = 60000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const status = workflowStatus(id);
    if (!/RUNNING/.test(status)) return status;
  }
  return workflowStatus(id);
};
// Temporal JSON carries payloads base64-encoded: decode them before searching for secrets.
const history = (id) => {
  const raw = temporal('workflow', 'show', '-w', 'swarm-' + id, '-o', 'json');
  const decoded = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.data === 'string' && node.metadata)
        decoded.push(Buffer.from(node.data, 'base64').toString('utf8'));
      Object.values(node).forEach(walk);
    }
  };
  const parsed = JSON.parse(raw);
  walk(parsed);
  return { raw: raw + '\n' + decoded.join('\n'), events: parsed.events || [] };
};
const signals = (id) =>
  history(id).events.filter((e) =>
    /WORKFLOW_EXECUTION_SIGNALED/.test(String(e.eventType)),
  ).length;
const activations = (id) =>
  Number(
    sql(
      `SELECT count(*) FROM browser_actions WHERE run_id='${id}' AND kind='approved_activate'`,
    ),
  );
const workerChromium = () =>
  Number(
    inContainer(
      'browser-worker',
      'for p in /proc/[0-9]*; do grep -l chrome $p/comm 2>/dev/null; done | wc -l',
    ).trim(),
  );
const stopWorker = () => docker('stop', container('browser-worker'));
const killWorker = () => docker('kill', container('browser-worker'));
const startWorker = () => docker('start', container('browser-worker'));

// ---- step builders ------------------------------------------------------------------------
const formSteps = (extra = []) => [
  { kind: 'navigate', url: FORM },
  {
    kind: 'type',
    target: { kind: 'css', selector: 'textarea[name=message]' },
    text: TYPED,
  },
  {
    kind: 'submit',
    target: { kind: 'role', role: 'button', name: 'Send message' },
    description: 'Send the support message',
  },
  ...extra,
];
const runIds = [];
const paused = async (extra) => {
  const id = await submit(formSteps(extra));
  runIds.push(id);
  const state = await until(id, ['AWAITING_APPROVAL', ...TERMINAL]);
  return { id, state, approval: await approvalOf(id) };
};
const approve = (approval, who = approver) =>
  decide(
    approval.approvalId,
    'approve',
    { payloadHash: approval.payloadHash },
    who,
  );

async function scenarios() {
  await fixture('/reset', {});

  if (want('E')) {
    section(
      'E. Expiry (TTL 60 s), with API-level refusals while still pending',
    );
    const neverDecided = await paused();
    const approvedLate = await paused();
    check(
      'E pause: both runs wait in AWAITING_APPROVAL',
      neverDecided.state.status === 'AWAITING_APPROVAL' &&
        approvedLate.state.status === 'AWAITING_APPROVAL',
    );
    {
      const a = neverDecided.approval;
      const path = `/approvals/${a.approvalId}`;
      const results = {
        unauthenticated: (
          await api(null, 'POST', path + '/approve', {
            payloadHash: a.payloadHash,
          })
        ).status,
        otherTenantRead: (await api(other, 'GET', path)).status,
        otherTenantApprove: (
          await api(other, 'POST', path + '/approve', {
            payloadHash: a.payloadHash,
          })
        ).status,
        otherTenantList: (
          await api(other, 'GET', `/browser-runs/${neverDecided.id}/approvals`)
        ).status,
        otherTenantRun: (
          await api(other, 'GET', `/browser-runs/${neverDecided.id}`)
        ).status,
        otherTenantCancel: (
          await api(other, 'POST', `/browser-runs/${neverDecided.id}/cancel`)
        ).status,
        submitterApproves: (
          await api(submitter, 'POST', path + '/approve', {
            payloadHash: a.payloadHash,
          })
        ).status,
        wrongPayload: (
          await api(approver, 'POST', path + '/approve', {
            payloadHash: 'f'.repeat(64),
          })
        ).status,
        bodyScope: (
          await api(approver, 'POST', path + '/approve', {
            payloadHash: a.payloadHash,
            tenantId: tenantA,
          })
        ).status,
      };
      check(
        'E refusals: 401 unauthenticated; 404 for another tenant on approval, list, run and cancel; 403 submitter; 409 wrong payload hash; 400 body scope',
        results.unauthenticated === 401 &&
          results.otherTenantRead === 404 &&
          results.otherTenantApprove === 404 &&
          results.otherTenantList === 404 &&
          results.otherTenantRun === 404 &&
          results.otherTenantCancel === 404 &&
          results.submitterApproves === 403 &&
          results.wrongPayload === 409 &&
          results.bodyScope === 400,
        JSON.stringify(results),
      );
      const view = record(await api(submitter, 'GET', path)).body;
      check(
        'E approval view: bound action, form action and field names; no typed value',
        view.status === 'PENDING' &&
          view.action?.form?.action === SUBMIT &&
          JSON.stringify(view.action.form.fields) ===
            JSON.stringify([
              { name: 'message', type: 'textarea' },
              { name: 'account', type: 'hidden' },
            ]) &&
          !JSON.stringify(view).includes(TYPED),
      );
    }
    // Approved while no worker runs, and left until it expires before anything could use it.
    stopWorker();
    const late = await approve(approvedLate.approval);
    check(
      'E approver approves the second run while the worker is stopped',
      late.status === 200 && late.body.status === 'APPROVED',
    );
    const expiresAt = Date.parse(late.body.expiresAt);
    await sleep(Math.max(0, expiresAt - Date.now()) + 7000);
    startWorker();
    const expired = await until(neverDecided.id, TERMINAL, 120000);
    const expiredApproved = await until(approvedLate.id, TERMINAL, 120000);
    check(
      'E an undecided approval expires: PARTIAL, APPROVAL_EXPIRED',
      expired.status === 'PARTIAL' &&
        expired.output?.warnings?.includes('APPROVAL_EXPIRED'),
      JSON.stringify(expired.output?.warnings),
    );
    check(
      'E an approval that expired before execution is not used: PARTIAL, APPROVAL_EXPIRED',
      expiredApproved.status === 'PARTIAL' &&
        expiredApproved.output?.warnings?.includes('APPROVAL_EXPIRED'),
      JSON.stringify(expiredApproved.output?.warnings),
    );
    const lateApprove = await approve(neverDecided.approval);
    check(
      'E approving after expiry is refused (409 APPROVAL_EXPIRED)',
      lateApprove.status === 409 &&
        lateApprove.body.error?.code === 'APPROVAL_EXPIRED',
    );
    check('E no submission reached the fixture', (await posts()).length === 0);
  }
  if (want('A')) {
    section(
      'A. Approved action: exactly one POST, durable across a stopped worker and duplicate signals',
    );
    {
      const run = await paused([{ kind: 'read' }]);
      check(
        'A pause before any POST',
        run.state.status === 'AWAITING_APPROVAL' &&
          (await posts()).length === 0,
      );
      stopWorker();
      const ok = await approve(run.approval);
      check(
        'A approve (worker stopped)',
        ok.status === 200 &&
          ok.body.status === 'APPROVED' &&
          ok.body.decidedBy === 'approver-a',
      );
      const again = await approve(run.approval);
      check(
        'A duplicate approve refused, no second decision',
        again.status === 409 && again.body.error?.code === 'APPROVAL_APPROVED',
      );
      for (let i = 0; i < 5; i++)
        temporal(
          'workflow',
          'signal',
          '-w',
          'swarm-' + run.id,
          '--name',
          'approvalDecided',
        );
      await sleep(12000);
      check(
        'A while stopped: still waiting, approval still APPROVED, nothing sent',
        (await getRun(run.id)).status === 'AWAITING_APPROVAL' &&
          (await approvalOf(run.id)).status === 'APPROVED' &&
          (await posts()).length === 0,
      );
      startWorker();
      const done = await until(run.id, TERMINAL);
      const sent = await posts();
      check(
        'A completes after the worker returns',
        done.status === 'COMPLETED',
        done.status,
      );
      check(
        'A exactly one POST reached the fixture, to the approved URL',
        sent.length === 1 &&
          sent[0].path === '/submit' &&
          sent[0].host === 'forms.fixture.test',
        JSON.stringify(sent.map((p) => p.path)),
      );
      check(
        'A the POST carried the reviewed field values',
        sent[0]?.body.includes('account=acct-1') &&
          sent[0]?.body.includes(TYPED),
      );
      const approval = await approvalOf(run.id);
      check(
        'A approval CONSUMED, outcome SUCCEEDED with the HTTP status',
        approval.status === 'CONSUMED' &&
          approval.outcome === 'SUCCEEDED' &&
          approval.audit.at(-1)?.detail === 'HTTP 200',
        JSON.stringify(approval.audit.at(-1)),
      );
      check(
        'A audit: requested, approved, consumed, outcome; decision and consumption recorded once',
        JSON.stringify(approval.audit.map((e) => e.event)) ===
          JSON.stringify([
            'requested',
            'approved',
            'consumed',
            'outcome-succeeded',
          ]) &&
          approval.decidedBy === 'approver-a' &&
          !!approval.decidedAt &&
          !!approval.consumedAt,
      );
      check(
        'A exactly one approved activation recorded',
        activations(run.id) === 1,
      );
      check(
        'A result evidence persisted for the run, tenant and project',
        sql(
          `SELECT count(*) FROM evidence e JOIN runs r ON r.id=e.run_id WHERE e.run_id='${run.id}' AND e.url='${SUBMIT}' AND r.tenant_id='${tenantA}'`,
        ) === '1',
      );
      const extra = signals(run.id);
      check(
        'A redundant signals (API, 5 manual, dispatcher re-signals) caused no second action',
        extra >= 7 && sent.length === 1,
        'signals ' + extra,
      );
      check(
        'A workflow completed',
        /COMPLETED/.test(await workflowClosed(run.id)),
      );
      const repeat = await approve(run.approval);
      check(
        'A a consumed approval cannot be approved again',
        repeat.status === 409 &&
          repeat.body.error?.code === 'APPROVAL_CONSUMED',
      );
    }
  }
  if (want('B')) {
    section('B. Page or action changed after approval');
    for (const [variant, expected] of [
      // The form action is part of the approved action itself; field values are page state.
      ['action-changed', 'APPROVAL_PAYLOAD_CHANGED'],
      ['value-changed', 'APPROVAL_PAGE_CHANGED'],
    ]) {
      await fixture('/reset', {});
      const run = await paused();
      await fixture('/state', { variant });
      await approve(run.approval);
      const done = await until(run.id, TERMINAL);
      const approval = await approvalOf(run.id);
      const step = done.output?.steps?.find((s) => s.kind === 'submit');
      check(
        `B ${variant}: refused before acting (${expected}), approval retired, no POST`,
        done.status === 'PARTIAL' &&
          step?.error?.code === expected &&
          approval.status === 'CANCELLED' &&
          approval.decisionReason === expected &&
          (await posts()).length === 0 &&
          activations(run.id) === 0,
        JSON.stringify(step?.error),
      );
    }
    await fixture('/reset', {});
  }
  if (want('C')) {
    section('C. Missing approval: risky clicks and model actions stay refused');
    {
      const id = await submit([
        { kind: 'navigate', url: FORM },
        {
          kind: 'click',
          target: { kind: 'role', role: 'button', name: 'Send message' },
        },
      ]);
      runIds.push(id);
      const done = await until(id, TERMINAL);
      check(
        'C plain click on the submit control: step failed, no POST',
        done.status === 'PARTIAL' &&
          done.output?.steps?.[1]?.status === 'failed' &&
          (await posts()).length === 0,
        JSON.stringify(done.output?.steps?.[1]?.error),
      );
      const act = await submit([
        { kind: 'navigate', url: FORM },
        { kind: 'act', instruction: 'click the Send message button' },
      ]);
      runIds.push(act);
      const acted = await until(act, TERMINAL);
      check(
        'C Stagehand act on the submit control: refused, no POST',
        acted.status === 'PARTIAL' &&
          acted.output?.steps?.[1]?.status === 'failed' &&
          (await posts()).length === 0,
        JSON.stringify(acted.output?.steps?.[1]?.error),
      );
    }
  }
  if (want('D')) {
    section('D. Uncertain outcomes after the single POST');
    for (const [mode, code, outcome] of [
      ['reset', 'APPROVED_ACTION_UNCERTAIN', 'UNKNOWN'],
      ['error', 'APPROVED_ACTION_UNCERTAIN', 'UNKNOWN'],
      ['refuse', 'APPROVED_REQUEST_REJECTED', 'FAILED'],
      ['slow', 'APPROVED_ACTION_UNCERTAIN', 'UNKNOWN'],
    ]) {
      await fixture('/reset', {});
      await fixture('/state', { mode, delayMs: 40000 });
      const run = await paused();
      await approve(run.approval);
      const done = await until(run.id, TERMINAL);
      const step = done.output?.steps?.find((s) => s.kind === 'submit');
      const approval = await approvalOf(run.id);
      await sleep(mode === 'slow' ? 2000 : 0);
      check(
        `D ${mode === 'slow' ? 'timeout (no response in 15 s)' : mode}: ${code}, outcome ${outcome}, exactly one POST, not retried`,
        done.status === 'PARTIAL' &&
          step?.error?.code === code &&
          approval.outcome === outcome &&
          (await posts()).length === 1 &&
          activations(run.id) === 1,
        JSON.stringify({
          status: done.status,
          step: step?.error?.code,
          outcome: approval.outcome,
          posts: (await posts()).length,
          activations: activations(run.id),
        }),
      );
    }
    await fixture('/reset', {});
  }
  if (want('F')) {
    section(
      'F. Worker crash and graceful shutdown after the approval was consumed',
    );
    for (const how of ['kill', 'stop']) {
      await fixture('/reset', {});
      await fixture('/state', { mode: 'slow', delayMs: 30000 });
      const run = await paused();
      await approve(run.approval);
      const reached = await waitFor(
        async () => (await posts()).length === 1,
        60000,
      );
      if (how === 'kill') killWorker();
      else stopWorker();
      const between = (await getRun(run.id)).status;
      startWorker();
      const done = await until(run.id, TERMINAL, 240000);
      await sleep(3000);
      const approval = await approvalOf(run.id);
      check(
        `F ${how}: the POST was in flight when the worker went down`,
        reached,
      );
      check(
        `F ${how}: the run is not cancelled by the shutdown`,
        between !== 'CANCELLED',
        between,
      );
      check(
        // A crash leaves the outcome to the next attempt, which never replays it. A graceful
        // stop lets the in-flight attempt decide it within the grace period (15 s response
        // timeout, 20 s grace); if the grace period ends first, the retry decides it instead.
        `F ${how}: approval UNKNOWN, exactly one POST, never replayed`,
        done.status === 'PARTIAL' &&
          ((done.output?.warnings?.includes('RESUME_UNSAFE') &&
            done.output?.warnings?.includes('OUTCOME_UNKNOWN')) ||
            (how === 'stop' &&
              done.output?.steps?.find((s) => s.kind === 'submit')?.error
                ?.code === 'APPROVED_ACTION_UNCERTAIN')) &&
          approval.status === 'CONSUMED' &&
          approval.outcome === 'UNKNOWN' &&
          (await posts()).length === 1,
        JSON.stringify({
          status: done.status,
          warnings: done.output?.warnings,
          step: done.output?.steps?.find((s) => s.kind === 'submit')?.error
            ?.code,
          outcome: approval.outcome,
          posts: (await posts()).length,
        }),
      );
    }
    await fixture('/reset', {});
  }
  if (want('G')) {
    section('G. Graceful shutdown drains in-flight read-only work');
    {
      await fixture('/state', { slowReads: 1, slowReadMs: 8000 });
      const id = await submit([
        { kind: 'navigate', url: 'https://forms.fixture.test/slow-read' },
        { kind: 'read' },
      ]);
      runIds.push(id);
      await waitFor(
        async () =>
          (await fixture('/requests')).some((r) => r.path === '/slow-read'),
        60000,
      );
      const stopped = Date.now();
      stopWorker();
      const stopMs = Date.now() - stopped;
      const status = (await getRun(id)).status;
      startWorker();
      const done = await until(id, TERMINAL);
      check(
        'G SIGTERM waited for the in-flight run instead of cancelling it',
        status === 'COMPLETED' && done.status === 'COMPLETED',
        JSON.stringify({ atStop: status, final: done.status, stopMs }),
      );
    }
    await fixture('/reset', {});
  }
  if (want('H')) {
    section('H. Cancellation before and after the approval was consumed');
    {
      const before = await paused();
      const cancelled = record(
        await api(submitter, 'POST', `/browser-runs/${before.id}/cancel`),
      );
      const approval = await approvalOf(before.id);
      check(
        'H before: run CANCELLED, approval CANCELLED, no POST',
        cancelled.body.status === 'CANCELLED' &&
          approval.status === 'CANCELLED' &&
          (await posts()).length === 0,
      );
      const late = await approve(before.approval);
      check(
        'H before: approving afterwards is refused',
        late.status === 409 && late.body.error?.code === 'APPROVAL_CANCELLED',
      );
      check(
        'H before: workflow cancelled',
        /CANCEL/.test(await workflowClosed(before.id)),
      );

      await fixture('/state', { mode: 'slow', delayMs: 30000 });
      const after = await paused();
      await approve(after.approval);
      await waitFor(async () => (await posts()).length === 1, 60000);
      record(await api(submitter, 'POST', `/browser-runs/${after.id}/cancel`));
      const done = await until(after.id, TERMINAL, 60000);
      await waitFor(
        async () => (await approvalOf(after.id)).outcome !== null,
        30000,
      );
      const consumed = await approvalOf(after.id);
      check(
        'H after: run CANCELLED; approval stays CONSUMED with outcome UNKNOWN; exactly one POST',
        done.status === 'CANCELLED' &&
          consumed.status === 'CONSUMED' &&
          consumed.outcome === 'UNKNOWN' &&
          (await posts()).length === 1 &&
          activations(after.id) === 1,
        JSON.stringify({
          status: done.status,
          approval: consumed.status,
          outcome: consumed.outcome,
        }),
      );
      check(
        'H after: workflow cancelled',
        /CANCEL/.test(await workflowClosed(after.id)),
      );
    }
    await fixture('/reset', {});
  }
  if (want('I')) {
    section('I. Egress and SSRF on the real stack');
    {
      const id = await submit([
        { kind: 'navigate', url: 'https://private.fixture.test/read' },
      ]);
      runIds.push(id);
      const done = await until(id, TERMINAL);
      const reachedPrivate = (await fixture('/requests')).some((r) =>
        r.host.startsWith('private.fixture.test'),
      );
      check(
        'I an allowlisted name resolving to a private address is not reached',
        done.status === 'FAILED' && !reachedPrivate,
        JSON.stringify(done.output?.steps?.[0]?.error),
      );
      for (const url of [
        'http://postgres:5432/',
        'https://forms.fixture.test:8080/requests',
        'http://11.66.0.10/read',
        'https://forms.fixture.test./read',
      ]) {
        const blocked = await submit([{ kind: 'navigate', url }]);
        runIds.push(blocked);
        const result = await until(blocked, TERMINAL);
        check(
          'I navigation denied: ' + url,
          result.status === 'FAILED',
          JSON.stringify(result.output?.steps?.[0]?.error),
        );
      }
      check(
        'I the fixture control port and other URLs were never reached by the browser',
        !(await fixture('/requests')).some((r) => r.path === '/requests'),
      );
    }
  }
  if (want('J')) {
    section('J. Read-only and extraction workflows unchanged');
    {
      const read = await submit([
        { kind: 'navigate', url: READ },
        { kind: 'read' },
      ]);
      const extract = await submit([
        { kind: 'navigate', url: READ },
        {
          kind: 'extract',
          instruction: 'Extract the section headings',
          schema: {
            type: 'object',
            properties: {
              sections: { type: 'array', items: { type: 'string' } },
            },
            required: ['sections'],
          },
        },
      ]);
      runIds.push(read, extract);
      const r = await until(read, TERMINAL);
      const x = await until(extract, TERMINAL);
      const listed = record(
        await api(submitter, 'GET', `/browser-runs/${extract}/extractions`),
      ).body;
      check(
        'J read-only run completes with evidence and no approval',
        r.status === 'COMPLETED' &&
          sql(`SELECT count(*) FROM approvals WHERE run_id='${read}'`) ===
            '0' &&
          sql(`SELECT count(*) FROM evidence WHERE run_id='${read}'`) === '1',
      );
      check(
        'J extraction run completes with a persisted extraction',
        x.status === 'COMPLETED' && listed.extractions?.length === 1,
        x.status,
      );
      check(
        'J another tenant cannot list the extractions',
        (await api(other, 'GET', `/browser-runs/${extract}/extractions`))
          .status === 404,
      );
    }
  }
  if (want('K')) {
    section('K. Health and database outage');
    {
      const live = await fetch(base + '/health/live');
      const ready = await fetch(base + '/health/ready');
      check(
        'K live and ready while dependencies are up',
        live.status === 200 && ready.status === 200,
      );
      docker('stop', container('postgres'));
      const liveDown = await fetch(base + '/health/live');
      const readyDown = await fetch(base + '/health/ready');
      const readyBody = await readyDown.text();
      const create = await api(submitter, 'POST', '/browser-runs', {
        steps: [{ kind: 'navigate', url: READ }],
      });
      docker('start', container('postgres'));
      await waitFor(
        async () => (await fetch(base + '/health/ready')).status === 200,
        90000,
      );
      check(
        // The global exception filter reduces the 503 body to a generic error on purpose.
        'K database down: live 200, ready 503, no secret in the body',
        liveDown.status === 200 &&
          readyDown.status === 503 &&
          !SECRETS.some((s) => readyBody.includes(s)),
        JSON.stringify({ live: liveDown.status, ready: readyDown.status }),
      );
      check(
        'K database down: a new run is refused, not falsely accepted',
        create.status >= 500,
        String(create.status),
      );
      check(
        'K ready again after the database returns',
        (await fetch(base + '/health/ready')).status === 200,
      );
    }
  }
}

async function finalChecks() {
  section('L. Integrity across every run');
  const ids = runIds.map((id) => `'${id}'`).join(',');
  check(
    'L every run terminal with output and its lease released',
    sql(
      `SELECT count(*) FROM runs WHERE id IN (${ids}) AND (status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED') OR output IS NULL OR lease_owner IS NOT NULL)`,
    ) === '0',
    sql(
      `SELECT string_agg(id||':'||status||':'||(output IS NULL)||':'||(lease_owner IS NOT NULL), ' ') FROM runs WHERE id IN (${ids}) AND (status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED') OR output IS NULL OR lease_owner IS NOT NULL)`,
    ),
  );
  check(
    'L no approval left open on a finished run',
    sql(
      `SELECT count(*) FROM approvals WHERE run_id IN (${ids}) AND status IN ('PENDING','APPROVED')`,
    ) === '0',
  );
  check(
    'L at most one activation per run, only with a consumed approval',
    sql(
      `SELECT count(*) FROM (SELECT b.run_id FROM browser_actions b LEFT JOIN approvals a ON a.run_id=b.run_id AND a.status='CONSUMED' WHERE b.run_id IN (${ids}) AND b.kind='approved_activate' GROUP BY b.run_id HAVING count(*)>1 OR count(a.id)=0) d`,
    ) === '0',
  );
  check(
    'L consumed approvals record the approver, decision and consumption times and the attempt',
    sql(
      `SELECT count(*) FROM approvals WHERE run_id IN (${ids}) AND status='CONSUMED' AND (decision_by IS NULL OR decided_at IS NULL OR consumed_at IS NULL OR consumed_by IS NULL)`,
    ) === '0',
  );
  check(
    // Evidence is scoped through its run (foreign key); extractions and approvals carry scope.
    'L extractions and approvals carry their run tenant and project',
    sql(
      `SELECT count(*) FROM extractions x JOIN runs r ON r.id=x.run_id WHERE x.run_id IN (${ids}) AND (x.tenant_id<>r.tenant_id OR x.project_id<>r.project_id)`,
    ) === '0' &&
      sql(
        `SELECT count(*) FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.run_id IN (${ids}) AND (a.tenant_id<>r.tenant_id OR a.project_id<>r.project_id)`,
      ) === '0',
  );
  check(
    'L no duplicate evidence per (run, url)',
    sql(
      `SELECT count(*) FROM (SELECT run_id,url FROM evidence WHERE run_id IN (${ids}) GROUP BY 1,2 HAVING count(*)>1) d`,
    ) === '0',
  );
  const consumed = Number(
    sql(
      `SELECT count(*) FROM approvals WHERE run_id IN (${ids}) AND status='CONSUMED'`,
    ),
  );
  check('L no Chromium processes left in the worker', workerChromium() === 0);

  section('M. Secrets and audit');
  const logs = compose('logs', '--no-color');
  const dumpAll = inContainer(
    'postgres',
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only',
  );
  const dumpWithoutRuns = inContainer(
    'postgres',
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only --exclude-table=runs',
  );
  const histories = runIds.map((id) => history(id).raw).join('\n');
  check(
    'M credentials, model key and database password absent from logs, database and workflow histories',
    !SECRETS.some(
      (s) => logs.includes(s) || dumpAll.includes(s) || histories.includes(s),
    ),
  );
  check(
    'M the typed form value is absent from logs, workflow histories, API responses and every table but the stored run definition',
    !logs.includes(TYPED) &&
      !histories.includes(TYPED) &&
      !responses.some((r) => r.includes(TYPED)) &&
      !dumpWithoutRuns.includes(TYPED),
  );
  check(
    'M (known limitation) the typed value is stored in the run definition (runs.input)',
    dumpAll.includes(TYPED),
  );
  const audit = logs
    .split('\n')
    .filter((line) => line.includes('"event":"approval.'));
  const outcomes = new Set(
    audit.map((line) => line.match(/"outcome":"([A-Z_]+)"/)?.[1]),
  );
  check(
    'M API audit log records decisions and refusals by ids and outcome',
    // The outcomes the sections that ran must have produced.
    [
      'APPROVED',
      ...(want('E')
        ? ['CAPABILITY_DENIED', 'APPROVAL_PAYLOAD_MISMATCH', 'APPROVAL_EXPIRED']
        : []),
      ...(want('A') ? ['APPROVAL_APPROVED'] : []),
      ...(want('H') ? ['APPROVAL_CANCELLED'] : []),
    ].every((o) => outcomes.has(o)),
    [...outcomes].join(','),
  );
  console.log('consumed approvals: ' + consumed);
}

// ---- main ---------------------------------------------------------------------------------
let exitCode = 1;
try {
  console.log('# Phase 6 Compose acceptance (' + project + ')');
  compose('down', '-v', '--remove-orphans');
  console.log('building and starting the stack...');
  compose('up', '-d', '--build', '--wait');
  console.log(
    'migrations: ' +
      sql(
        "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations",
      ),
  );
  await scenarios();
  await finalChecks();
  console.log(`\nRESULT ${passes} passed, ${failures} failed`);
  exitCode = failures ? 1 : 0;
} catch (error) {
  console.log(
    'ERROR ' +
      (error instanceof Error ? error.message.split('\n')[0] : 'unknown'),
  );
} finally {
  if (!keep) {
    try {
      compose('down', '-v', '--remove-orphans');
    } catch {
      console.log(
        'teardown failed: run docker compose -p ' + project + ' down -v',
      );
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
