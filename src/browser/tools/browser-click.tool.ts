import type { Locator } from 'playwright';
import { PolicyError } from '../../common/errors/policy.errors';
export async function clickTool(locator: Locator) {
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
  await locator.click();
  return { clicked: true };
}
