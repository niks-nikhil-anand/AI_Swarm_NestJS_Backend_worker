import { Test } from '@nestjs/testing';
import { BrowserModule } from '../../src/browser/browser.module';
import {
  ConfigurationModule,
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import { SessionManagerService } from '../../src/browser/services/session-manager.service';
import { BrowserService } from '../../src/browser/services/browser.service';
import type { ExecutionContext } from '../../src/common/types/execution-context';

describe('Controlled Chromium tools', () => {
  const actor: ExecutionContext = {
    tenantId: 'tenant',
    projectId: 'project',
    userId: 'user',
    requestId: 'req',
    capabilities: ['browser'],
  };
  test('real browser click, stale references, ownership denial and resource cleanup', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRole('browser'), BrowserModule],
      providers: [
        {
          provide: ConfigurationService,
          useValue: new ConfigurationService(
            loadConfiguration('browser', {
              DATABASE_URL: 'postgresql://u:p@localhost/db',
              BROWSER_ALLOWED_DOMAINS: 'example.com',
              CHROMIUM_SANDBOX: 'false',
            }),
          ),
        },
      ],
    })
      .overrideProvider(ConfigurationService)
      .useValue(
        new ConfigurationService(
          loadConfiguration('browser', {
            DATABASE_URL: 'postgresql://u:p@localhost/db',
            BROWSER_ALLOWED_DOMAINS: 'example.com',
            CHROMIUM_SANDBOX: 'false',
          }),
        ),
      )
      .compile();
    // Configuration is global in production. Add it explicitly to the browser module for test composition.
    const sessions = module.get(SessionManagerService),
      tools = module.get(BrowserService);
    let session: Awaited<ReturnType<typeof sessions.create>> | undefined;
    try {
      session = await sessions.create(actor);
      const tabId = [...session.tabs.keys()][0],
        page = session.tabs.get(tabId)!;
      await page.setContent(
        '<button type="button" onclick="this.textContent=\'Changed\'">Click me</button>',
      );
      const observe = await tools.execute(session.id, actor, {
        kind: 'observe',
        tabId,
      });
      expect(observe.status).toBe('success');
      const data = observe.data as { elements: { id: string }[] };
      const click = await tools.execute(session.id, actor, {
        kind: 'click',
        tabId,
        target: { kind: 'reference', id: data.elements[0].id },
      });
      expect(click.status).toBe('success');
      expect(await page.locator('button').textContent()).toBe('Changed');
      const stale = await tools.execute(session.id, actor, {
        kind: 'click',
        tabId,
        target: { kind: 'reference', id: data.elements[0].id },
      });
      expect(stale.error?.code).toBe('STALE_TARGET');
      const denied = await tools.execute(
        session.id,
        { ...actor, tenantId: 'other' },
        { kind: 'observe', tabId },
      );
      expect(denied.error?.code).toBe('SESSION_DENIED');
      const blocked = await tools.execute(session.id, actor, {
        kind: 'open',
        tabId,
        url: 'http://localhost',
      });
      expect(blocked.error?.code).toBe('DOMAIN_DENIED');
    } finally {
      if (session) await tools.close(session.id);
      await module.close();
    }
    expect(sessions.count()).toBe(0);
  }, 30000);
});
