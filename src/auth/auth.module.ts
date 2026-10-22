import { Module } from '@nestjs/common';
import { CredentialsModule } from '../users/credentials.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionGuard } from './auth-session.guard';
import { AuthRequestGuard } from './auth-request.guard';
@Module({
  imports: [CredentialsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionGuard, AuthRequestGuard],
})
export class AuthModule {}
