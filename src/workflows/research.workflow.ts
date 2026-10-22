import {
  ActivityCancellationType,
  proxyActivities,
} from '@temporalio/workflow';
import {
  BROWSER_MAX_ATTEMPTS,
  type WorkflowJob,
} from '../temporal/task-queues';
type Discovery = {
  status: string;
  candidates: { id: string; url: string }[];
  warnings: string[];
};
export async function researchWorkflow(
  job: WorkflowJob & { searchQueue: string; browserQueue: string },
) {
  const search = proxyActivities<{
    executeSearch(input: WorkflowJob): Promise<Discovery>;
    finishDiscovery(
      input: WorkflowJob,
      status: 'FAILED' | 'NO_RESULTS',
      output: Discovery,
    ): Promise<void>;
  }>({
    taskQueue: job.searchQueue,
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '20 seconds',
    retry: { maximumAttempts: 3 },
  });
  const discovered = await search.executeSearch(job);
  if (!discovered) return discovered;
  if (!discovered.candidates?.length) {
    await search.finishDiscovery(
      job,
      discovered.status === 'FAILED' ? 'FAILED' : 'NO_RESULTS',
      discovered,
    );
    return discovered;
  }
  const browser = proxyActivities<{
    executeBrowserTask(
      input: WorkflowJob & { candidates: { id: string; url: string }[] },
    ): Promise<unknown>;
  }>({
    taskQueue: job.browserQueue,
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '20 seconds',
    // Cancellation completes only after the activity closed its browser and released
    // the run lease.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: BROWSER_MAX_ATTEMPTS,
      initialInterval: '5 seconds',
      backoffCoefficient: 2,
    },
  });
  return browser.executeBrowserTask({
    ...job,
    candidates: discovered.candidates,
  });
}
