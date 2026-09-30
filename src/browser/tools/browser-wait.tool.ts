import type { Locator } from 'playwright';
export async function waitTool(
  locator: Locator,
  state: 'visible' | 'hidden',
  timeoutMs: number,
) {
  await locator.waitFor({ state, timeout: timeoutMs });
  return { state };
}
