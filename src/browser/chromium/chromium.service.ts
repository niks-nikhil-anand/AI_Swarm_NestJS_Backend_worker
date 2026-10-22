import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '../../config/configuration';
import { launchChromium } from './chromium.launcher';
@Injectable()
export class ChromiumService {
  constructor(private readonly config: ConfigurationService) {}
  // Each call starts a dedicated Chromium routed through the caller's egress proxy.
  launch(proxyUrl: string) {
    const browser = this.config.value.browser;
    return launchChromium({
      proxyUrl,
      headless: browser?.headless ?? true,
      sandbox: browser?.chromiumSandbox ?? true,
      timeoutMs: browser?.launchTimeoutMs ?? 30000,
      stagehand: browser?.stagehand.enabled ?? false,
    });
  }
}
