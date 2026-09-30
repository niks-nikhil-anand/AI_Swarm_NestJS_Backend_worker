import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../persistence/database.service';
import { TemporalService } from '../temporal/temporal.service';
import { SearxngClient } from '../search/clients/searxng.client';
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly temporal: TemporalService,
    private readonly search: SearxngClient,
  ) {}
  @Get('live') live() {
    return { status: 'alive' };
  }
  @Get('ready') async ready() {
    const [database, temporal, search] = await Promise.all([
      this.db
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      this.temporal.healthy(),
      this.search.healthy(),
    ]);
    const result = {
      status: database && temporal && search ? 'ready' : 'unavailable',
      database,
      temporal,
      search,
    };
    if (result.status !== 'ready')
      throw new ServiceUnavailableException(result);
    return result;
  }
}
