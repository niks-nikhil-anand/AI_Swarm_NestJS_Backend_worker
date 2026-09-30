import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { DomainPolicyService } from './domain-policy.service';
import { PolicyError } from '../../common/errors/policy.errors';
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
@Injectable()
export class NetworkPolicyService {
  constructor(private readonly domain: DomainPolicyService) {}
  async resolve(raw: string) {
    const url = this.domain.assert(raw);
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
      throw new PolicyError(
        'NETWORK_DENIED',
        'Destination resolves to a restricted network',
      );
    return { url, address: addresses[0].address, family: addresses[0].family };
  }
}
