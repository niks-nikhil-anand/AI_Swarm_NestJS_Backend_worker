import type { Browser, BrowserContext, Page } from 'playwright';
import type { ExecutionContext } from '../../common/types/execution-context';
export interface BrowserSession {
  id: string;
  owner: ExecutionContext;
  browser: Browser;
  context: BrowserContext;
  tabs: Map<string, Page>;
  startedAt: number;
  actions: number;
  closeProxy: () => Promise<void>;
  closed: boolean;
}
