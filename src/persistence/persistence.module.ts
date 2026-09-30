import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RunRepository } from './run.repository';
@Global()
@Module({
  providers: [DatabaseService, RunRepository],
  exports: [DatabaseService, RunRepository],
})
export class PersistenceModule {}
