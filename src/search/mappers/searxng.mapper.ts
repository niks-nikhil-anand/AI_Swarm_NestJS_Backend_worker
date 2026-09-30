import { isIP } from 'node:net';
import type { SearxngResponse } from '../contracts/search-response';
import type { SearchResult } from '../contracts/search-result';

export function publicCandidateUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      isIP(host) ||
      !host.includes('.') ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host === 'localhost'
    )
      return;
    return url;
  } catch {
    return;
  }
}
export function canonicalize(raw: string): string | undefined {
  const url = publicCandidateUrl(raw);
  if (!url) return;
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys()))
    if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key))
      url.searchParams.delete(key);
  return url.toString();
}
export function mapSearxng(
  response: SearxngResponse,
  query: string,
  now = new Date(),
): SearchResult[] {
  const results = new Map<string, SearchResult>();
  for (const [index, item] of response.results.entries()) {
    const canonicalUrl = canonicalize(item.url);
    if (!canonicalUrl) continue;
    const engines = [
      ...new Set([
        ...(item.engines || []),
        ...(item.engine ? [item.engine] : []),
      ]),
    ];
    const previous = results.get(canonicalUrl);
    if (previous) {
      previous.engines = [...new Set([...previous.engines, ...engines])];
      continue;
    }
    results.set(canonicalUrl, {
      originalUrl: item.url,
      canonicalUrl,
      title: item.title || '',
      snippet: (item.content || '').slice(0, 4000),
      engines,
      rank: index + 1,
      query,
      retrievedAt: now.toISOString(),
    });
    if (results.size >= 10) break;
  }
  return [...results.values()];
}
