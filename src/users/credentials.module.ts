import { Module } from '@nestjs/common';
import { PrismaModule } from '../persistence/prisma.module';
import { PasswordService } from './password.service';
import { UserLockService } from './user-lock.service';
@Module({
  imports: [PrismaModule],
  providers: [PasswordService, UserLockService],
  exports: [PrismaModule, PasswordService, UserLockService],
})
export class CredentialsModule {}
