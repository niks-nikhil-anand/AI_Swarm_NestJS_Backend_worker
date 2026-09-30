import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration';
import { PersistenceModule } from '../../persistence/persistence.module';
import { SearchExecutionModule } from '../../search/search-execution.module';
@Module({
  imports: [
    ConfigurationModule.forRole('search'),
    PersistenceModule,
    SearchExecutionModule,
  ],
})
export class SearxngWorkerModule {}
