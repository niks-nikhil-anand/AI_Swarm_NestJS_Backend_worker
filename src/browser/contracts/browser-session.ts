import type { BrowserContext, Page, Request } from 'playwright';
import type { ExecutionContext } from '../../common/types/execution-context';
import type { ChromiumConnection } from '../chromium/chromium.connection';
import type { StagehandAdapter } from '../adapters/stagehand/stagehand.adapter';
import type { WorkerEgressGuard } from '../policies/worker-egress-guard';
// Ownership: the session owns its egress proxy and ChromiumConnection (process, profile,
// context, pages). The optional Stagehand adapter only borrows that browser.
export interface BrowserSession {
  id: string;
  owner: ExecutionContext;
  connection: ChromiumConnection;
  context: BrowserContext;
  stagehand?: StagehandAdapter;
  // Request policy for extension/worker targets; present whenever Stagehand is enabled.
  workerGuard?: WorkerEgressGuard;
  tabs: Map<string, Page>;
  startedAt: number;
  actions: number;
  closeProxy: () => Promise<void>;
  closed: boolean;
  // The page request policy (allowlisted domain; GET/HEAD, or the one approved write,
  // which needs the request itself to prove it is that page's top-level navigation).
  allows: (url: string, method: string, request?: Request) => boolean;
  // One non-GET request for an approved, consumed consequential action (Phase 5), usable
  // only by `page`'s own main-frame navigation.
  writeAllowance?: {
    method: string;
    url: string;
    remaining: number;
    expiresAt: number;
    page: Page;
  };
  // Set only by the execution service after it consumed an approval; single use.
  approvedAction?: { step: number; pageHash: string };
}
