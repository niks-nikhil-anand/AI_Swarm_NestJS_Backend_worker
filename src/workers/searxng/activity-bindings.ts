import { Context, ApplicationFailure } from '@temporalio/activity';
import {
  SearchExecutionService,
  RunJob,
} from '../../search/search-execution.service';
import { ServiceError } from '../../common/errors/service.error';

export function searchActivities(service: SearchExecutionService) {
  return {
    finishDiscovery: (
      job: RunJob,
      status: 'FAILED' | 'NO_RESULTS',
      output: unknown,
    ) => service.finishDiscovery(job, status, output),
    async executeSearch(job: RunJob) {
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), 5000);
      try {
        return await service.execute(job, context.cancellationSignal, () =>
          context.heartbeat(),
        );
      } catch (error) {
        throw ApplicationFailure.create({
          message:
            error instanceof ServiceError
              ? error.message
              : 'Search activity failed',
          type: error instanceof ServiceError ? error.code : 'SEARCH_FAILED',
          nonRetryable: error instanceof ServiceError && !error.retryable,
        });
      } finally {
        clearInterval(timer);
      }
    },
  };
}
