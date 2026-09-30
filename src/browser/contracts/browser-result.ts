export interface BrowserResult<T = unknown> {
  actionId: string;
  status: 'success' | 'failed';
  tabId?: string;
  url?: string;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  durationMs: number;
}
