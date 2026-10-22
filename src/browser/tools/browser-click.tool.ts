import type { Locator, Page } from 'playwright';
import { PolicyError } from '../../common/errors/policy.errors';
// Shared by Playwright clicks and Stagehand-proposed clicks.
export async function assertSafeClick(locator: Locator) {
  const risky = await locator.evaluate((element) => {
    const text =
      (element.textContent || '') +
      ' ' +
      (element.getAttribute('aria-label') || '');
    const type = element.getAttribute('type');
    return (
      /buy|purchase|delete|publish|confirm|checkout|subscribe/i.test(text) ||
      (element.tagName === 'INPUT' && type === 'submit') ||
      (element.tagName === 'BUTTON' &&
        !!element.closest('form') &&
        type !== 'button')
    );
  });
  if (risky)
    throw new PolicyError(
      'APPROVAL_REQUIRED',
      'Consequential actions are not enabled in the research profile',
    );
}
// A click that navigates returns once the navigation has started; later steps must see
// the new document, so wait for it (immediate when the click did not navigate).
export const settle = (page: Page) =>
  page.waitForLoadState('domcontentloaded', { timeout: 15000 });
export async function clickTool(locator: Locator) {
  await assertSafeClick(locator);
  await locator.click();
  await settle(locator.page());
  return { clicked: true };
}
