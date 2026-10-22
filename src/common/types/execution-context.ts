// approve: may decide approvals of consequential browser actions (Phase 5).
export type Capability =
  'search' | 'browser' | 'research' | 'users' | 'approve';
export interface ExecutionContext {
  tenantId: string;
  userId: string;
  projectId: string;
  requestId: string;
  capabilities: Capability[];
}
