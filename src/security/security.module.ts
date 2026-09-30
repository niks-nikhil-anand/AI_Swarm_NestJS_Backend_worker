import { Global, Module } from '@nestjs/common';
import { ProjectAccessGuard } from '../common/guards/project-access.guard';
import { AuditService } from '../common/logger/audit.service';
@Global()
@Module({
  providers: [ProjectAccessGuard, AuditService],
  exports: [ProjectAccessGuard, AuditService],
})
export class SecurityModule {}
