import { Module } from '@nestjs/common';
import { PrismaModule } from '../persistence/prisma.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PasswordService } from './password.service';
import { UserAccessGuard } from './user-access.guard';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService, UserAccessGuard],
})
export class UsersModule {}
