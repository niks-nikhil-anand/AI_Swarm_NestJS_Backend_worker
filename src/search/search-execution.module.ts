import { Module } from '@nestjs/common';
import { SearxngClient } from './clients/searxng.client';
import { SearchExecutionService } from './search-execution.service';
@Module({
  providers: [SearxngClient, SearchExecutionService],
  exports: [SearxngClient, SearchExecutionService],
})
export class SearchExecutionModule {}
