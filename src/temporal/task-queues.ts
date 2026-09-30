export interface WorkflowJob {
  runId: string;
  tenantId: string;
  projectId: string;
}
export const TERMINAL_STATUSES = [
  'COMPLETED',
  'PARTIAL',
  'NO_RESULTS',
  'FAILED',
  'CANCELLED',
];
