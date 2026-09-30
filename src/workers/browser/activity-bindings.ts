import { Context, ApplicationFailure } from '@temporalio/activity';
import {
  BrowserExecutionService,
  type BrowserJob,
} from '../../browser/browser-execution.service';
import { ServiceError } from '../../common/errors/service.error';
export function browserActivities(service: BrowserExecutionService) {
  return {
    async executeBrowserTask(job: BrowserJob) {
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
              : 'Browser execution failed',
          type: error instanceof ServiceError ? error.code : 'BROWSER_FAILED',
          nonRetryable: true,
        });
      } finally {
        clearInterval(timer);
      }
    },
  };
}
