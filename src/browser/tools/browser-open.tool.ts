import type { Page } from 'playwright';
export async function openTool(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  return { url: page.url(), title: await page.title() };
}
