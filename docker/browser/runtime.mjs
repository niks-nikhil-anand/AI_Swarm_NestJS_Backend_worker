import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { Stagehand, localBrowser } from '@browserbasehq/stagehand';

// Infrastructure readiness only. No browser action API is exposed here.
if (typeof Stagehand.create !== 'function' || typeof localBrowser.connect !== 'function') {
  throw new Error('Required Stagehand exports are unavailable');
}

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.setContent('<title>Swarm Browser Runtime</title><h1>Ready</h1>');
if (await page.title() !== 'Swarm Browser Runtime') {
  await browser.close();
  throw new Error('Chromium startup check failed');
}
await context.close();

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404);
    response.end();
    return;
  }

  const healthy = browser.isConnected();
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    status: healthy ? 'ready' : 'unavailable',
    chromium: browser.version(),
    playwright: '1.63.0',
    stagehand: { version: '4.1.0', installed: true, semanticSessionInitialized: false },
  }));
});

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close();
  try {
    await browser.close();
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
browser.on('disconnected', () => { if (!stopping) void shutdown(1); });
server.on('error', (error) => {
  console.error(error.message);
  void shutdown(1);
});
server.listen(Number(process.env.PORT || 3001), '0.0.0.0', () => {
  console.log('Browser runtime ready: Chromium + Playwright + Stagehand installed');
});
