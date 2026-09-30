import { config } from 'dotenv';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfiguration } from '../../config/configuration';
async function main() {
  config({ quiet: true });
  const settings = loadConfiguration('orchestration');
  const connection = await NativeConnection.connect({
    address: settings.temporal.address,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: settings.temporal.namespace,
      taskQueue: settings.temporal.orchestrationQueue,
      workflowsPath: require.resolve('../../workflows/index'),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
void main().catch(() => {
  console.error(
    'Orchestration worker stopped: dependency or configuration failure',
  );
  process.exitCode = 1;
});
