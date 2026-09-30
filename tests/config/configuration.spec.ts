import { loadConfiguration } from '../../src/config/configuration';
const base = { DATABASE_URL: 'postgresql://user:password@localhost/db' };
describe('Process configuration', () => {
  test('search workers do not require credentials or browser/model settings', () => {
    expect(loadConfiguration('search', base).principals).toEqual([]);
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
