jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
import { DomainPolicyService } from '../../src/browser/policies/domain-policy.service';
import {
  NetworkPolicyService,
  isPublicAddress,
} from '../../src/browser/policies/network-policy.service';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import * as dns from 'node:dns/promises';

describe('Browser destination policy', () => {
  const domain = new DomainPolicyService(
    new ConfigurationService(
      loadConfiguration('browser', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        BROWSER_ALLOWED_DOMAINS: 'example.com',
      }),
    ),
  );
  afterEach(() => jest.restoreAllMocks());
  test('denies private, reserved and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
  test('denies credentials, unsupported ports and non-allowlisted domains', () => {
    for (const url of [
      'http://user:pass@example.com',
      'http://example.com:8080',
      'file:///tmp/a',
      'https://evil.example.com',
    ])
      expect(() => domain.assert(url)).toThrow();
  });
  test('rejects mixed public/private DNS responses before connecting', async () => {
    (dns.lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(
      new NetworkPolicyService(domain).resolve('https://example.com'),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  });
});
