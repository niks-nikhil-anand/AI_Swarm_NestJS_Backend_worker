import { chromium } from 'playwright';
import { RESEARCH_CHROMIUM_ARGS } from './chromium.options';
export async function launchChromium(sandbox = true) {
  return chromium.launch({
    headless: true,
    chromiumSandbox: sandbox,
    args: RESEARCH_CHROMIUM_ARGS,
  });
}
