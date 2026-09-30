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

@Injectable()
export class SessionManagerService implements OnModuleDestroy {
  private readonly sessions = new Map<string, BrowserSession>();
  constructor(
    private readonly chromium: ChromiumService,
    private readonly config: ConfigurationService,
    private readonly domain: DomainPolicyService,
    private readonly network: NetworkPolicyService,
    private readonly capability: CapabilityPolicyService,
  ) {}
  async create(owner: ExecutionContext) {
    this.capability.assert(owner);
    const proxy = await createEgressProxy(this.network);
    let browser: Awaited<ReturnType<ChromiumService['launch']>> | undefined;
    try {
      browser = await this.chromium.launch();
      const context = await browser.newContext({
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      context.setDefaultTimeout(
        this.config.value.browser?.actionTimeoutMs || 15000,
      );
      await context.route('**/*', async (route) => {
        try {
          this.domain.assert(route.request().url());
          if (!['GET', 'HEAD'].includes(route.request().method()))
            throw new Error('Read-only session');
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      await context.routeWebSocket('**/*', (route) => route.close());
      const session: BrowserSession = {
        id: randomUUID(),
        owner,
        browser,
        context,
        tabs: new Map(),
        startedAt: Date.now(),
        actions: 0,
        closeProxy: proxy.close,
        closed: false,
      };
      context.on('page', (page) => {
        if (session.tabs.size >= (this.config.value.browser?.maxTabs || 5)) {
          void page.close();
          return;
        }
        session.tabs.set(randomUUID(), page);
        page.on('close', () => {
          for (const [id, item] of session.tabs)
            if (item === page) session.tabs.delete(id);
        });
      });
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
      this.sessions.set(session.id, session);
      await context.newPage();
      return session;
    } catch (error) {
      await browser?.close();
      await proxy.close();
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
    try {
      await session.context.close();
    } finally {
      try {
        await session.browser.close();
      } finally {
        await session.closeProxy();
      }
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
  async onModuleDestroy() {
    for (const id of this.sessions.keys()) await this.close(id);
  }
}
