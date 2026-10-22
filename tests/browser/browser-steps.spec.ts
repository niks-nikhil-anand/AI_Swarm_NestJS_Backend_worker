import type { Page } from 'playwright';
import {
  BrowserStepsRequestSchema,
  type BrowserStepsRequest,
} from '../../src/browser/contracts/browser-step';
import { BrowserRunRequestSchema } from '../../src/browser/contracts/browser-request';
import {
  resumeBlocked,
  runBrowserSteps,
  uncertainSteps,
  type StepApproval,
  type StepRecord,
  type StepRunContext,
} from '../../src/browser/browser-steps.runner';
import type { BrowserAction } from '../../src/browser/contracts/browser-action';
import type { Extraction } from '../../src/persistence/run.repository';
import type { BrowserSession } from '../../src/browser/contracts/browser-session';
import { BrowserError } from '../../src/common/errors/browser.errors';
import { PolicyError } from '../../src/common/errors/policy.errors';
import { ServiceError } from '../../src/common/errors/service.error';
import { ModelProviderError } from '../../src/browser/adapters/stagehand/model-provider';

const steps = (input: unknown) => BrowserStepsRequestSchema.parse(input);

describe('Browser step validation', () => {
  test('accepts the supported sequential steps with defaults', () => {
    const request = steps({
      steps: [
        { kind: 'navigate', url: 'https://example.com/' },
        { kind: 'inspect' },
        { kind: 'click', target: { kind: 'role', role: 'link', name: 'Next' } },
        { kind: 'type', target: { kind: 'css', selector: '#q' }, text: 'x' },
        { kind: 'scroll', pixels: 400 },
        { kind: 'wait_for', target: { kind: 'css', selector: 'h1' } },
        { kind: 'go_back' },
        { kind: 'new_tab', url: 'https://example.com/' },
        { kind: 'switch_tab', index: 0 },
        { kind: 'observe', instruction: 'find the pricing link' },
        { kind: 'act', instruction: 'click the pricing link' },
        { kind: 'read' },
      ],
    });
    expect(request.maxStepAttempts).toBe(2);
    expect(request.steps[3]).toMatchObject({ mode: 'fill' });
    expect(request.steps[11]).toMatchObject({ screenshot: false });
  });
  test.each([
    ['unknown step', { kind: 'press', key: 'Enter' }],
    ['submit step', { kind: 'submit' }],
    ['script step', { kind: 'evaluate', script: 'fetch("/")' }],
    ['non-http navigation', { kind: 'navigate', url: 'file:///etc/passwd' }],
    [
      'element reference',
      { kind: 'click', target: { kind: 'reference', id: '0b5c' } },
    ],
    ['extra field', { kind: 'inspect', selector: '*' }],
    ['empty instruction', { kind: 'act', instruction: '  ' }],
    ['oversized scroll', { kind: 'scroll', pixels: 100000 }],
    [
      'long wait',
      {
        kind: 'wait_for',
        target: { kind: 'css', selector: 'a' },
        timeoutMs: 60000,
      },
    ],
  ])('rejects %s', (_name, step) => {
    expect(() => steps({ steps: [step] })).toThrow();
  });
  test('bounds run length and step attempts', () => {
    expect(() => steps({ steps: [] })).toThrow();
    expect(() =>
      steps({ steps: Array(26).fill({ kind: 'inspect' }) }),
    ).toThrow();
    expect(() =>
      steps({ steps: [{ kind: 'inspect' }], maxStepAttempts: 5 }),
    ).toThrow();
  });
  test('the browser runs API accepts either capture or steps, never both', () => {
    expect(
      BrowserRunRequestSchema.parse({ urls: ['https://example.com/'] }),
    ).toMatchObject({ screenshot: false });
    expect(
      BrowserRunRequestSchema.parse({ steps: [{ kind: 'inspect' }] }),
    ).toMatchObject({ maxStepAttempts: 2 });
    expect(() =>
      BrowserRunRequestSchema.parse({
        urls: ['https://example.com/'],
        steps: [{ kind: 'inspect' }],
      }),
    ).toThrow();
  });
});

// Runner double: tabs are plain objects; execute() is scripted per action kind.
function harness(
  script: Partial<
    Record<
      BrowserAction['kind'],
      (action: BrowserAction, call: number) => unknown
    >
  >,
) {
  const tabs = new Map<string, Page>();
  const addTab = (url = 'about:blank') => {
    const id = 'tab-' + tabs.size;
    tabs.set(id, { url: () => url, isClosed: () => false } as unknown as Page);
    return id;
  };
  addTab();
  const calls: BrowserAction[] = [];
  const records: { step: StepRecord; input: Record<string, unknown> }[] = [];
  const evidence: string[] = [];
  const extractions: Extraction[] = [];
  const screenshotKeys: string[] = [];
  let cancelled = false;
  // Approval double: what the repository would hold, and the runner's calls into it.
  const approvals = new Map<number, StepApproval & { pageHash: string }>();
  const approvalCalls: string[] = [];
  const context: StepRunContext = {
    session: { tabs } as unknown as BrowserSession,
    runAttempt: 1,
    runId: 'run-1',
    attemptId: 'attempt-1',
    approvals: {
      async forStep(step) {
        return approvals.get(step);
      },
      async request(step, proposal) {
        approvalCalls.push('request:' + step);
        const approval = {
          id: 'approval-' + step,
          status: 'PENDING',
          expiresAt: '2099-01-01T00:00:00.000Z',
          payloadHash: proposal.payloadHash,
          pageHash: proposal.pageHash,
        };
        approvals.set(step, approval);
        return approval;
      },
      async consume(step, id, payloadHash, pageHash) {
        const approval = approvals.get(step);
        if (approval?.id !== id || approval.status !== 'APPROVED')
          throw new PolicyError('APPROVAL_ALREADY_CONSUMED', 'used');
        if (approval.payloadHash !== payloadHash)
          throw new PolicyError('APPROVAL_PAYLOAD_CHANGED', 'changed');
        if (approval.pageHash !== pageHash)
          throw new PolicyError('APPROVAL_PAGE_CHANGED', 'changed');
        approval.status = 'CONSUMED';
        approvalCalls.push('consume:' + step);
      },
      authorize(step, pageHash) {
        approvalCalls.push('authorize:' + step + ':' + pageHash.slice(0, 4));
      },
      async outcome(_id, outcome, detail) {
        approvalCalls.push('outcome:' + outcome + (detail ? ':' + detail : ''));
      },
    },
    async execute(action) {
      calls.push(action);
      const handler = script[action.kind];
      if (action.kind === 'new_tab' && !handler) return addTab();
      if (action.kind === 'observe' && !handler)
        return { url: 'u', title: 't', elements: [] };
      return handler
        ? handler(action, calls.filter((c) => c.kind === action.kind).length)
        : { ok: true };
    },
    async record(step, input) {
      records.push({ step, input });
    },
    async saveEvidence(url) {
      evidence.push(url);
      return 'evidence-' + evidence.length;
    },
    async saveSourcedExtraction(url, _item, extraction) {
      evidence.push(url);
      const evidenceId = 'evidence-' + evidence.length;
      extractions.push({ ...extraction, evidenceId });
      return { evidenceId, extractionId: 'extraction-' + extractions.length };
    },
    async saveScreenshot(_bytes, key) {
      screenshotKeys.push(key);
      return 'artifact';
    },
    cancelled: () => cancelled,
  };
  return {
    context,
    calls,
    records,
    evidence,
    extractions,
    screenshotKeys,
    approvals,
    approvalCalls,
    cancel: () => (cancelled = true),
  };
}
const run = (input: unknown, context: StepRunContext) =>
  runBrowserSteps(steps(input) as BrowserStepsRequest, context);
const article = {
  url: 'https://example.com/next',
  title: 'Next',
  text: 'Body',
};

describe('Browser step runner', () => {
  test('runs steps in order, records each one and persists read evidence', async () => {
    const h = harness({
      extract: () => article,
      observe: () => ({
        url: 'u',
        title: 't',
        elements: [{ id: 'ref', label: 'Next' }],
      }),
    });
    const output = await run(
      {
        steps: [
          { kind: 'navigate', url: 'https://example.com/' },
          { kind: 'inspect' },
          {
            kind: 'click',
            target: { kind: 'role', role: 'link', name: 'Next' },
          },
          { kind: 'read' },
        ],
      },
      h.context,
    );
    expect(output.status).toBe('COMPLETED');
    expect(h.calls.map((c) => c.kind)).toEqual([
      'open',
      'observe',
      'click',
      'extract',
    ]);
    expect(output.steps.map((s) => [s.index, s.kind, s.status])).toEqual([
      [0, 'navigate', 'success'],
      [1, 'inspect', 'success'],
      [2, 'click', 'success'],
      [3, 'read', 'success'],
    ]);
    // Element reference ids stay inside the session; the record carries labels only.
    expect(output.steps[1].result).toEqual({
      url: 'u',
      title: 't',
      elements: ['Next'],
    });
    expect(h.evidence).toEqual(['https://example.com/next']);
    expect(output.evidence[0]).toMatchObject({ step: 3, schemaId: 'article' });
    expect(output.steps.every((s) => s.durationMs >= 0)).toBe(true);
  });

  test('stops at the first failed step and reports a partial run', async () => {
    const h = harness({
      click: () => {
        throw new PolicyError(
          'APPROVAL_REQUIRED',
          'Consequential actions are not enabled',
        );
      },
    });
    const output = await run(
      {
        steps: [
          { kind: 'navigate', url: 'https://example.com/' },
          {
            kind: 'click',
            target: { kind: 'role', role: 'button', name: 'Delete' },
          },
          { kind: 'read' },
        ],
      },
      h.context,
    );
    expect(output.status).toBe('PARTIAL');
    expect(output.steps[1]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: { code: 'APPROVAL_REQUIRED', retryable: false },
    });
    expect(output.warnings).toEqual(['STEP_1_APPROVAL_REQUIRED']);
    expect(h.calls.map((c) => c.kind)).toEqual(['open', 'click']);
  });

  test('a failing first step fails the run', async () => {
    const h = harness({
      open: () => {
        throw new BrowserError(
          'DOMAIN_DENIED',
          'Destination domain not allowed',
        );
      },
    });
    const output = await run(
      { steps: [{ kind: 'navigate', url: 'https://evil.test/' }] },
      h.context,
    );
    expect(output.status).toBe('FAILED');
  });

  test('retries transient failures of replayable steps within the attempt budget', async () => {
    const h = harness({
      open: (_a, call) => {
        if (call === 1)
          throw new BrowserError('BROWSER_TIMEOUT', 'timed out', 400, true);
        return { url: 'https://example.com/' };
      },
    });
    const output = await run(
      { steps: [{ kind: 'navigate', url: 'https://example.com/' }] },
      h.context,
    );
    expect(output.steps[0]).toMatchObject({ status: 'success', attempts: 2 });
  });

  test('never retries a click or an act whose effect may already have happened', async () => {
    const timeoutClick = harness({
      click: () => {
        throw new BrowserError('BROWSER_TIMEOUT', 'timed out', 400, true);
      },
    });
    await run(
      {
        steps: [{ kind: 'click', target: { kind: 'css', selector: 'a' } }],
        maxStepAttempts: 3,
      },
      timeoutClick.context,
    );
    expect(timeoutClick.calls).toHaveLength(1);
    const timeoutAct = harness({
      semantic_act: () => {
        throw new BrowserError('STAGEHAND_ACTION_TIMEOUT', 'late', 504, true);
      },
    });
    const output = await run(
      {
        steps: [{ kind: 'act', instruction: 'click next' }],
        maxStepAttempts: 3,
      },
      timeoutAct.context,
    );
    expect(timeoutAct.calls).toHaveLength(1);
    expect(output.steps[0].error).toMatchObject({
      code: 'STAGEHAND_ACTION_TIMEOUT',
    });
  });

  test('retries an act whose model call failed before anything was executed', async () => {
    const h = harness({
      semantic_act: (_a, call) => {
        if (call < 3)
          throw new ModelProviderError(
            'MODEL_RATE_LIMITED',
            'rate limited',
            true,
          );
        return { action: { method: 'click' } };
      },
    });
    const output = await run(
      {
        steps: [{ kind: 'act', instruction: 'click next' }],
        maxStepAttempts: 3,
      },
      h.context,
    );
    expect(output.steps[0]).toMatchObject({ status: 'success', attempts: 3 });
  });

  test('new tabs are opened through the Playwright new_tab action and become current', async () => {
    const h = harness({});
    await run(
      {
        steps: [
          { kind: 'new_tab', url: 'https://example.com/' },
          { kind: 'inspect' },
          { kind: 'switch_tab', index: 0 },
          { kind: 'inspect' },
        ],
      },
      h.context,
    );
    expect(
      h.calls.map((c) => [c.kind, 'tabId' in c ? c.tabId : undefined]),
    ).toEqual([
      ['new_tab', undefined],
      ['open', 'tab-1'],
      ['observe', 'tab-1'],
      ['observe', 'tab-0'],
    ]);
  });

  test('typed text is not copied into the action log', async () => {
    const h = harness({});
    await run(
      {
        steps: [
          {
            kind: 'type',
            target: { kind: 'css', selector: '#q' },
            text: 'secret words',
          },
        ],
      },
      h.context,
    );
    expect(h.records[0].input).toMatchObject({ kind: 'type', textLength: 12 });
    expect(JSON.stringify(h.records[0].input)).not.toContain('secret');
  });

  test('cancellation stops the run instead of reporting a step failure', async () => {
    const h = harness({
      open: () => {
        h.cancel();
        throw new BrowserError('BROWSER_ACTION_FAILED', 'closed');
      },
    });
    await expect(
      run(
        {
          steps: [
            { kind: 'navigate', url: 'https://example.com/' },
            { kind: 'inspect' },
          ],
        },
        h.context,
      ),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(h.records).toHaveLength(0);
  });

  test('resuming is unsafe once a state-changing step was attempted', () => {
    expect(resumeBlocked([])).toBe(false);
    expect(
      resumeBlocked([
        { index: 0, kind: 'navigate', status: 'success' },
        { index: 1, kind: 'read', status: 'failed' },
      ]),
    ).toBe(false);
    expect(resumeBlocked([{ index: 1, kind: 'click', status: 'failed' }])).toBe(
      true,
    );
    expect(resumeBlocked([{ index: 2, kind: 'act', status: 'success' }])).toBe(
      true,
    );
    expect(resumeBlocked([{ index: 2, kind: 'type', status: 'success' }])).toBe(
      true,
    );
    // Extraction is read-only, so a retried run may repeat it.
    expect(
      resumeBlocked([{ index: 3, kind: 'extract', status: 'success' }]),
    ).toBe(false);
  });

  test('extract persists validated data linked to the source evidence of the same page', async () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const h = harness({
      semantic_extract: () => ({
        url: 'https://example.com/next',
        data: { title: 'Next' },
        missing: [],
        bytes: 16,
        usage: { calls: 2, tokens: 900 },
      }),
      extract: () => article,
    });
    const output = await run(
      {
        steps: [
          {
            kind: 'extract',
            instruction: 'get the title',
            schema,
            scope: 'main',
          },
        ],
      },
      h.context,
    );
    expect(output.status).toBe('COMPLETED');
    expect(h.calls.map((c) => c.kind)).toEqual(['semantic_extract', 'extract']);
    expect(h.calls[0]).toMatchObject({
      instruction: 'get the title',
      schema,
      scope: 'main',
    });
    expect(h.evidence).toEqual(['https://example.com/next']);
    expect(h.extractions).toEqual([
      expect.objectContaining({
        step: 0,
        url: 'https://example.com/next',
        data: { title: 'Next' },
        evidenceId: 'evidence-1',
        modelCalls: 2,
        modelTokens: 900,
        schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(output.steps[0].result).toMatchObject({
      extractionId: 'extraction-1',
      evidenceId: 'evidence-1',
      data: { title: 'Next' },
    });
    expect(output.evidence[0]).toMatchObject({
      purpose: 'extraction-source',
      step: 0,
    });
  });

  test('a malformed extraction is retried as a model error and nothing is persisted', async () => {
    const h = harness({
      semantic_extract: () => {
        throw new BrowserError(
          'EXTRACT_OUTPUT_INVALID',
          'Model output does not match the schema at $.title',
          502,
          true,
        );
      },
    });
    const output = await run(
      {
        steps: [
          {
            kind: 'extract',
            instruction: 'get the title',
            schema: {
              type: 'object',
              properties: { title: { type: 'string' } },
            },
          },
        ],
        maxStepAttempts: 2,
      },
      h.context,
    );
    expect(output.steps[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      error: { code: 'EXTRACT_OUTPUT_INVALID' },
    });
    expect(h.extractions).toEqual([]);
    expect(h.evidence).toEqual([]);
  });

  describe('Phase 4 hardening', () => {
    test('a started record is written before each non-replayable step, never for replayable ones', async () => {
      const h = harness({ extract: () => article });
      await run(
        {
          steps: [
            { kind: 'navigate', url: 'https://example.com/' },
            { kind: 'click', target: { kind: 'css', selector: 'a' } },
            {
              kind: 'type',
              target: { kind: 'css', selector: '#q' },
              text: 'x',
            },
            { kind: 'read' },
          ],
        },
        h.context,
      );
      expect(h.records.map((r) => [r.step.index, r.step.status])).toEqual([
        [0, 'success'],
        [1, 'started'],
        [1, 'success'],
        [2, 'started'],
        [2, 'success'],
        [3, 'success'],
      ]);
    });

    test('if the intent cannot be recorded, the click is never executed', async () => {
      const h = harness({});
      h.context.record = async (step) => {
        if (step.status === 'started')
          throw new ServiceError(
            'PERSISTENCE_UNAVAILABLE',
            'Run storage is unavailable',
            503,
            true,
          );
      };
      await expect(
        run(
          {
            steps: [{ kind: 'click', target: { kind: 'css', selector: 'a' } }],
          },
          h.context,
        ),
      ).rejects.toMatchObject({
        code: 'PERSISTENCE_UNAVAILABLE',
        retryable: true,
      });
      expect(h.calls).toEqual([]);
    });

    test('a storage outage ends the attempt instead of failing the step', async () => {
      const h = harness({ extract: () => article });
      h.context.saveEvidence = async () => {
        throw new ServiceError(
          'PERSISTENCE_UNAVAILABLE',
          'Run storage is unavailable',
          503,
          true,
        );
      };
      await expect(
        run(
          {
            steps: [
              { kind: 'navigate', url: 'https://example.com/' },
              { kind: 'read' },
            ],
            maxStepAttempts: 3,
          },
          h.context,
        ),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
      // Not retried inside the attempt and not recorded as a step outcome.
      expect(h.calls.filter((c) => c.kind === 'extract')).toHaveLength(1);
      expect(h.records.map((r) => r.step.status)).toEqual(['success']);
    });

    test('screenshots carry a per-step idempotency key', async () => {
      const h = harness({
        extract: () => article,
        screenshot: () => Buffer.from('png'),
      });
      await run({ steps: [{ kind: 'read', screenshot: true }] }, h.context);
      expect(h.screenshotKeys).toEqual(['step-0-screenshot']);
    });

    test('extraction evidence must come from the page the data was extracted from', async () => {
      const h = harness({
        semantic_extract: () => ({
          url: 'https://example.com/a',
          data: { title: 'A' },
          missing: [],
          bytes: 13,
          usage: { calls: 2, tokens: 10 },
        }),
        extract: () => ({ ...article, url: 'https://example.com/b' }),
      });
      const output = await run(
        {
          steps: [
            {
              kind: 'extract',
              instruction: 'title',
              schema: {
                type: 'object',
                properties: { title: { type: 'string' } },
              },
            },
          ],
          maxStepAttempts: 1,
        },
        h.context,
      );
      expect(output.steps[0]).toMatchObject({
        status: 'failed',
        error: { code: 'EXTRACT_PAGE_CHANGED' },
      });
      expect(h.extractions).toEqual([]);
    });

    test('a started-but-unfinished click blocks resume', () => {
      expect(
        resumeBlocked([{ index: 1, kind: 'click', status: 'started' }]),
      ).toBe(true);
    });
  });
  describe('Phase 5 approval-gated submit', () => {
    const PAGE = 'a'.repeat(64);
    const target = { kind: 'role', role: 'button', name: 'Send' } as const;
    const fingerprint = (pageHash = PAGE) => ({
      pageHash,
      pageUrl: 'https://example.com/form',
      summary: {
        pageUrl: 'https://example.com/form',
        element: { tag: 'button', type: 'submit', name: '', text: 'Send' },
        form: {
          action: 'https://example.com/send',
          method: 'POST',
          fields: [{ name: 'message', type: 'text' }],
        },
        href: null,
      },
    });
    const request = (description = 'Send the support message') => ({
      steps: [
        { kind: 'navigate', url: 'https://example.com/form' },
        { kind: 'submit', target, description },
      ],
    });
    // Runs once to obtain the pending approval and its payload hash.
    const pending = async (h: ReturnType<typeof harness>) => {
      const output = await run(request(), h.context);
      return { output, approval: h.approvals.get(1)! };
    };

    test('without an approval the run pauses, requests one and never activates', async () => {
      const h = harness({ fingerprint: () => fingerprint() });
      const { output, approval } = await pending(h);
      expect(output.status).toBe('AWAITING_APPROVAL');
      expect(output.approval).toMatchObject({ id: 'approval-1', step: 1 });
      expect(output.warnings).toContain('APPROVAL_PENDING');
      expect(h.calls.map((c) => c.kind)).toEqual(['open', 'fingerprint']);
      expect(h.approvalCalls).toEqual(['request:1']);
      expect(approval.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      // The intent record is closed by the pause, so the pause is not an uncertain outcome.
      const submit = h.records.filter((r) => r.step.kind === 'submit');
      expect(submit.map((r) => r.step.status)).toEqual([
        'started',
        'awaiting_approval',
      ]);
      expect(
        uncertainSteps(
          h.records.map((r) => ({
            index: r.step.index,
            kind: r.step.kind,
            status: r.step.status,
            attemptId: r.step.attemptId,
          })),
        ),
      ).toEqual([]);
    });

    test('a still-pending approval pauses again without a second request', async () => {
      const h = harness({ fingerprint: () => fingerprint() });
      await pending(h);
      const again = await run(request(), h.context);
      expect(again.status).toBe('AWAITING_APPROVAL');
      expect(h.approvalCalls).toEqual(['request:1']);
    });

    test('an approved action is consumed, authorized and executed exactly once', async () => {
      const h = harness({
        fingerprint: () => fingerprint(),
        approved_activate: () => ({ url: 'https://example.com/sent' }),
      });
      const { approval } = await pending(h);
      approval.status = 'APPROVED';
      const output = await run(request(), h.context);
      expect(output.status).toBe('COMPLETED');
      expect(h.calls.filter((c) => c.kind === 'approved_activate')).toEqual([
        {
          kind: 'approved_activate',
          tabId: 'tab-0',
          target,
          step: 1,
          pageHash: PAGE,
        },
      ]);
      expect(h.approvalCalls).toEqual([
        'request:1',
        'consume:1',
        'authorize:1:aaaa',
        'outcome:SUCCEEDED',
      ]);
      expect(output.steps[1].result).toMatchObject({
        approvalId: 'approval-1',
      });
      // A retry finds the approval consumed: never a fresh authorization.
      const retry = await run(request(), h.context);
      expect(retry.steps[1]).toMatchObject({
        status: 'failed',
        error: { code: 'APPROVAL_ALREADY_CONSUMED' },
      });
      expect(
        h.calls.filter((c) => c.kind === 'approved_activate'),
      ).toHaveLength(1);
    });

    test.each(['REJECTED', 'EXPIRED', 'REVOKED', 'CANCELLED'])(
      'a %s approval fails the step without acting',
      async (status) => {
        const h = harness({ fingerprint: () => fingerprint() });
        const { approval } = await pending(h);
        approval.status = status;
        const output = await run(request(), h.context);
        expect(output.status).toBe('PARTIAL');
        expect(output.steps[1]).toMatchObject({
          status: 'failed',
          error: { code: 'APPROVAL_' + status },
        });
        expect(h.calls.some((c) => c.kind === 'approved_activate')).toBe(false);
      },
    );

    test('a changed action description no longer matches the approved payload', async () => {
      const h = harness({ fingerprint: () => fingerprint() });
      const { approval } = await pending(h);
      approval.status = 'APPROVED';
      const output = await run(request('Delete the account'), h.context);
      expect(output.steps[1]).toMatchObject({
        status: 'failed',
        error: { code: 'APPROVAL_PAYLOAD_CHANGED' },
      });
      expect(h.calls.some((c) => c.kind === 'approved_activate')).toBe(false);
    });

    test('a changed page state no longer matches the approved page', async () => {
      let page = PAGE;
      const h = harness({ fingerprint: () => fingerprint(page) });
      const { approval } = await pending(h);
      approval.status = 'APPROVED';
      page = 'b'.repeat(64);
      const output = await run(request(), h.context);
      expect(output.steps[1]).toMatchObject({
        status: 'failed',
        error: { code: 'APPROVAL_PAGE_CHANGED' },
      });
      expect(h.calls.some((c) => c.kind === 'approved_activate')).toBe(false);
    });

    test('a failure after activation began is an unknown outcome and is never retried', async () => {
      const h = harness({
        fingerprint: () => fingerprint(),
        approved_activate: () => {
          throw new BrowserError(
            'APPROVED_ACTION_UNCERTAIN',
            'unknown',
            502,
            true,
          );
        },
      });
      const { approval } = await pending(h);
      approval.status = 'APPROVED';
      const output = await run({ ...request(), maxStepAttempts: 3 }, h.context);
      expect(output.steps[1]).toMatchObject({
        status: 'failed',
        error: { code: 'APPROVED_ACTION_UNCERTAIN' },
      });
      expect(
        h.calls.filter((c) => c.kind === 'approved_activate'),
      ).toHaveLength(1);
      expect(h.approvalCalls).toContain(
        'outcome:UNKNOWN:APPROVED_ACTION_UNCERTAIN',
      );
    });

    test('a refusal before the click is recorded as a failed outcome', async () => {
      const h = harness({
        fingerprint: () => fingerprint(),
        approved_activate: () => {
          throw new PolicyError('APPROVAL_PAGE_CHANGED', 'changed');
        },
      });
      const { approval } = await pending(h);
      approval.status = 'APPROVED';
      await run(request(), h.context);
      expect(h.approvalCalls).toContain('outcome:FAILED:APPROVAL_PAGE_CHANGED');
    });

    test('validation: one submit per run, with a target and a description', () => {
      expect(() =>
        steps({ steps: [{ kind: 'submit', target, description: 'x' }] }),
      ).not.toThrow();
      expect(() =>
        steps({
          steps: [
            { kind: 'submit', target, description: 'a' },
            { kind: 'submit', target, description: 'b' },
          ],
        }),
      ).toThrow();
      expect(() => steps({ steps: [{ kind: 'submit', target }] })).toThrow();
    });

    test('resume rules: uncertain outcomes always block; a clean approval pause does not', () => {
      const paused = [
        { index: 0, kind: 'click', status: 'started', attemptId: 'a' },
        { index: 0, kind: 'click', status: 'success', attemptId: 'a' },
        { index: 1, kind: 'submit', status: 'started', attemptId: 'a' },
        {
          index: 1,
          kind: 'submit',
          status: 'awaiting_approval',
          attemptId: 'a',
        },
      ];
      expect(uncertainSteps(paused)).toEqual([]);
      // Without an approval resume, the earlier click still blocks as in Phase 4.
      expect(resumeBlocked(paused)).toBe(true);
      expect(resumeBlocked(paused, true)).toBe(false);
      // The approved attempt crashed after recording its intent: unknown, blocked.
      const crashed = [
        ...paused,
        { index: 1, kind: 'submit', status: 'started', attemptId: 'b' },
      ];
      expect(uncertainSteps(crashed)).toEqual([crashed[4]]);
      expect(resumeBlocked(crashed, true)).toBe(true);
      // A submit that already succeeded is never repeated.
      expect(
        resumeBlocked(
          [
            ...paused,
            { index: 1, kind: 'submit', status: 'started', attemptId: 'b' },
            { index: 1, kind: 'submit', status: 'success', attemptId: 'b' },
          ],
          true,
        ),
      ).toBe(true);
    });
  });
});
