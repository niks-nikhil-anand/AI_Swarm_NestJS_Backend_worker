import { Module } from '@nestjs/common';
import { CredentialsModule } from './credentials.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserAccessGuard } from './user-access.guard';

@Module({
  imports: [CredentialsModule],
  controllers: [UsersController],
  providers: [UsersService, UserAccessGuard],
})
export class UsersModule {}
