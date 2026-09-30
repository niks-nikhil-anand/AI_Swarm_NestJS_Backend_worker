import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { ConfigurationService } from '../config/configuration';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  constructor(config: ConfigurationService) {
    this.pool = new Pool({
      connectionString: config.value.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    this.pool.on('error', () => {
      /* readiness probes report disconnected pools without leaking connection strings */
    });
  }
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(text, values)).rows;
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
