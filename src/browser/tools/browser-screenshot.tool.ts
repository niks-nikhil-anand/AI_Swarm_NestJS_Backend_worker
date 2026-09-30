import type { Page } from 'playwright';
export function screenshotTool(page: Page) {
  return page.screenshot({ type: 'png', timeout: 15000 });
}
