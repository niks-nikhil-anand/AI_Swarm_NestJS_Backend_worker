import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '../../config/configuration';
import { PolicyError } from '../../common/errors/policy.errors';
@Injectable()
export class DomainPolicyService {
  constructor(private readonly config: ConfigurationService) {}
  assert(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PolicyError('URL_DENIED', 'Invalid destination');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['', '80', '443'].includes(url.port)
    )
      throw new PolicyError(
        'URL_DENIED',
        'Destination protocol, credentials or port denied',
      );
    const domains = this.config.value.browser?.allowedDomains || [];
    if (!domains.includes(url.hostname.toLowerCase()))
      throw new PolicyError('DOMAIN_DENIED', 'Destination domain not allowed');
    return url;
  }
}
