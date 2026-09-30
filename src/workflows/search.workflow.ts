import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowJob } from '../temporal/task-queues';
export async function searchWorkflow(
  job: WorkflowJob & { searchQueue: string },
) {
  const activities = proxyActivities<{
    executeSearch(input: WorkflowJob): Promise<unknown>;
  }>({
    taskQueue: job.searchQueue,
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '20 seconds',
    retry: { maximumAttempts: 3, initialInterval: '2 seconds' },
  });
  return activities.executeSearch(job);
}
