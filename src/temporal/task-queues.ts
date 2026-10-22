export interface WorkflowJob {
  runId: string;
  tenantId: string;
  projectId: string;
}
// Browser activity attempts: retries cover infrastructure failures (launch, attach,
// model outages); step-level effects are guarded by the runner's resume rules.
export const BROWSER_MAX_ATTEMPTS = 3;
export const TERMINAL_STATUSES = [
  'COMPLETED',
  'PARTIAL',
  'NO_RESULTS',
  'FAILED',
  'CANCELLED',
];
