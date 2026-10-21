import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { schemaRef } from '../openapi/user-api.schemas';
import { errorResponse, emailConflict } from '../openapi/user-api.decorators';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UserAccessGuard } from './user-access.guard';
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserIdSchema,
  UserListSchema,
} from './contracts/user-request';

@ApiTags('Users (admin)')
@ApiBearerAuth('admin-token')
@errorResponse(400, 'Invalid body, user ID or pagination parameters.')
@errorResponse(
  401,
  'Missing or invalid configured administrative bearer token.',
)
@errorResponse(
  403,
  'The configured principal lacks users capability. User login tokens are not administrative tokens.',
)
@errorResponse(500, 'Database or internal failure; details are redacted.')
@Controller('users')
@UseGuards(UserAccessGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({
    summary: 'Create a user (admin)',
    description:
      'Creates a user without issuing an end-user session. Use /auth/register for self-service registration.',
  })
  @ApiBody({ schema: schemaRef('RegisterRequest') })
  @ApiResponse({
    status: 201,
    description: 'Created public user.',
    schema: schemaRef('PublicUser'),
  })
  @emailConflict()
  @errorResponse(503, 'Password hashing capacity is temporarily exhausted.')
  @Post()
  create(@Body() body: unknown) {
    return this.users.create(CreateUserSchema.parse(body));
  }

  @ApiOperation({ summary: 'List users (admin)' })
  @ApiQuery({
    name: 'skip',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
  })
  @ApiQuery({
    name: 'take',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated public users.',
    schema: schemaRef('UserPage'),
  })
  @Get()
  list(@Query() query: unknown) {
    return this.users.list(UserListSchema.parse(query));
  }

  @ApiOperation({
    summary: 'Get a user by ID (admin)',
    description:
      'For the logged-in user profile, use GET /auth/me with user-session instead.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', minLength: 1, maxLength: 100 },
  })
  @ApiResponse({
    status: 200,
    description: 'Public user profile.',
    schema: schemaRef('PublicUser'),
  })
  @errorResponse(404, 'User not found.')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(UserIdSchema.parse(id));
  }

  @ApiOperation({
    summary: 'Update a user (admin)',
    description:
      'Partial update. Administrative email/password changes revoke all user sessions. Uses password, not newPassword, for administrative password changes.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', minLength: 1, maxLength: 100 },
  })
  @ApiBody({ schema: schemaRef('UpdateUserRequest') })
  @ApiResponse({
    status: 200,
    description: 'Updated public user.',
    schema: schemaRef('PublicUser'),
  })
  @errorResponse(404, 'User not found.')
  @emailConflict()
  @errorResponse(503, 'Password hashing capacity is temporarily exhausted.')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.users.update(
      UserIdSchema.parse(id),
      UpdateUserSchema.parse(body),
    );
  }

  @ApiOperation({
    summary: 'Permanently delete a user (admin)',
    description:
      'Physically deletes this user and linked OAuth accounts/sessions. For self-service deactivation use DELETE /auth/me.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', minLength: 1, maxLength: 100 },
  })
  @ApiResponse({ status: 204, description: 'User removed; empty response.' })
  @errorResponse(404, 'User not found.')
  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.users.delete(UserIdSchema.parse(id));
  }
}
