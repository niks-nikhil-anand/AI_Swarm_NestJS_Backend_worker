import { z } from 'zod';

export function searxngConfiguration(env: NodeJS.ProcessEnv) {
  const endpoint = new URL(env.SEARXNG_URL || 'http://localhost:8080');
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('Invalid SearXNG URL');
  const bounded = (name: string, fallback: number, max: number) =>
    z.coerce
      .number()
      .int()
      .positive()
      .max(max)
      .parse(env[name] ?? fallback);
  return {
    endpoint: endpoint.origin,
    timeoutMs: bounded('SEARCH_REQUEST_TIMEOUT_MS', 15000, 60000),
    maxResponseBytes: bounded('SEARCH_MAX_RESPONSE_BYTES', 2000000, 10000000),
    concurrency: bounded('SEARCH_MAX_CONCURRENT_ACTIVITIES', 2, 20),
    maxQueries: 3,
    maxResultsPerQuery: 10,
    maxCandidates: 5,
  };
}
