import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '../../config/configuration';
import { SearchError } from '../../common/errors/search.errors';
import { SearxngResponseSchema } from '../contracts/search-response';
import type { SearchRequest } from '../contracts/search-request';

@Injectable()
export class SearxngClient {
  constructor(private readonly config: ConfigurationService) {}
  async search(query: string, options: SearchRequest, signal?: AbortSignal) {
    const settings = this.config.value.search;
    const url = new URL('/search', settings.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', String(options.safeSearch));
    if (options.language) url.searchParams.set('language', options.language);
    const abort = AbortSignal.any([
      AbortSignal.timeout(settings.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await fetch(url, {
        signal: abort,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const retryHeader = response.headers.get('retry-after');
        const seconds = Number(retryHeader);
        const retryAfterMs = retryHeader
          ? Math.min(
              30000,
              Math.max(
                0,
                Number.isFinite(seconds)
                  ? seconds * 1000
                  : Date.parse(retryHeader) - Date.now(),
              ),
            )
          : undefined;
        await response.body?.cancel();
        throw new SearchError(
          'SEARCH_HTTP_ERROR',
          'Search service rejected the request',
          502,
          retryable,
          retryAfterMs,
        );
      }
      if (!response.body)
        throw new SearchError(
          'SEARCH_INVALID_RESPONSE',
          'Missing search response',
          502,
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > settings.maxResponseBytes)
            throw new SearchError(
              'SEARCH_RESPONSE_TOO_LARGE',
              'Search response exceeds limit',
              502,
            );
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      try {
        return SearxngResponseSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
      } catch {
        throw new SearchError(
          'SEARCH_INVALID_RESPONSE',
          'Invalid search response',
          502,
        );
      }
    } catch (error) {
      if (signal?.aborted)
        throw new SearchError('CANCELLED', 'Search cancelled', 409);
      if (error instanceof SearchError) throw error;
      throw new SearchError(
        'SEARCH_UNAVAILABLE',
        'Search service unavailable',
        503,
        true,
      );
    }
  }
  async healthy() {
    try {
      const response = await fetch(
        new URL('/healthz', this.config.value.search.endpoint),
        { signal: AbortSignal.timeout(3000), redirect: 'error' },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
}
