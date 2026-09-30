import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Stagehand, localBrowser } from '@browserbasehq/stagehand';

assert.equal(typeof Stagehand.create, 'function');
assert.equal(typeof localBrowser.connect, 'function');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<button onclick="this.textContent=\'Clicked\'">Click me</button>');
  await page.getByRole('button', { name: 'Click me' }).click();
  assert.equal(await page.getByRole('button').textContent(), 'Clicked');
  await context.close();
  console.log('PASS: Chromium launch, Playwright click, Stagehand SDK imports and context cleanup');
} finally {
  await browser.close();
}

// Explicit opt-in: contacts configured external search engines.
if (process.argv.includes('--search')) {
  const base = process.env.SEARXNG_URL || 'http://searxng:8080';
  const url = new URL('/search', base);
  url.searchParams.set('q', 'Playwright browser automation');
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, 'SearXNG search HTTP status');
  const result = await response.json();
  assert.ok(Array.isArray(result.results), 'Expected SearXNG results array');
  assert.ok(result.results.length > 0, 'No search results; inspect engine errors/network access');
  console.log('PASS: SearXNG JSON search returned ' + result.results.length + ' results');
}
