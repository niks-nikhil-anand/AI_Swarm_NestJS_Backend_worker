import { loadConfiguration } from '../../src/config/configuration';
import { browserConfiguration } from '../../src/config/browser.config';
const base = { DATABASE_URL: 'postgresql://user:password@localhost/db' };
describe('Browser runtime configuration', () => {
  const browser = { ...base, BROWSER_ALLOWED_DOMAINS: 'example.com' };
  test('defaults to headless, sandboxed Chromium with Stagehand disabled', () => {
    expect(loadConfiguration('browser', browser).browser).toMatchObject({
      headless: true,
      chromiumSandbox: true,
      launchTimeoutMs: 30000,
      stagehand: { enabled: false, connectTimeoutMs: 30000 },
    });
  });
  test('headless mode does not change the sandbox setting', () => {
    expect(
      browserConfiguration(
        { ...browser, BROWSER_HEADLESS: 'false', DISPLAY: ':99' },
        'linux',
      ),
    ).toMatchObject({ headless: false, chromiumSandbox: true });
  });
  test('errors name the variable without echoing its value', () => {
    for (const [env, message] of [
      [
        { STAGEHAND_ENABLED: 'yes-secret' },
        'STAGEHAND_ENABLED must be "true" or "false"',
      ],
      [{ BROWSER_HEADLESS: '1' }, 'BROWSER_HEADLESS must be "true" or "false"'],
      [
        { STAGEHAND_CONNECT_TIMEOUT_MS: '10' },
        'STAGEHAND_CONNECT_TIMEOUT_MS must be an integer between 5000 and 60000',
      ],
      [
        { BROWSER_CDP_URL: 'ws://10.0.0.1:9222' },
        'BROWSER_CDP_URL is not supported: Stagehand connects only to the managed per-session Chromium',
      ],
      [
        { STAGEHAND_CDP_URL: 'http://127.0.0.1:9222' },
        'STAGEHAND_CDP_URL is not supported',
      ],
    ] as const) {
      const attempt = () =>
        loadConfiguration('browser', { ...browser, ...env });
      expect(attempt).toThrow('Invalid configuration: ' + message);
      expect(attempt).not.toThrow(/secret|10\.0\.0\.1/);
    }
  });
  test('headful Chromium on Linux requires a display', () => {
    expect(() =>
      browserConfiguration({ ...browser, BROWSER_HEADLESS: 'false' }, 'linux'),
    ).toThrow('BROWSER_HEADLESS=false requires a DISPLAY or WAYLAND_DISPLAY');
  });
});
describe('Process configuration', () => {
  test('search workers do not require credentials or browser/model settings', () => {
    expect(loadConfiguration('search', base).principals).toEqual([]);
  });
  test('approval settings default safely and reject out-of-range TTLs', () => {
    expect(loadConfiguration('search', base).approvals).toEqual({
      ttlMs: 600000,
      distinctApprover: true,
    });
    expect(
      loadConfiguration('search', {
        ...base,
        APPROVAL_TTL_MS: '120000',
        APPROVAL_REQUIRE_DISTINCT_APPROVER: 'false',
      }).approvals,
    ).toEqual({ ttlMs: 120000, distinctApprover: false });
    for (const ttl of ['1000', '3600000', 'soon'])
      expect(() =>
        loadConfiguration('search', { ...base, APPROVAL_TTL_MS: ttl }),
      ).toThrow();
  });
  test('API refuses missing authorization configuration', () => {
    expect(() => loadConfiguration('api', base)).toThrow(
      'Invalid configuration',
    );
  });
  test('rejects credentialed SearXNG endpoints and invalid limits', () => {
    expect(() =>
      loadConfiguration('search', {
        ...base,
        SEARXNG_URL: 'http://user:pass@host',
      }),
    ).toThrow();
    expect(() =>
      loadConfiguration('search', { ...base, SEARCH_REQUEST_TIMEOUT_MS: '-1' }),
    ).toThrow();
  });
});
