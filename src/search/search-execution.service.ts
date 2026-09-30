import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RunRepository, Run } from '../persistence/run.repository';
import { DatabaseService } from '../persistence/database.service';
import { SearxngClient } from './clients/searxng.client';
import { SearchRequestSchema } from './contracts/search-request';
import { mapSearxng } from './mappers/searxng.mapper';
import { SearchError } from '../common/errors/search.errors';
import type { SearchResult } from './contracts/search-result';

export interface RunJob {
  runId: string;
  tenantId: string;
  projectId: string;
}
@Injectable()
export class SearchExecutionService {
  constructor(
    private readonly client: SearxngClient,
    private readonly db: DatabaseService,
    private readonly runs: RunRepository,
  ) {}
  async execute(
    job: RunJob,
    signal?: AbortSignal,
    heartbeat: () => void = () => {},
  ) {
    const run = await this.runs.get(job.runId, job.tenantId, job.projectId);
    if (run.kind !== 'search' && run.kind !== 'research')
      throw new SearchError('INVALID_RUN', 'Not a search run');
    if (
      ['COMPLETED', 'PARTIAL', 'NO_RESULTS', 'FAILED', 'CANCELLED'].includes(
        run.status,
      )
    )
      return run.output;
    const input = SearchRequestSchema.parse(
      run.kind === 'research' ? run.input.search : run.input,
    );
    await this.runs.transition(run, 'RUNNING');

    try {
      for (const [queryIndex, query] of input.queries.entries()) {
        if (signal?.aborted)
          throw new SearchError('CANCELLED', 'Search cancelled', 409);
        heartbeat();
        const completed = await this.db.query(
          "SELECT status FROM search_queries WHERE run_id=$1 AND query_index=$2 AND status IN ('COMPLETED','PARTIAL')",
          [run.id, queryIndex],
        );
        if (completed.length) continue;
        let results: SearchResult[] = [];
        let codes: string[] = [];
        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await this.client.search(query, input, signal);
            results = mapSearxng(response, query);
            if (response.unresponsive_engines?.length)
              codes.push('ENGINE_PARTIAL_FAILURE');
            success = true;
            break;
          } catch (error) {
            if (error instanceof SearchError && error.code === 'CANCELLED')
              throw error;
            if (
              !(error instanceof SearchError) ||
              !error.retryable ||
              attempt === 2
            ) {
              codes = [
                error instanceof SearchError ? error.code : 'SEARCH_FAILED',
              ];
              break;
            }
            await delay(error.retryAfterMs ?? 1000 * 2 ** attempt, undefined, {
              signal,
            });
          }
        }

        await this.db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO search_queries(run_id,query_index,query,status,warning_codes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,query_index) DO UPDATE SET status=EXCLUDED.status,warning_codes=EXCLUDED.warning_codes',
            [
              run.id,
              queryIndex,
              query,
              success ? (codes.length ? 'PARTIAL' : 'COMPLETED') : 'FAILED',
              JSON.stringify(codes),
            ],
          );
          for (const result of results)
            await tx.query(
              'INSERT INTO search_results(id,run_id,query_index,canonical_url,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,query_index,canonical_url) DO UPDATE SET data=EXCLUDED.data',
              [randomUUID(), run.id, queryIndex, result.canonicalUrl, result],
            );
        });
      }
      const outcomes = await this.db.query<{
        status: string;
        warning_codes: string[];
      }>('SELECT status,warning_codes FROM search_queries WHERE run_id=$1', [
        run.id,
      ]);
      const failed = outcomes.filter((row) => row.status === 'FAILED').length;
      const warnings = outcomes.flatMap((row) => row.warning_codes);
      const candidates = await this.candidates(run, input.maxCandidates);
      const status =
        failed === input.queries.length
          ? 'FAILED'
          : warnings.length
            ? 'PARTIAL'
            : candidates.length
              ? 'COMPLETED'
              : 'NO_RESULTS';
      const output = { status, candidates, warnings: [...new Set(warnings)] };
      if (run.kind === 'search')
        await this.runs.transition(run, status, output);
      return output;
    } catch (error) {
      if (signal?.aborted) await this.runs.transition(run, 'CANCELLED');
      // Let Temporal retry infrastructure failures; reconciliation records exhausted workflows.
      throw error;
    }
  }
  async finishDiscovery(
    job: RunJob,
    status: 'FAILED' | 'NO_RESULTS',
    output: unknown,
  ) {
    const run = await this.runs.get(job.runId, job.tenantId, job.projectId);
    if (run.kind === 'research')
      await this.runs.transition(run, status, output);
  }
  private async candidates(run: Run, limit: number) {
    const rows = await this.runs.results(run);
    const unique = new Map<
      string,
      { id: string; url: string; title: string; score: number }
    >();
    for (const row of rows) {
      const result = row.data as SearchResult;
      const score = 1 / result.rank;
      const prior = unique.get(result.canonicalUrl);
      if (prior) prior.score += score;
      else
        unique.set(result.canonicalUrl, {
          id: row.id as string,
          url: result.originalUrl,
          title: result.title,
          score,
        });
    }
    return [...unique.values()]
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
      .slice(0, limit);
  }
}
