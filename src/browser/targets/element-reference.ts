import type { Locator } from 'playwright';
export interface ElementReference {
  id: string;
  sessionId: string;
  tabId: string;
  revision: string;
  locator: Locator;
}
