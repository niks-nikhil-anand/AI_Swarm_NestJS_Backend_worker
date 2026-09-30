import type { Page } from 'playwright';
import { TargetRegistryService } from '../targets/target-registry.service';
import { pageRevision } from '../targets/page-revision';
export async function observeTool(
  sessionId: string,
  tabId: string,
  page: Page,
  registry: TargetRegistryService,
) {
  const revision = await pageRevision(page);
  const locator = page.locator(
    'a,button,input:not([type="hidden"]),textarea,select',
  );
  const elements = [];
  for (let i = 0; i < Math.min(await locator.count(), 50); i++) {
    const item = locator.nth(i);
    if (!(await item.isVisible())) continue;
    const label =
      (await item.getAttribute('aria-label')) ||
      (await item.textContent()) ||
      (await item.getAttribute('placeholder')) ||
      '';
    elements.push({
      id: registry.register(sessionId, tabId, revision, item),
      label: label.trim().slice(0, 200),
    });
  }
  return { url: page.url(), title: await page.title(), revision, elements };
}
