import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

async function main() {
  const { localBrowser } = await import('@browserbasehq/stagehand');
  const fixture = createServer((_req, res) =>
    res.end(
      '<title>Compatibility</title><button onclick="this.textContent=\'Clicked\'">Click me</button>',
    ),
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture bind failed');
  const reserve = tcpServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const debug = reserve.address();
  if (!debug || typeof debug === 'string')
    throw new Error('Debug port reservation failed');
  await new Promise<void>((resolve, reject) =>
    reserve.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = await mkdtemp(join(tmpdir(), 'swarm-compat-'));
  const extensionPath = join(
    process.cwd(),
    'node_modules',
    '@browserbasehq',
    'stagehand',
    'dist',
    'extension',
  );
  let owner:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let browser: Awaited<ReturnType<typeof localBrowser.connect>> | undefined;
  let pw: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    owner = await chromium.launchPersistentContext(directory, {
      headless: true,
      channel: 'chromium',
      chromiumSandbox: process.platform !== 'win32',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--remote-debugging-port=' + debug.port,
        '--remote-debugging-address=127.0.0.1',
        '--enable-unsafe-extension-debugging',
        '--load-extension=' + extensionPath,
        '--disable-extensions-except=' + extensionPath,
      ],
    });
    const extensionWorker =
      owner.serviceWorkers()[0] ||
      (await owner.waitForEvent('serviceworker', { timeout: 15000 }));
    const extensionId = new URL(extensionWorker.url()).hostname;
    browser = await localBrowser.connect({
      cdpUrl: 'http://127.0.0.1:' + debug.port,
      extensionId,
    });
    pw = await chromium.connectOverCDP('http://127.0.0.1:' + debug.port);
    const context = pw.contexts()[0];
    const page = await context.newPage();
    const url = 'http://127.0.0.1:' + address.port;
    await page.goto(url);

    const pages = await browser.context.pages();
    let matching:
      Awaited<ReturnType<typeof browser.context.pages>>[number] | undefined;
    for (const p of pages) if ((await p.url()) === page.url()) matching = p;
    assert.ok(matching, 'Stagehand sees the Playwright tab');
    assert.equal(await matching.locator('button').textContent(), 'Click me');
    await page.getByRole('button').click();
    assert.equal(await matching.locator('button').textContent(), 'Clicked');

    const second = await browser.context.newPage(url + '/second');
    assert.ok(
      context.pages().length >= 2,
      'Playwright sees Stagehand tab creation',
    );
    assert.ok(await second.url());
    await page.close();
    console.log(
      'PASS: shared context/tab, Playwright change visible to Stagehand, tab creation and cleanup',
    );
    console.log(
      'Semantic observe/extract requires configured model credentials; not covered by this check.',
    );
  } finally {
    await pw?.close();
    await browser?.close();
    await owner?.close();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Compatibility failed',
  );
  process.exitCode = 1;
});
