import { UserLockService } from './user-lock.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import { ServiceError } from '../common/errors/service.error';
import { PasswordService } from './password.service';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserListInput,
} from './contracts/user-request';

// Explicit selection prevents password hashes and OAuth tokens from reaching responses.
const publicUser = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly db: PrismaService,
    private readonly passwords: PasswordService,
    private readonly locks: UserLockService,
  ) {}

  async create(input: CreateUserInput) {
    const password = await this.passwords.hash(input.password);
    try {
      return await this.db.user.create({
        data: { ...input, password },
        select: publicUser,
      });
    } catch (error) {
      return this.databaseError(error);
    }
  }

  async get(id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      select: publicUser,
    });
    if (!user) throw new ServiceError('USER_NOT_FOUND', 'User not found', 404);
    return user;
  }

  async list({ skip, take }: UserListInput) {
    const [data, total] = await this.db.$transaction(
      [
        this.db.user.findMany({
          select: publicUser,
          skip,
          take,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
        this.db.user.count(),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { data, total, skip, take };
  }

  async update(id: string, input: UpdateUserInput) {
    const data = { ...input };
    if (input.password !== undefined)
      data.password = await this.passwords.hash(input.password);
    try {
      return await this.db.$transaction(async (tx) => {
        await this.locks.lock(tx, id);
        const current = await tx.user.findUnique({ where: { id } });
        if (!current)
          throw new ServiceError('USER_NOT_FOUND', 'User not found', 404);
        const sensitive =
          input.password !== undefined ||
          (input.email !== undefined && input.email !== current.email);
        const user = await tx.user.update({
          where: { id },
          data: {
            ...data,
            ...(sensitive ? { credentialVersion: { increment: 1 } } : {}),
          },
          select: publicUser,
        });
        if (sensitive)
          await tx.authSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        return user;
      });
    } catch (error) {
      return this.databaseError(error);
    }
  }

  async delete(id: string) {
    try {
      await this.db.user.delete({ where: { id }, select: { id: true } });
    } catch (error) {
      this.databaseError(error);
    }
  }

  private databaseError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        throw new ServiceError('EMAIL_IN_USE', 'Email is already in use', 409);
      if (error.code === 'P2025')
        throw new ServiceError('USER_NOT_FOUND', 'User not found', 404);
    }
    throw error;
  }
}
