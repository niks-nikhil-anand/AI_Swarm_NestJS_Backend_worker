import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '../../common/types/execution-context';
import { ServiceError } from '../../common/errors/service.error';
import { BrowserActionSchema } from '../contracts/browser-action';
import type { BrowserResult } from '../contracts/browser-result';
import type { BrowserTarget } from '../contracts/browser-target';
import type { BrowserSession } from '../contracts/browser-session';
import { BrowserPolicyService } from '../policies/browser-policy.service';
import { DomainPolicyService } from '../policies/domain-policy.service';
import { ConfigurationService } from '../../config/configuration';
import { SessionManagerService } from './session-manager.service';
import { TabManagerService } from './tab-manager.service';
import { TargetRegistryService } from '../targets/target-registry.service';
import { pageRevision } from '../targets/page-revision';
import { PlaywrightAdapter } from '../adapters/playwright/playwright.adapter';
import { openTool } from '../tools/browser-open.tool';
import { observeTool } from '../tools/browser-observe.tool';
import { clickTool } from '../tools/browser-click.tool';
import { typeTool } from '../tools/browser-type.tool';
import { scrollTool } from '../tools/browser-scroll.tool';
import { extractTool } from '../tools/browser-extract.tool';
import { screenshotTool } from '../tools/browser-screenshot.tool';
import { listTabsTool } from '../tools/browser-tabs.tool';
import { waitTool } from '../tools/browser-wait.tool';
import { BrowserError } from '../../common/errors/browser.errors';

@Injectable()
export class BrowserService {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly sessions: SessionManagerService,
    private readonly tabs: TabManagerService,
    private readonly policy: BrowserPolicyService,
    private readonly domain: DomainPolicyService,
    private readonly registry: TargetRegistryService,
    private readonly adapter: PlaywrightAdapter,
    private readonly config: ConfigurationService,
  ) {}
  async execute(
    sessionId: string,
    ctx: ExecutionContext,
    input: unknown,
  ): Promise<BrowserResult> {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(() => this.dispatch(sessionId, ctx, input));
    this.locks.set(sessionId, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(sessionId) === work) this.locks.delete(sessionId);
    }
  }
  async close(sessionId: string) {
    this.registry.clear(sessionId);
    await this.sessions.close(sessionId);
  }
  private async target(
    session: BrowserSession,
    tabId: string,
    target: BrowserTarget,
  ) {
    const page = this.tabs.get(session, tabId);
    if (target.kind === 'reference')
      return this.registry.get(
        target.id,
        session.id,
        tabId,
        await pageRevision(page),
      );
    const locator =
      target.kind === 'css'
        ? page.locator(target.selector)
        : page.getByRole(target.role, { name: target.name, exact: true });
    if ((await locator.count()) !== 1)
      throw new BrowserError(
        'AMBIGUOUS_TARGET',
        'Expected exactly one target',
        409,
      );
    return locator;
  }
  private async dispatch(
    id: string,
    ctx: ExecutionContext,
    input: unknown,
  ): Promise<BrowserResult> {
    const started = Date.now(),
      actionId = randomUUID();
    try {
      const action = BrowserActionSchema.parse(input);
      const session = this.sessions.get(id);
      this.policy.assert(session, ctx);
      session.actions++;
      const tabId = 'tabId' in action ? action.tabId : undefined;
      const page = tabId ? this.tabs.get(session, tabId) : undefined;
      let data: unknown;
      switch (action.kind) {
        case 'open':
          this.domain.assert(action.url);
          data = await openTool(page!, action.url);
          break;
        case 'observe':
          data = await observeTool(id, action.tabId, page!, this.registry);
          break;
        case 'click':
          data = await clickTool(
            await this.target(session, action.tabId, action.target),
          );
          break;
        case 'type':
          data = await typeTool(
            await this.target(session, action.tabId, action.target),
            action.text,
            action.mode,
          );
          break;
        case 'scroll':
          data = await scrollTool(page!, action.pixels);
          break;
        case 'extract':
          data = await extractTool(this.adapter, page!);
          break;
        case 'screenshot':
          data = await screenshotTool(page!);
          break;
        case 'list_tabs':
          data = listTabsTool(session);
          break;
        case 'new_tab':
          if (session.tabs.size >= (this.config.value.browser?.maxTabs || 5))
            throw new BrowserError('TAB_LIMIT', 'Tab budget exceeded', 409);
          await session.context.newPage();
          data = listTabsTool(session);
          break;
        case 'close_tab':
          await page!.close();
          data = { closed: true };
          break;
        case 'go_back':
          await page!.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
          data = { url: page!.url() };
          break;
        case 'wait_for':
          data = await waitTool(
            await this.target(session, action.tabId, action.target),
            action.state,
            action.timeoutMs,
          );
          break;
      }
      return {
        actionId,
        status: 'success',
        tabId,
        url: page && !page.isClosed() ? page.url() : undefined,
        data,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        actionId,
        status: 'failed',
        error: {
          code:
            error instanceof ServiceError
              ? error.code
              : 'BROWSER_ACTION_FAILED',
          message:
            error instanceof ServiceError
              ? error.message
              : 'Browser action failed',
          retryable: error instanceof ServiceError && error.retryable,
        },
        durationMs: Date.now() - started,
      };
    }
  }
}
