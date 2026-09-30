export type Capability = 'search' | 'browser' | 'research';
export interface ExecutionContext {
  tenantId: string;
  userId: string;
  projectId: string;
  requestId: string;
  capabilities: Capability[];
}
