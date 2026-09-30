import type { Locator } from 'playwright';
export async function typeTool(
  locator: Locator,
  text: string,
  mode: 'fill' | 'append',
) {
  if (mode === 'fill') await locator.fill(text);
  else await locator.pressSequentially(text);
  return { typed: true };
}
