import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Test, type TestingModule } from '@nestjs/testing';
import { BrowserModule } from '../../src/browser/browser.module';
import {
  ConfigurationModule,
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import { SessionManagerService } from '../../src/browser/services/session-manager.service';
import { BrowserService } from '../../src/browser/services/browser.service';
import type { BrowserSession } from '../../src/browser/contracts/browser-session';
import type { ExecutionContext } from '../../src/common/types/execution-context';

// Needs full Chromium with extension support and /proc (Linux). Run in the browser test
// container with STAGEHAND_INTEGRATION=1; see documentation/IMPLEMENTATION_STATUS.md.
const suite =
  process.env.STAGEHAND_INTEGRATION === '1' ? describe : describe.skip;

const actor = (tenantId: string): ExecutionContext => ({
  tenantId,
  projectId: 'project',
  userId: 'user',
  requestId: 'req-' + tenantId,
  capabilities: ['browser'],
});
// Chromium processes started for one session's private profile, including children.
function chromiumProcesses(profileDir: string) {
  const all = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  const read = (pid: string, file: string) => {
    try {
      return readFileSync('/proc/' + pid + '/' + file, 'utf8');
    } catch {
      return '';
    }
  };
  const roots = all.filter((pid) =>
    read(pid, 'cmdline').includes('--user-data-dir=' + profileDir),
  );
  const parent = (pid: string) =>
    read(pid, 'stat')
      .replace(/^.*\) /, '')
      .split(' ')[1];
  const found = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const pid of all)
      if (!found.has(pid) && found.has(parent(pid) || '')) {
        found.add(pid);
        grew = true;
      }
  }
  // Zombies are already dead; only count processes that can still run.
  return [...found].filter((pid) => !/^\S+ \(.*\) Z/.test(read(pid, 'stat')));
}
const running = (pid: string) => {
  try {
    return !/^\S+ \(.*\) Z/.test(
      readFileSync('/proc/' + pid + '/stat', 'utf8'),
    );
  } catch {
    return false;
  }
};
const mainProcess = (profileDir: string) =>
  chromiumProcesses(profileDir).find(
    (pid) =>
      !readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('--type='),
  );
async function eventually(check: () => boolean, ms = 10000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until)
      throw new Error('Condition not met in ' + ms + 'ms');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// Answers one allowlisted URL locally, ahead of the session's policy route, so the test
// needs no network access.
const FIXTURE_URL = 'https://example.com/stagehand-fixture';
const serve = (session: BrowserSession, html: string) =>
  session.context.route(FIXTURE_URL, (route) =>
    route.fulfill({ body: html, contentType: 'text/html' }),
  );
const markerTexts = async (session: BrowserSession) => {
  const texts: string[] = [];
  for (const page of await session.stagehand!.browser.context.pages())
    texts.push(
      (await page
        .locator('#marker')
        .textContent()
        .catch(() => null)) || '',
    );
  return texts;
};

suite('Stagehand on managed Chromium sessions', () => {
  let module: TestingModule;
  let sessions: SessionManagerService;
  let tools: BrowserService;
  beforeEach(async () => {
    const config = new ConfigurationService(
      loadConfiguration('browser', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        BROWSER_ALLOWED_DOMAINS: 'example.com',
        STAGEHAND_ENABLED: 'true',
        CHROMIUM_SANDBOX: process.env.CHROMIUM_SANDBOX || 'true',
      }),
    );
    module = await Test.createTestingModule({
      imports: [ConfigurationModule.forRole('browser'), BrowserModule],
    })
      .overrideProvider(ConfigurationService)
      .useValue(config)
      .compile();
    sessions = module.get(SessionManagerService);
    tools = module.get(BrowserService);
  });
  afterEach(async () => {
    await module.close();
  }, 30000);

  test('Stagehand attaches to its own session and sessions share no pages or cookies', async () => {
    const a = await sessions.create(actor('tenant-a'));
    const b = await sessions.create(actor('tenant-b'));
    expect(a.stagehand?.client.initialized).toBe(true);
    expect(b.stagehand?.client.initialized).toBe(true);
    expect(a.connection.stagehand!.webSocketUrl).not.toBe(
      b.connection.stagehand!.webSocketUrl,
    );
    expect(a.connection.profileDir).not.toBe(b.connection.profileDir);
    const pageA = [...a.tabs.values()][0],
      pageB = [...b.tabs.values()][0];
    // Stagehand's content script only runs in http(s) documents, not about:blank.
    await serve(a, '<p id="marker">alpha</p>');
    await serve(b, '<p id="marker">beta</p>');
    await pageA.goto(FIXTURE_URL);
    await pageB.goto(FIXTURE_URL);
    expect(await markerTexts(a)).toContain('alpha');
    expect(await markerTexts(a)).not.toContain('beta');
    expect(await markerTexts(b)).toContain('beta');
    expect(await markerTexts(b)).not.toContain('alpha');
    // Playwright changes are visible to Stagehand on the same tab.
    await pageA.evaluate(() => {
      document.querySelector('#marker')!.textContent = 'alpha-2';
    });
    expect(await markerTexts(a)).toContain('alpha-2');
    // Tabs are opened through Playwright: Stagehand 4.1.0's own newPage() never reaches a
    // ready state under the session's request interception. Stagehand drives them.
    const opened = await a.context.newPage();
    await opened.goto(FIXTURE_URL);
    expect(a.tabs.size).toBe(2);
    expect(b.tabs.size).toBe(1);
    expect(
      (await markerTexts(a)).filter((text) => text === 'alpha'),
    ).toHaveLength(1);

    await a.context.addCookies([
      { name: 'sid', value: 'tenant-a', domain: 'example.com', path: '/' },
    ]);
    expect((await a.context.cookies()).map((c) => c.value)).toEqual([
      'tenant-a',
    ]);
    expect(await b.context.cookies()).toEqual([]);
    expect(await b.stagehand!.browser.context.cookies()).toEqual([]);
    expect(
      (await a.stagehand!.browser.context.cookies()).map((c) => c.value),
    ).toEqual(['tenant-a']);
  }, 90000);

  test('Playwright navigation and network policy still apply with Stagehand attached', async () => {
    const session = await sessions.create(actor('tenant-a'));
    const tabId = [...session.tabs.keys()][0];
    const opened = await tools.execute(session.id, actor('tenant-a'), {
      kind: 'open',
      tabId,
      url: 'https://example.com/',
    });
    expect(opened).toMatchObject({
      status: 'success',
      url: 'https://example.com/',
    });
    const pageUrls = await Promise.all(
      (await session.stagehand!.browser.context.pages()).map((page) =>
        page.url(),
      ),
    );
    expect(pageUrls).toContain('https://example.com/');
    const cdpPort = new URL(session.connection.stagehand!.webSocketUrl).port;
    for (const [url, code] of [
      ['http://localhost/', 'DOMAIN_DENIED'],
      ['http://127.0.0.1/', 'DOMAIN_DENIED'],
      // The session's own debugging endpoint is never reachable from page navigation.
      ['http://127.0.0.1:' + cdpPort + '/json/version', 'URL_DENIED'],
    ])
      expect(
        await tools.execute(session.id, actor('tenant-a'), {
          kind: 'open',
          tabId,
          url,
        }),
      ).toMatchObject({ status: 'failed', error: { code } });
    const cdpFromPage = await session.tabs.get(tabId)!.evaluate(
      (port) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(
            'ws://127.0.0.1:' + port + '/devtools/browser',
          );
          socket.onopen = () => resolve('open');
          socket.onerror = socket.onclose = () => resolve('blocked');
          setTimeout(() => resolve('no answer'), 5000);
        }),
      cdpPort,
    );
    expect(cdpFromPage).toBe('blocked');
    // Writes stay blocked for in-page requests, whoever triggers them.
    const page = session.tabs.get(tabId)!;
    const posted = await page.evaluate(() =>
      fetch('https://example.com/', { method: 'POST', body: 'x' }).then(
        () => 'sent',
        () => 'blocked',
      ),
    );
    expect(posted).toBe('blocked');
    // The extension's own requests bypass page routing; the worker guard applies the same
    // policy (an allowlisted HTTPS POST would otherwise leave through an opaque tunnel).
    const worker = session.context
      .serviceWorkers()
      .find((item) => item.url().startsWith('chrome-extension://'))!;
    for (const [url, method] of [
      ['https://example.com/', 'POST'],
      ['https://www.iana.org/', 'GET'],
      ['http://169.254.169.254/latest/meta-data/', 'GET'],
    ])
      expect(
        await worker.evaluate(
          ([target, verb]) =>
            fetch(
              target,
              verb === 'POST' ? { method: verb, body: 'x' } : { method: verb },
            ).then(
              (response) => 'status ' + response.status,
              () => 'blocked',
            ),
          [url, method],
        ),
      ).toBe('blocked');
    expect(session.workerGuard).toBeDefined();
    const denied = await tools.execute(session.id, actor('other-tenant'), {
      kind: 'observe',
      tabId,
    });
    expect(denied.error?.code).toBe('SESSION_DENIED');
  }, 90000);

  test('closing a session stops Chromium, its children and the debugging endpoint', async () => {
    const session = await sessions.create(actor('tenant-a'));
    const profile = session.connection.profileDir;
    const endpoint = new URL(session.connection.stagehand!.webSocketUrl);
    const pids = chromiumProcesses(profile);
    expect(pids.length).toBeGreaterThan(1);
    await tools.close(session.id);
    expect(sessions.count()).toBe(0);
    expect(pids.filter(running)).toEqual([]);
    expect(chromiumProcesses(profile)).toEqual([]);
    expect(existsSync(profile)).toBe(false);
    await expect(
      fetch('http://127.0.0.1:' + endpoint.port + '/json/version'),
    ).rejects.toThrow();
  }, 60000);

  test('a crashed Chromium releases the session', async () => {
    const session = await sessions.create(actor('tenant-a'));
    const profile = session.connection.profileDir;
    const tabId = [...session.tabs.keys()][0];
    process.kill(Number(mainProcess(profile)), 'SIGKILL');
    await eventually(() => sessions.count() === 0 && !existsSync(profile));
    expect(
      await tools.execute(session.id, actor('tenant-a'), {
        kind: 'observe',
        tabId,
      }),
    ).toMatchObject({ status: 'failed', error: { code: 'SESSION_NOT_FOUND' } });
    await eventually(() => chromiumProcesses(profile).length === 0);
  }, 60000);

  test('module shutdown closes every open session without orphans', async () => {
    const opened = await Promise.all([
      sessions.create(actor('tenant-a')),
      sessions.create(actor('tenant-b')),
    ]);
    const profiles = opened.map((session) => session.connection.profileDir);
    await module.close();
    expect(sessions.count()).toBe(0);
    for (const profile of profiles) {
      expect(chromiumProcesses(profile)).toEqual([]);
      expect(existsSync(profile)).toBe(false);
    }
  }, 90000);
});
