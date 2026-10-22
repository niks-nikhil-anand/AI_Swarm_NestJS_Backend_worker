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
  // Phase 6: alternative spellings of hosts and addresses cannot reach a denied destination.
  test('alternative URL and address representations stay denied', async () => {
    for (const url of [
      'https://example.com./',
      'https://evil.test#@example.com/',
      'https://example.com:443@evil.test/',
      'https://example.com@evil.test/',
      'http://0x7f.0.0.1/',
      'http://2130706433/',
      'http://[::ffff:127.0.0.1]/',
      'https://xn--exmple-cua.com/',
      'https://example.com:8443/',
      'ftp://example.com/',
      'javascript:alert(1)',
    ])
      expect(() => domain.assert(url)).toThrow();
    // Equivalent spellings of the same allowlisted host are that host.
    for (const url of ['https://EXAMPLE.com/', 'https://ex%61mple.com/'])
      expect(domain.assert(url).hostname).toBe('example.com');
    // An allowlisted name that resolves into a restricted range is denied at connect time.
    for (const address of [
      '0.0.0.0',
      '100.64.0.1',
      '192.0.0.8',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      'fe80::1',
    ]) {
      (dns.lookup as jest.Mock).mockResolvedValue([
        { address, family: address.includes(':') ? 6 : 4 },
      ] as never);
      await expect(
        new NetworkPolicyService(domain).resolve('https://example.com/'),
      ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    }
    (dns.lookup as jest.Mock).mockResolvedValue([] as never);
    await expect(
      new NetworkPolicyService(domain).resolve('https://example.com/'),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
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
