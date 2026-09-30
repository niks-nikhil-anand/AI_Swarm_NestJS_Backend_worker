import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client';
import { ConfigurationService } from '../config/configuration';
import { Run } from '../persistence/run.repository';

@Injectable()
export class TemporalService implements OnModuleDestroy {
  private connection?: Connection;
  private pending?: Promise<Client>;
  constructor(private readonly config: ConfigurationService) {}
  client(): Promise<Client> {
    if (!this.pending)
      this.pending = Connection.connect({
        address: this.config.value.temporal.address,
        connectTimeout: '5 seconds',
      })
        .then((connection) => {
          this.connection = connection;
          return new Client({
            connection,
            namespace: this.config.value.temporal.namespace,
          });
        })
        .catch((error) => {
          this.pending = undefined;
          throw error;
        });
    return this.pending;
  }
  async start(run: Run) {
    const client = await this.client();
    try {
      await client.workflow.start(run.kind + 'Workflow', {
        taskQueue: this.config.value.temporal.orchestrationQueue,
        workflowId: 'swarm-' + run.id,
        args: [
          {
            runId: run.id,
            tenantId: run.tenant_id,
            projectId: run.project_id,
            searchQueue: this.config.value.temporal.searchQueue,
            browserQueue: this.config.value.temporal.browserQueue,
          },
        ],
        workflowExecutionTimeout: '30 minutes',
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }
  async cancel(run: Run) {
    await (await this.client()).workflow.getHandle('swarm-' + run.id).cancel();
  }
  async status(run: Run) { return (await (await this.client()).workflow.getHandle('swarm-' + run.id).describe()).status.name; }
  async healthy() {
    try {
      await (await this.client()).workflowService.getSystemInfo({});
      return true;
    } catch {
      return false;
    }
  }
  async onModuleDestroy() {
    await this.connection?.close();
  }
}
