import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '../../common/types/execution-context';
import { ConfigurationService } from '../../config/configuration';
import { ChromiumService } from '../chromium/chromium.service';
import { DomainPolicyService } from '../policies/domain-policy.service';
import { NetworkPolicyService } from '../policies/network-policy.service';
import { CapabilityPolicyService } from '../policies/capability-policy.service';
import { createEgressProxy } from '../policies/egress-proxy';
import type { BrowserSession } from '../contracts/browser-session';
import { BrowserError } from '../../common/errors/browser.errors';
import type { ChromiumConnection } from '../chromium/chromium.connection';
import { StagehandConnector } from '../adapters/stagehand/stagehand.connector';
import { TargetRegistryService } from '../targets/target-registry.service';
import type { APIResponse, Page, Request } from 'playwright';
import {
  guardWorkerEgress,
  type WorkerEgressGuard,
} from '../policies/worker-egress-guard';

// The approved write gets one attempt; without an answer in time its outcome is unknown.
const WRITE_TIMEOUT_MS = 15000;

@Injectable()
export class SessionManagerService implements OnModuleDestroy {
  private readonly sessions = new Map<string, BrowserSession>();
  constructor(
    private readonly chromium: ChromiumService,
    private readonly config: ConfigurationService,
    private readonly domain: DomainPolicyService,
    private readonly network: NetworkPolicyService,
    private readonly capability: CapabilityPolicyService,
    private readonly stagehand: StagehandConnector,
    private readonly registry: TargetRegistryService,
  ) {}
  async create(owner: ExecutionContext) {
    this.capability.assert(owner);
    const proxy = await createEgressProxy(this.network);
    let connection: ChromiumConnection | undefined;
    let guard: WorkerEgressGuard | undefined;
    // One request policy for pages (Playwright routing) and extension workers (CDP Fetch).
    const allowed = (url: string, method: string) => {
      try {
        this.domain.assert(url);
        return ['GET', 'HEAD'].includes(method);
      } catch {
        return false;
      }
    };
    try {
      // A dedicated Chromium per session: no cookies, storage or pages are shared.
      connection = await this.chromium.launch(proxy.url);
      if (connection.stagehand) {
        const launched = connection;
        guard = await guardWorkerEgress(
          connection.stagehand.webSocketUrl,
          allowed,
          // Without the guard, extension requests would leave unchecked: stop the browser.
          () => void launched.close().catch(() => undefined),
          this.config.value.browser?.stagehand.connectTimeoutMs || 30000,
        );
        proxy.allowDebuggerTunnel(
          Number(new URL(connection.stagehand.webSocketUrl).port),
        );
      }
      const context = connection.context;
      context.setDefaultTimeout(
        this.config.value.browser?.actionTimeoutMs || 15000,
      );
      // Pages: the same policy, plus at most the single write of an approved, consumed
      // consequential action (exact method and action URL, unexpired, one request).
      // Extension and worker targets never receive it (the guard uses `allowed`).
      let owned: BrowserSession | undefined;
      const pageAllows = (url: string, method: string, request?: Request) =>
        allowed(url, method) || useWriteAllowance(url, method, request);
      const useWriteAllowance = (
        url: string,
        method: string,
        request?: Request,
      ) => {
        const grant = owned?.writeAllowance;
        if (!grant || !request) return false;
        try {
          this.domain.assert(url);
          // Only the approved page's own top-level form navigation: never a fetch/XHR,
          // a frame, a service worker or another tab of the session.
          if (
            !request.isNavigationRequest() ||
            request.frame() !== grant.page.mainFrame()
          )
            return false;
        } catch {
          return false;
        }
        if (
          grant.remaining < 1 ||
          Date.now() > grant.expiresAt ||
          grant.method !== method.toUpperCase() ||
          grant.url !== url.split('#')[0]
        )
          return false;
        grant.remaining--;
        return true;
      };
      await context.route('**/*', async (route) => {
        const request = route.request();
        let write: boolean;
        try {
          write = !allowed(request.url(), request.method());
          if (
            write &&
            !useWriteAllowance(request.url(), request.method(), request)
          )
            throw new Error('Denied by session request policy');
          if (!write) return await route.continue();
        } catch {
          return route.abort('blockedbyclient').catch(() => undefined);
        }
        // The approved write is sent exactly once by this process, through the same egress
        // proxy and cookie jar, and handed to the page as its response. Left to Chromium, a
        // POST on a reused connection is resent transparently after a connection reset,
        // below request interception (verified: one approved click, three POSTs).
        let response: APIResponse;
        try {
          response = await route.fetch({
            maxRetries: 0,
            maxRedirects: 0,
            timeout: WRITE_TIMEOUT_MS,
          });
        } catch {
          return route.abort('failed').catch(() => undefined);
        }
        await route.fulfill({ response }).catch(() => undefined);
      });
      await context.routeWebSocket('**/*', (route) => route.close());
      const session: BrowserSession = {
        id: randomUUID(),
        owner,
        connection,
        context,
        tabs: new Map(),
        startedAt: Date.now(),
        actions: 0,
        workerGuard: guard,
        closeProxy: proxy.close,
        closed: false,
        allows: pageAllows,
      };
      owned = session;
      const track = (page: Page) => {
        if (session.tabs.size >= (this.config.value.browser?.maxTabs || 5)) {
          void page.close();
          return;
        }
        session.tabs.set(randomUUID(), page);
        page.on('close', () => {
          for (const [id, item] of session.tabs)
            if (item === page) session.tabs.delete(id);
        });
      };
      context.on('page', track);
      // A persistent context starts with its initial about:blank tab already open.
      for (const page of context.pages()) track(page);
      await context.addInitScript(() => {
        const install = () => {
          if (!document.documentElement) return;
          (window as unknown as { __swarmRevision: number }).__swarmRevision =
            0;
          new MutationObserver(() => {
            (window as unknown as { __swarmRevision: number })
              .__swarmRevision++;
          }).observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        };
        if (document.documentElement) install();
        else
          document.addEventListener('DOMContentLoaded', install, {
            once: true,
          });
      });
      if (!session.tabs.size) await context.newPage();
      if (this.stagehand.enabled)
        session.stagehand = await this.stagehand.connect(connection);
      this.sessions.set(session.id, session);
      // A crashed or externally closed Chromium releases the session's other resources.
      connection.onDisconnect(
        () => void this.close(session.id).catch(() => undefined),
      );
      return session;
    } catch (error) {
      try {
        await connection?.close();
      } finally {
        guard?.close();
        await proxy.close();
      }
      throw error;
    }
  }
  get(id: string) {
    const session = this.sessions.get(id);
    if (!session)
      throw new BrowserError('SESSION_NOT_FOUND', 'Session not found', 404);
    return session;
  }
  async close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(id);
    this.registry.clear(id);
    const stopBrowser = () => session.connection.close();
    try {
      if (session.stagehand) await session.stagehand.close(stopBrowser);
      else await stopBrowser();
    } finally {
      // Released only after Chromium is gone, so no worker request escapes the policy.
      session.workerGuard?.close();
      await session.closeProxy();
    }
  }
  async cleanupExpired() {
    const limit = this.config.value.browser?.timeoutMs || 600000;
    for (const session of this.sessions.values())
      if (Date.now() - session.startedAt > limit) await this.close(session.id);
  }
  count() {
    return this.sessions.size;
  }
  // One failed teardown must not leave the remaining browsers running.
  async onModuleDestroy() {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length)
      throw new BrowserError(
        'SESSION_CLEANUP_FAILED',
        failed.length + ' browser session(s) failed to shut down cleanly',
        500,
      );
  }
}
