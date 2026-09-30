import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import { SearxngClient } from '../../src/search/clients/searxng.client';
import {
  mapSearxng,
  canonicalize,
} from '../../src/search/mappers/searxng.mapper';
import { SearchRequestSchema } from '../../src/search/contracts/search-request';

describe('SearXNG boundary', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  const client = new SearxngClient(
    new ConfigurationService(
      loadConfiguration('search', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
      }),
    ),
  );
  const request = SearchRequestSchema.parse({ queries: ['research'] });
  test('sends encoded JSON search and validates response', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ url: 'https://example.com', title: 'Title' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const response = await client.search('a & b', request);
    expect(response.results).toHaveLength(1);
    const args = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(args[0]).searchParams.get('q')).toBe('a & b');
    expect(args[1].redirect).toBe('error');
  });
  test('429 is retryable and honors Retry-After', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    ) as typeof fetch;
    await expect(client.search('research', request)).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
    });
  });
  test('malformed and oversized responses are permanent failures', async () => {
    global.fetch = jest.fn(
      async () => new Response('{"results":42}'),
    ) as typeof fetch;
    await expect(client.search('research', request)).rejects.toMatchObject({
      code: 'SEARCH_INVALID_RESPONSE',
      retryable: false,
    });
    const small = new SearxngClient(
      new ConfigurationService(
        loadConfiguration('search', {
          DATABASE_URL: 'postgresql://u:p@localhost/db',
          SEARCH_MAX_RESPONSE_BYTES: '8',
        }),
      ),
    );
    global.fetch = jest.fn(
      async () => new Response('123456789'),
    ) as typeof fetch;
    await expect(small.search('research', request)).rejects.toMatchObject({
      code: 'SEARCH_RESPONSE_TOO_LARGE',
    });
  });
  test('deduplicates tracking URLs while preserving semantic query parameters and engines', () => {
    const result = mapSearxng(
      {
        results: [
          {
            url: 'https://example.com/product?id=3&utm_source=ad#x',
            engine: 'a',
          },
          { url: 'https://example.com/product?id=3', engine: 'b' },
          { url: 'https://example.com/product?id=4' },
          { url: 'http://127.0.0.1/private' },
          { url: 'file:///etc/passwd' },
        ],
      },
      'research',
    );
    expect(result).toHaveLength(2);
    expect(result[0].engines).toEqual(['a', 'b']);
    expect(canonicalize(result[0].originalUrl)).toBe(
      'https://example.com/product?id=3',
    );
  });
});
