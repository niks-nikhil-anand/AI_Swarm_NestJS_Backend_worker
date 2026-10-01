export type Capability = 'search' | 'browser' | 'research' | 'users';
export interface ExecutionContext {
  tenantId: string;
  userId: string;
  projectId: string;
  requestId: string;
  capabilities: Capability[];
}
