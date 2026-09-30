import type { Page } from 'playwright';
export async function scrollTool(page: Page, pixels: number) {
  await page.mouse.wheel(0, pixels);
  return { pixels };
}
