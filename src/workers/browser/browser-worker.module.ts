import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration';
import { PersistenceModule } from '../../persistence/persistence.module';
import { BrowserExecutionModule } from '../../browser/browser-execution.module';
@Module({
  imports: [
    ConfigurationModule.forRole('browser'),
    PersistenceModule,
    BrowserExecutionModule,
  ],
})
export class BrowserWorkerModule {}
