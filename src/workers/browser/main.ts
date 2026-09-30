import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { BrowserWorkerModule } from './browser-worker.module';
import { ConfigurationService } from '../../config/configuration';
import { BrowserExecutionService } from '../../browser/browser-execution.service';
import { browserActivities } from './activity-bindings';
async function main() {
  const app = await NestFactory.createApplicationContext(BrowserWorkerModule);
  const settings = app.get(ConfigurationService).value;
  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect({
      address: settings.temporal.address,
    });
    const worker = await Worker.create({
      connection,
      namespace: settings.temporal.namespace,
      taskQueue: settings.temporal.browserQueue,
      activities: browserActivities(app.get(BrowserExecutionService)),
      maxConcurrentActivityTaskExecutions: settings.browser!.concurrency,
    });
    await worker.run();
  } finally {
    await connection?.close();
    await app.close();
  }
}
void main().catch(() => {
  console.error('Browser worker stopped: dependency or configuration failure');
  process.exitCode = 1;
});
