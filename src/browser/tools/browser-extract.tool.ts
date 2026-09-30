import type { Page } from 'playwright';
import { PlaywrightAdapter } from '../adapters/playwright/playwright.adapter';
export function extractTool(adapter: PlaywrightAdapter, page: Page) {
  return adapter.article(page);
}
