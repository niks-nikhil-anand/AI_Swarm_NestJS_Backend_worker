import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '../../config/configuration';
import type { BrowserSession } from '../contracts/browser-session';
import { PolicyError } from '../../common/errors/policy.errors';
@Injectable()
export class ResourcePolicyService {
  constructor(private readonly config: ConfigurationService) {}
  assert(session: BrowserSession) {
    const limits = this.config.value.browser;
    if (
      !limits ||
      session.actions >= limits.maxActions ||
      Date.now() - session.startedAt >= limits.timeoutMs
    )
      throw new PolicyError('BUDGET_EXCEEDED', 'Browser budget exceeded');
  }
}
