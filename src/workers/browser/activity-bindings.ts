import { Context, ApplicationFailure } from '@temporalio/activity';
import {
  BrowserExecutionService,
  type BrowserJob,
} from '../../browser/browser-execution.service';
import { ServiceError } from '../../common/errors/service.error';
import { BROWSER_MAX_ATTEMPTS } from '../../temporal/task-queues';

type Output = {
  status?: string;
  warnings?: string[];
  steps?: {
    index: number;
    kind: string;
    status: string;
    attempts?: number;
    error?: { code?: string } | null;
    result?: { extractionId?: string; evidenceId?: string } | null;
  }[];
  evidence?: { evidenceId?: string; id?: string; url?: string }[];
  extractions?: { id: string }[];
  approval?: { id: string; expiresAt: string; step: number };
};
/**
 * The workflow result references what PostgreSQL holds instead of copying it: page text
 * and extracted data stay out of Temporal history (payload limits, data duplication).
 */
export function summarize(runId: string, output: unknown) {
  const o = (output || {}) as Output;
  return {
    runId,
    status: o.status ?? null,
    steps: (o.steps || []).map((step) => ({
      index: step.index,
      kind: step.kind,
      status: step.status,
      attempts: step.attempts ?? null,
      error: step.error?.code ?? null,
    })),
    evidenceUrls: (o.evidence || []).map((item) => item.url).filter(Boolean),
    extractionIds: [
      ...(o.steps || []).map((step) => step.result?.extractionId),
      ...(o.extractions || []).map((item) => item.id),
    ].filter(Boolean),
    warnings: o.warnings || [],
    // While waiting: which approval the run needs, and until when (no action content).
    approval: o.approval
      ? {
          id: o.approval.id,
          expiresAt: o.approval.expiresAt,
          step: o.approval.step,
        }
      : null,
  };
}
/**
 * The worker often sees a cancellation in the database before Temporal's cancel request
 * reaches the activity (heartbeat responses are throttled). The API cancel also cancels the
 * workflow, so wait for that request and rethrow it: the activity then ends cancelled and the
 * workflow CANCELED, not FAILED. Without a request (a database-only cancel), give up after
 * CANCELLATION_WAIT_MS and fail the activity as before.
 */
const CANCELLATION_WAIT_MS = 30000;
async function reportCancellation(context: ActivityContext) {
  const ticker = setInterval(() => context.heartbeat(), 1000);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      context.cancelled,
      new Promise((resolve) => {
        timer = setTimeout(resolve, CANCELLATION_WAIT_MS);
      }),
    ]);
  } finally {
    clearInterval(ticker);
    clearTimeout(timer);
  }
}
// The parts of the Temporal activity context the browser task uses.
export type ActivityContext = Pick<
  Context,
  'cancellationSignal' | 'cancellationDetails' | 'cancelled' | 'heartbeat'
> & { info: { attempt: number } };
export async function runBrowserTask(
  service: BrowserExecutionService,
  job: BrowserJob,
  context: ActivityContext,
) {
  const timer = setInterval(() => context.heartbeat(), 5000);
  // Temporal also cancels in-flight activities when this worker shuts down. That is not a
  // cancellation of the run: it only ends this attempt (see BrowserExecutionService).
  const cancel = new AbortController();
  const stop = new AbortController();
  const split = () =>
    (context.cancellationDetails?.workerShutdown ? stop : cancel).abort();
  if (context.cancellationSignal.aborted) split();
  else
    context.cancellationSignal.addEventListener('abort', split, { once: true });
  const attempt = context.info.attempt;
  try {
    return summarize(
      job.runId,
      await service.execute(
        job,
        cancel.signal,
        () => context.heartbeat(),
        { attempt, final: attempt >= BROWSER_MAX_ATTEMPTS },
        stop.signal,
      ),
    );
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'CANCELLED')
      await reportCancellation(context);
    throw ApplicationFailure.create({
      // ServiceError messages are written to be safe to show; anything else is not.
      message:
        error instanceof ServiceError
          ? error.message
          : 'Browser execution failed',
      type: error instanceof ServiceError ? error.code : 'BROWSER_FAILED',
      // Infrastructure failures (launch, attach, model outage, storage) may succeed on retry.
      nonRetryable: !(error instanceof ServiceError && error.retryable),
    });
  } finally {
    clearInterval(timer);
    context.cancellationSignal.removeEventListener('abort', split);
  }
}
export function browserActivities(service: BrowserExecutionService) {
  return {
    executeBrowserTask: (job: BrowserJob) =>
      runBrowserTask(service, job, Context.current()),
  };
}
