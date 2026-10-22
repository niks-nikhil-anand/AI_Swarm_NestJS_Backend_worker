import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RunRepository } from './run.repository';
import { ApprovalRepository } from './approval.repository';
@Global()
@Module({
  providers: [DatabaseService, RunRepository, ApprovalRepository],
  exports: [DatabaseService, RunRepository, ApprovalRepository],
})
export class PersistenceModule {}
