import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { schemaRef, demoCredentials } from '../openapi/user-api.schemas';
import {
  authCommonErrors,
  authUnauthorized,
  emailConflict,
  noStoreHeaders,
} from '../openapi/user-api.decorators';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  AuthSessionGuard,
  type AuthenticatedRequest,
} from './auth-session.guard';
import { AuthRequestGuard } from './auth-request.guard';
import { bearer } from './auth.constants';
import {
  DeleteMeSchema,
  LoginSchema,
  RegisterSchema,
  UpdateMeSchema,
} from './contracts/auth-request';

@ApiTags('Authentication')
@authCommonErrors()
@Controller('auth')
@UseGuards(AuthRequestGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @ApiOperation({
    summary: 'Register a user and create a session',
    description:
      'Public endpoint. Use a fresh email. Copy accessToken from the response into Authorize → user-session.',
    security: [],
  })
  @ApiBody({ schema: schemaRef('RegisterRequest') })
  @ApiResponse({
    status: 201,
    description: 'User registered and session issued.',
    schema: schemaRef('AuthSessionResponse'),
    headers: noStoreHeaders,
  })
  @emailConflict()
  @Post('register')
  register(@Body() body: unknown) {
    return this.auth.register(RegisterSchema.parse(body));
  }
  @ApiOperation({
    summary: 'Log in and create a session',
    description:
      'Public endpoint. Unknown email, wrong password and unavailable accounts receive the same invalid-credentials response.',
    security: [],
  })
  @ApiBody({ schema: schemaRef('LoginRequest') })
  @ApiResponse({
    status: 200,
    description: 'Session issued. Authorize using the returned accessToken.',
    schema: schemaRef('AuthSessionResponse'),
    headers: noStoreHeaders,
  })
  @authUnauthorized()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(LoginSchema.parse(body));
  }
  @ApiOperation({
    summary: 'Log out the current session',
    description:
      'Revokes only the presented token. Missing, unknown and already-revoked tokens are no-ops. Clear user-session in Authorize afterward.',
    security: [{}, { 'user-session': [] }],
  })
  @ApiResponse({
    status: 204,
    description: 'Logged out; empty response.',
    headers: noStoreHeaders,
  })
  @Post('logout')
  @HttpCode(204)
  async logout(@Headers('authorization') header?: string) {
    await this.auth.logout(bearer(header));
  }
  @ApiOperation({
    summary: 'Log out every session for the current user',
    description:
      'Revokes all sessions including this token. Log in again to continue.',
  })
  @ApiBearerAuth('user-session')
  @ApiResponse({
    status: 204,
    description: 'All current-user sessions revoked; empty response.',
    headers: noStoreHeaders,
  })
  @authUnauthorized()
  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(AuthSessionGuard)
  async logoutAll(@Req() req: AuthenticatedRequest) {
    await this.auth.logoutAll(req.auth);
  }
  @ApiOperation({
    summary: 'Get the current user',
    description:
      'Returns the bearer token owner only. Password hashes, provider credentials and internal session fields are excluded.',
  })
  @ApiBearerAuth('user-session')
  @ApiResponse({
    status: 200,
    description: 'Current public user profile.',
    schema: schemaRef('PublicUser'),
    headers: noStoreHeaders,
  })
  @authUnauthorized()
  @Get('me')
  @UseGuards(AuthSessionGuard)
  me(@Req() req: AuthenticatedRequest) {
    return this.auth.me(req.auth);
  }
  @ApiOperation({
    summary: 'Update the current user',
    description:
      'Partial update: omitted fields are unchanged; name/avatar accept null. Effective email or password changes require currentPassword and revoke every session. If reauthenticationRequired is true, log in and authorize again.',
  })
  @ApiBearerAuth('user-session')
  @ApiBody({
    schema: schemaRef('UpdateMeRequest'),
    examples: {
      profile: {
        summary: 'Change profile; keep sessions',
        value: { name: 'Updated Name', avatar: null },
      },
      password: {
        summary: 'Change password; log in again afterward',
        value: {
          currentPassword: demoCredentials.password,
          newPassword: 'NewExamplePassword123!',
        },
      },
      email: {
        summary: 'Change email; log in again afterward',
        value: {
          email: 'new-address@example.com',
          currentPassword: demoCredentials.password,
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Updated user and reauthentication flag.',
    schema: schemaRef('UpdateMeResponse'),
    headers: noStoreHeaders,
  })
  @authUnauthorized()
  @emailConflict()
  @Put('me')
  @UseGuards(AuthSessionGuard)
  update(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.auth.update(req.auth, UpdateMeSchema.parse(body));
  }
  @ApiOperation({
    summary: 'Delete (deactivate) the current account',
    description:
      'Requires currentPassword. Marks the account deleted and revokes all sessions. The email stays reserved; retained data is not immediately erased.',
  })
  @ApiBearerAuth('user-session')
  @ApiBody({ schema: schemaRef('DeleteAccountRequest') })
  @ApiResponse({
    status: 204,
    description: 'Account deactivated and sessions revoked; empty response.',
    headers: noStoreHeaders,
  })
  @authUnauthorized()
  @Delete('me')
  @HttpCode(204)
  @UseGuards(AuthSessionGuard)
  async delete(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    await this.auth.delete(
      req.auth,
      DeleteMeSchema.parse(body).currentPassword,
    );
  }
}
