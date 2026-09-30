import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowJob } from '../temporal/task-queues';
export async function browserWorkflow(
  job: WorkflowJob & { browserQueue: string },
) {
  const browser = proxyActivities<{
    executeBrowserTask(input: WorkflowJob): Promise<unknown>;
  }>({
    taskQueue: job.browserQueue,
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '20 seconds',
    retry: { maximumAttempts: 1 },
  });
  return browser.executeBrowserTask(job);
}
