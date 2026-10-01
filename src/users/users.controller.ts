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

@Controller('users')
@UseGuards(UserAccessGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.users.create(CreateUserSchema.parse(body));
  }

  @Get()
  list(@Query() query: unknown) {
    return this.users.list(UserListSchema.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(UserIdSchema.parse(id));
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.users.update(
      UserIdSchema.parse(id),
      UpdateUserSchema.parse(body),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.users.delete(UserIdSchema.parse(id));
  }
}
