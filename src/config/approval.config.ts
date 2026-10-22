import { bounded, flag } from './browser.config';

// Approvals of consequential browser actions (Phase 5). The TTL is bounded by the 30 min
// workflow execution timeout: a decision and its execution must fit inside one workflow.
export function approvalConfiguration(env: NodeJS.ProcessEnv) {
  return {
    ttlMs: bounded(env, 'APPROVAL_TTL_MS', 600000, 60000, 1200000),
    // Separation of duties: the user who submitted the run cannot approve its actions.
    distinctApprover: flag(env, 'APPROVAL_REQUIRE_DISTINCT_APPROVER', true),
  };
}
export type ApprovalConfiguration = ReturnType<typeof approvalConfiguration>;
