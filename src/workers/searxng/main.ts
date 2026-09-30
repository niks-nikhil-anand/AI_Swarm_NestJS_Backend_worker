import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { SearxngWorkerModule } from './searxng-worker.module';
import { ConfigurationService } from '../../config/configuration';
import { SearchExecutionService } from '../../search/search-execution.service';
import { searchActivities } from './activity-bindings';

async function main() {
  const app = await NestFactory.createApplicationContext(SearxngWorkerModule);
  const config = app.get(ConfigurationService).value;
  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect({
      address: config.temporal.address,
    });
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.searchQueue,
      activities: searchActivities(app.get(SearchExecutionService)),
      maxConcurrentActivityTaskExecutions: config.search.concurrency,
    });
    await worker.run();
  } finally {
    await connection?.close();
    await app.close();
  }
}
void main().catch(() => {
  console.error('Search worker stopped: dependency or configuration failure');
  process.exitCode = 1;
});
