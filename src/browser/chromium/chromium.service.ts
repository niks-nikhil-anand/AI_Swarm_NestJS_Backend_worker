import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '../../config/configuration';
import { launchChromium } from './chromium.launcher';
@Injectable()
export class ChromiumService {
  constructor(private readonly config: ConfigurationService) {}
  launch() {
    return launchChromium(this.config.value.browser?.chromiumSandbox ?? true);
  }
}
