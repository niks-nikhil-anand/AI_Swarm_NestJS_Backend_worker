import {
  ActivityCancellationType,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import {
  BROWSER_MAX_ATTEMPTS,
  type WorkflowJob,
} from '../temporal/task-queues';

// Sent by the API after an approval decision (and re-sent by the dispatcher).
export const approvalDecided = defineSignal('approvalDecided');
// Grace after expiry, so the activity sees the approval as expired and ends the run.
const EXPIRY_GRACE_MS = 5000;
// Bounds wakeups that find the approval still pending (duplicate or early signals).
const MAX_APPROVAL_ROUNDS = 20;

type Summary = {
  status?: string | null;
  approval?: { id: string; expiresAt: string } | null;
};

export async function browserWorkflow(
  job: WorkflowJob & { browserQueue: string },
) {
  const browser = proxyActivities<{
    executeBrowserTask(input: WorkflowJob): Promise<Summary>;
  }>({
    taskQueue: job.browserQueue,
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '20 seconds',
    // Cancellation completes only after the activity closed its browser and released
    // the run lease.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    // Only failures the activity marks retryable are retried (see activity-bindings).
    retry: {
      maximumAttempts: BROWSER_MAX_ATTEMPTS,
      initialInterval: '5 seconds',
      backoffCoefficient: 2,
    },
  });
  let decided = false;
  setHandler(approvalDecided, () => {
    decided = true;
  });
  let result = await browser.executeBrowserTask(job);
  // Waiting for approval holds no browser session or lease: the activity has returned,
  // and a later activity reopens the page and revalidates it before acting.
  for (
    let round = 0;
    round < MAX_APPROVAL_ROUNDS &&
    result?.status === 'AWAITING_APPROVAL' &&
    result.approval;
    round++
  ) {
    decided = false;
    const remaining = Date.parse(result.approval.expiresAt) - Date.now();
    await condition(() => decided, Math.max(remaining, 0) + EXPIRY_GRACE_MS);
    result = await browser.executeBrowserTask(job);
  }
  return result;
}
