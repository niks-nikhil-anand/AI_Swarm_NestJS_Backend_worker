import type { BrowserAction } from './contracts/browser-action';
import type { BrowserSession } from './contracts/browser-session';
import {
  REPLAYABLE_STEPS,
  type BrowserStep,
  type BrowserStepsRequest,
} from './contracts/browser-step';
import { ArticleSchema } from './adapters/playwright/playwright.adapter';
import { BrowserError } from '../common/errors/browser.errors';
import { ServiceError } from '../common/errors/service.error';
import type { Extraction } from '../persistence/run.repository';
import { schemaHash } from './extraction/extraction-schema';
import { createHash } from 'node:crypto';
import { PolicyError } from '../common/errors/policy.errors';
import type { Fingerprint } from './tools/browser-consequential.tool';

export const ATTEMPT_ABORTS = ['PERSISTENCE_UNAVAILABLE', 'LEASE_LOST'];
export interface StepRecord {
  index: number;
  kind: BrowserStep['kind'];
  // 'started' is written before a non-replayable step runs (see runBrowserSteps);
  // 'awaiting_approval' closes a submit step whose approval is not yet decided.
  status: 'started' | 'success' | 'failed' | 'awaiting_approval';
  runAttempt: number;
  // Execution lease owner: unique per attempt, also across separate activity invocations.
  attemptId?: string;
  attempts: number;
  durationMs: number;
  url?: string;
  error?: { code: string; message: string; retryable: boolean };
  result?: unknown;
}
export interface PriorStep {
  index: number;
  kind: string;
  status: string;
  attemptId?: string;
}
// Approval as the runner sees it (see ApprovalRepository for the full record).
export interface StepApproval {
  id: string;
  status: string;
  expiresAt: string;
  payloadHash: string;
}
/**
 * Approval operations available to the runner. The runner can request, consume and
 * record outcomes; it can never decide an approval.
 */
export interface StepApprovals {
  forStep(step: number): Promise<StepApproval | undefined>;
  request(
    step: number,
    proposal: {
      action: Record<string, unknown>;
      payloadHash: string;
      pageHash: string;
      pageUrl: string;
    },
  ): Promise<StepApproval>;
  // Atomic single use; throws a typed error naming why the approval cannot be used.
  consume(
    step: number,
    id: string,
    payloadHash: string,
    pageHash: string,
  ): Promise<void>;
  // Hands the session its single-use authorization for this step and page state.
  authorize(step: number, pageHash: string): void;
  outcome(
    id: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
    detail?: string,
  ): Promise<void>;
}
export interface StepRunContext {
  session: BrowserSession;
  runAttempt: number;
  runId: string;
  attemptId: string;
  approvals: StepApprovals;
  // Executes one internal action through BrowserService (policy, budget, recording).
  execute(action: BrowserAction): Promise<unknown>;
  record(step: StepRecord, input: Record<string, unknown>): Promise<void>;
  saveEvidence(url: string, item: Record<string, unknown>): Promise<string>;
  // Evidence and extraction in one transaction.
  saveSourcedExtraction(
    url: string,
    item: Record<string, unknown>,
    extraction: Omit<Extraction, 'evidenceId'>,
  ): Promise<{ evidenceId: string; extractionId: string }>;
  saveScreenshot(bytes: Buffer, idempotencyKey: string): Promise<string>;
  cancelled(): boolean;
}
export interface StepRunOutput {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'AWAITING_APPROVAL';
  steps: StepRecord[];
  evidence: Record<string, unknown>[];
  warnings: string[];
  // Set while waiting: the approval the run needs before it can continue.
  approval?: StepApproval & { step: number };
}
// Ends the attempt cleanly at a submit step whose approval is not decided yet.
class AwaitingApproval extends Error {
  constructor(readonly approval: StepApproval) {
    super('Awaiting approval');
  }
}
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const failure = (error: unknown) =>
  error instanceof ServiceError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : {
        code: 'STEP_FAILED',
        message: 'Browser step failed',
        retryable: false,
      };
// Typed text is not copied into the action log; its length is enough to audit.
const loggedInput = (step: BrowserStep): Record<string, unknown> =>
  step.kind === 'type'
    ? { ...step, text: undefined, textLength: step.text.length }
    : { ...step };

/**
 * Steps whose outcome is unknown: an attempt recorded the intent ('started') but no
 * result for the same step. These are never replayed.
 */
export function uncertainSteps(prior: PriorStep[]) {
  const closed = new Set(
    prior
      .filter((step) => step.status !== 'started')
      .map((step) => step.index + '|' + (step.attemptId ?? '')),
  );
  return prior.filter(
    (step) =>
      step.status === 'started' &&
      !closed.has(step.index + '|' + (step.attemptId ?? '')),
  );
}
/**
 * Whether a later attempt must not resume. An uncertain outcome always blocks. After a
 * clean approval pause, earlier steps with known outcomes are replayed to rebuild the
 * page (the approval then re-checks the page state); otherwise, as before, any
 * non-replayable step attempted earlier blocks.
 */
export function resumeBlocked(prior: PriorStep[], approvalResume = false) {
  if (uncertainSteps(prior).length) return true;
  if (approvalResume)
    return prior.some(
      (step) => step.kind === 'submit' && step.status === 'success',
    );
  return prior.some(
    (step) => !REPLAYABLE_STEPS.has(step.kind as BrowserStep['kind']),
  );
}
// A step is retried in-session only when repeating it cannot duplicate an effect.
export function retryable(step: BrowserStep, error: unknown) {
  if (!(error instanceof ServiceError) || !error.retryable) return false;
  return REPLAYABLE_STEPS.has(step.kind) || error.code.startsWith('MODEL_');
}

export async function runBrowserSteps(
  request: BrowserStepsRequest,
  context: StepRunContext,
): Promise<StepRunOutput> {
  const { session } = context;
  let tabId = [...session.tabs.keys()][0];
  const steps: StepRecord[] = [];
  const evidence: Record<string, unknown>[] = [];
  const warnings: string[] = [];

  const perform = async (step: BrowserStep, index: number) => {
    const tab = () => {
      if (!tabId || !session.tabs.has(tabId))
        throw new BrowserError('TAB_NOT_FOUND', 'Current tab is closed', 409);
      return tabId;
    };
    switch (step.kind) {
      case 'navigate':
        return context.execute({ kind: 'open', tabId: tab(), url: step.url });
      case 'inspect': {
        const observed = (await context.execute({
          kind: 'observe',
          tabId: tab(),
        })) as { url: string; title: string; elements: { label: string }[] };
        // Element reference ids are session-internal; labels describe the page.
        return {
          url: observed.url,
          title: observed.title,
          elements: observed.elements.map((element) => element.label),
        };
      }
      case 'read': {
        const article = ArticleSchema.parse(
          await context.execute({
            kind: 'extract',
            tabId: tab(),
            schemaId: 'article',
          }),
        );
        if (!article.text.trim())
          throw new BrowserError(
            'EMPTY_EVIDENCE',
            'Page has no readable evidence',
          );
        let artifactId: string | undefined;
        if (step.screenshot) {
          const bytes = await context.execute({
            kind: 'screenshot',
            tabId: tab(),
          });
          if (!Buffer.isBuffer(bytes))
            throw new BrowserError(
              'SCREENSHOT_FAILED',
              'Invalid screenshot result',
            );
          artifactId = await context.saveScreenshot(
            bytes,
            'step-' + index + '-screenshot',
          );
        }
        const item = {
          ...article,
          retrievedAt: new Date().toISOString(),
          schemaId: 'article',
          extraction: 'deterministic-dom',
          verification: 'captured-source-text',
          step: index,
          artifactId,
        };
        await context.saveEvidence(article.url, item);
        evidence.push(item);
        return {
          url: article.url,
          title: article.title,
          characters: article.text.length,
        };
      }
      case 'click':
        return context.execute({
          kind: 'click',
          tabId: tab(),
          target: step.target,
        });
      case 'type':
        return context.execute({
          kind: 'type',
          tabId: tab(),
          target: step.target,
          text: step.text,
          mode: step.mode,
        });
      case 'scroll':
        return context.execute({
          kind: 'scroll',
          tabId: tab(),
          pixels: step.pixels,
        });
      case 'wait_for':
        return context.execute({
          kind: 'wait_for',
          tabId: tab(),
          target: step.target,
          state: step.state,
          timeoutMs: step.timeoutMs,
        });
      case 'go_back':
        return context.execute({ kind: 'go_back', tabId: tab() });
      case 'new_tab': {
        // Opened through Playwright; Stagehand's own newPage() is not used.
        const before = new Set(session.tabs.keys());
        await context.execute({ kind: 'new_tab' });
        const opened = [...session.tabs.keys()].find((id) => !before.has(id));
        if (!opened)
          throw new BrowserError('TAB_LIMIT', 'Tab budget exceeded', 409);
        tabId = opened;
        if (step.url)
          return context.execute({ kind: 'open', tabId, url: step.url });
        return { tab: [...session.tabs.keys()].indexOf(opened) };
      }
      case 'switch_tab': {
        const target = [...session.tabs.keys()][step.index];
        if (!target)
          throw new BrowserError('TAB_NOT_FOUND', 'No tab at that index', 404);
        tabId = target;
        return { tab: step.index, url: session.tabs.get(target)!.url() };
      }
      case 'observe':
        return context.execute({
          kind: 'semantic_observe',
          tabId: tab(),
          instruction: step.instruction,
        });
      case 'act':
        return context.execute({
          kind: 'semantic_act',
          tabId: tab(),
          instruction: step.instruction,
        });
      case 'submit': {
        const fingerprint = (await context.execute({
          kind: 'fingerprint',
          tabId: tab(),
          target: step.target,
        })) as Fingerprint;
        // Binds the approval to this run, step, caller description and the reviewed target.
        const payloadHash = sha256(
          JSON.stringify({
            run: context.runId,
            step: index,
            kind: 'submit',
            target: step.target,
            description: step.description,
            page: fingerprint.summary,
          }),
        );
        const existing = await context.approvals.forStep(index);
        if (!existing || existing.status === 'PENDING')
          throw new AwaitingApproval(
            existing ??
              (await context.approvals.request(index, {
                action: {
                  kind: 'submit',
                  description: step.description,
                  target: step.target,
                  ...fingerprint.summary,
                },
                payloadHash,
                pageHash: fingerprint.pageHash,
                pageUrl: fingerprint.pageUrl,
              })),
          );
        if (existing.status !== 'APPROVED')
          throw new PolicyError(
            existing.status === 'CONSUMED'
              ? 'APPROVAL_ALREADY_CONSUMED'
              : 'APPROVAL_' + existing.status,
            'The approval for this step is ' + existing.status.toLowerCase(),
          );
        // Consumed before acting: a retry finds it used and never treats itself as authorized.
        await context.approvals.consume(
          index,
          existing.id,
          payloadHash,
          fingerprint.pageHash,
        );
        context.approvals.authorize(index, fingerprint.pageHash);
        try {
          const done = (await context.execute({
            kind: 'approved_activate',
            tabId: tab(),
            target: step.target,
            step: index,
            pageHash: fingerprint.pageHash,
          })) as { url: string; status?: number };
          await context.approvals.outcome(
            existing.id,
            'SUCCEEDED',
            done.status ? 'HTTP ' + done.status : undefined,
          );
          return { ...done, approvalId: existing.id };
        } catch (error) {
          const code =
            error instanceof ServiceError ? error.code : 'STEP_FAILED';
          // Known not to have taken effect (refused before the click, the request never
          // sent, or refused by the server): FAILED. Anything else may have: UNKNOWN.
          const known = [
            'APPROVAL_PAGE_CHANGED',
            'APPROVAL_REQUIRED',
            'AMBIGUOUS_TARGET',
            'CONSEQUENTIAL_TARGET_UNSUPPORTED',
            // The allowance was withdrawn unused, or the server answered 4xx.
            'APPROVED_REQUEST_NOT_SENT',
            'APPROVED_REQUEST_REJECTED',
          ];
          await context.approvals
            .outcome(
              existing.id,
              known.includes(code) ? 'FAILED' : 'UNKNOWN',
              code,
            )
            .catch(() => undefined);
          throw error;
        }
      }
      case 'extract': {
        const extracted = (await context.execute({
          kind: 'semantic_extract',
          tabId: tab(),
          instruction: step.instruction,
          schema: step.schema,
          ...(step.scope ? { scope: step.scope } : {}),
        })) as {
          url: string;
          data: unknown;
          missing: string[];
          bytes: number;
          usage: { calls: number; tokens: number };
        };
        // Source evidence: the deterministic text of the page the data came from.
        const source = ArticleSchema.parse(
          await context.execute({
            kind: 'extract',
            tabId: tab(),
            schemaId: 'article',
          }),
        );
        const retrievedAt = new Date().toISOString();
        const item = {
          ...source,
          retrievedAt,
          schemaId: 'article',
          extraction: 'deterministic-dom',
          verification: 'captured-source-text',
          purpose: 'extraction-source',
          step: index,
        };
        // The evidence must be the page the data came from, in this run.
        if (source.url !== extracted.url)
          throw new BrowserError(
            'EXTRACT_PAGE_CHANGED',
            'The page changed between extraction and evidence capture',
            409,
          );
        const { evidenceId, extractionId } =
          await context.saveSourcedExtraction(source.url, item, {
            step: index,
            url: extracted.url,
            instruction: step.instruction,
            schemaHash: schemaHash(step.schema),
            schema: step.schema,
            data: extracted.data,
            missing: extracted.missing,
            modelCalls: extracted.usage.calls,
            modelTokens: extracted.usage.tokens,
            retrievedAt,
          });
        evidence.push({ ...item, evidenceId });
        return {
          extractionId,
          evidenceId,
          url: extracted.url,
          retrievedAt,
          data: extracted.data,
          missing: extracted.missing,
          bytes: extracted.bytes,
          usage: extracted.usage,
        };
      }
    }
  };

  for (const [index, step] of request.steps.entries()) {
    const started = Date.now();
    let attempts = 0;
    // Intent first: if this record cannot be written the step does not run, and if the
    // step runs, a later attempt sees it and will not replay it.
    if (!REPLAYABLE_STEPS.has(step.kind))
      await context.record(
        {
          index,
          kind: step.kind,
          status: 'started',
          runAttempt: context.runAttempt,
          attemptId: context.attemptId,
          attempts: 0,
          durationMs: 0,
        },
        loggedInput(step),
      );
    for (;;) {
      attempts++;
      if (context.cancelled())
        throw new BrowserError('CANCELLED', 'Run cancelled', 409);
      try {
        const result = await perform(step, index);
        const page = tabId ? session.tabs.get(tabId) : undefined;
        const record: StepRecord = {
          index,
          kind: step.kind,
          status: 'success',
          runAttempt: context.runAttempt,
          attemptId: context.attemptId,
          attempts,
          durationMs: Date.now() - started,
          url: page && !page.isClosed() ? page.url() : undefined,
          result,
        };
        steps.push(record);
        await context.record(record, loggedInput(step));
        break;
      } catch (error) {
        // Clean pause: close the step's intent and hand the run to the approval workflow.
        if (error instanceof AwaitingApproval) {
          const record: StepRecord = {
            index,
            kind: step.kind,
            status: 'awaiting_approval',
            runAttempt: context.runAttempt,
            attemptId: context.attemptId,
            attempts,
            durationMs: Date.now() - started,
            result: {
              approvalId: error.approval.id,
              expiresAt: error.approval.expiresAt,
            },
          };
          steps.push(record);
          await context.record(record, loggedInput(step));
          return {
            status: 'AWAITING_APPROVAL',
            steps,
            evidence,
            warnings: [...warnings, 'APPROVAL_PENDING'],
            approval: { ...error.approval, step: index },
          };
        }
        // A failure caused by cancellation (closed session) is a cancellation, not a step error.
        if (
          context.cancelled() ||
          (error instanceof BrowserError && error.code === 'CANCELLED')
        )
          throw new BrowserError('CANCELLED', 'Run cancelled', 409);
        // Storage outages and a lost lease end the attempt; they are not step outcomes.
        if (
          error instanceof ServiceError &&
          ATTEMPT_ABORTS.includes(error.code)
        )
          throw error;
        if (attempts < request.maxStepAttempts && retryable(step, error))
          continue;
        const record: StepRecord = {
          index,
          kind: step.kind,
          status: 'failed',
          runAttempt: context.runAttempt,
          attemptId: context.attemptId,
          attempts,
          durationMs: Date.now() - started,
          error: failure(error),
        };
        steps.push(record);
        await context.record(record, loggedInput(step));
        warnings.push('STEP_' + index + '_' + record.error!.code);
        // Later steps depend on this one's page state, so the run stops here.
        return {
          status: steps.length > 1 ? 'PARTIAL' : 'FAILED',
          steps,
          evidence,
          warnings,
        };
      }
    }
  }
  return { status: 'COMPLETED', steps, evidence, warnings };
}
