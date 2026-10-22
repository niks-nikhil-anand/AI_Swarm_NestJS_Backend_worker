import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import { ConfigurationService } from '../config/configuration';
import { PasswordService } from '../users/password.service';
import { UserLockService } from '../users/user-lock.service';
import { ServiceError } from '../common/errors/service.error';
import { publicUser, tokenHash, type AuthIdentity } from './auth.constants';
import type { CreateUserInput } from '../users/contracts/user-request';
import type { UpdateMeInput } from './contracts/auth-request';

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private cleaning = false;
  private readonly logger = new Logger('Auth');
  constructor(
    private readonly db: PrismaService,
    private readonly passwords: PasswordService,
    private readonly locks: UserLockService,
    private readonly config: ConfigurationService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.cleanup(), 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const cutoff = new Date(Date.now() - 7 * 86400000);
      await this.db.authSession.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
        },
      });
    } catch {
      this.logger.warn('Session cleanup unavailable');
    } finally {
      this.cleaning = false;
    }
  }
  private event(event: string, userId?: string) {
    this.logger.log(JSON.stringify({ event, userId }));
  }
  private invalid() {
    return new ServiceError('INVALID_CREDENTIALS', 'Invalid credentials', 401);
  }
  private mapError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new ServiceError('EMAIL_IN_USE', 'Email is already in use', 409);
    throw error;
  }
  private async issue(
    tx: Prisma.TransactionClient,
    userId: string,
    version: number,
  ) {
    const now = new Date();
    const active = await tx.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const revoke = active.slice(
      0,
      Math.max(0, active.length - this.config.value.auth.maxActiveSessions + 1),
    );
    if (revoke.length)
      await tx.authSession.updateMany({
        where: { id: { in: revoke.map((s) => s.id) } },
        data: { revokedAt: now },
      });
    const accessToken = `swu_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(
      now.getTime() + this.config.value.auth.sessionTtlSeconds * 1000,
    );
    await tx.authSession.create({
      data: {
        userId,
        credentialVersion: version,
        tokenHash: tokenHash(accessToken),
        expiresAt,
      },
    });
    return { accessToken, tokenType: 'Bearer', expiresAt };
  }
  async register(input: CreateUserInput) {
    const password = await this.passwords.hash(input.password);
    try {
      const result = await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { ...input, password },
          select: publicUser,
        });
        return { user, ...(await this.issue(tx, user.id, 0)) };
      });
      this.event('registered', result.user.id);
      return result;
    } catch (error) {
      return this.mapError(error);
    }
  }
  async login(input: { email: string; password: string }) {
    const snapshot = await this.db.user.findUnique({
      where: { email: input.email },
    });
    const verified = await this.passwords.verify(
      input.password,
      snapshot?.password ?? null,
    );
    if (!verified || !snapshot || snapshot.deletedAt || snapshot.disabledAt) {
      this.event('login_failed');
      throw this.invalid();
    }
    const result = await this.db.$transaction(async (tx) => {
      await this.locks.lock(tx, snapshot.id);
      const current = await tx.user.findUnique({ where: { id: snapshot.id } });
      if (
        !current ||
        current.deletedAt ||
        current.disabledAt ||
        current.credentialVersion !== snapshot.credentialVersion ||
        current.password !== snapshot.password
      )
        throw this.invalid();
      const user = await tx.user.findUniqueOrThrow({
        where: { id: current.id },
        select: publicUser,
      });
      return {
        user,
        ...(await this.issue(tx, current.id, current.credentialVersion)),
      };
    });
    this.event('login_succeeded', result.user.id);
    return result;
  }
  async authenticate(token: string): Promise<AuthIdentity> {
    const session = await this.db.authSession.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.deletedAt ||
      session.user.disabledAt ||
      session.credentialVersion !== session.user.credentialVersion
    )
      throw new ServiceError('SESSION_INVALID', 'Invalid session', 401);
    return {
      userId: session.userId,
      sessionId: session.id,
      credentialVersion: session.credentialVersion,
    };
  }
  // Lock and recheck the session immediately before consequential writes.
  private async requireCurrent(
    tx: Prisma.TransactionClient,
    identity: AuthIdentity,
  ) {
    await this.locks.lock(tx, identity.userId);
    const user = await tx.user.findUnique({ where: { id: identity.userId } });
    const session = await tx.authSession.findUnique({
      where: { id: identity.sessionId },
    });
    if (
      !user ||
      user.deletedAt ||
      user.disabledAt ||
      user.credentialVersion !== identity.credentialVersion ||
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    )
      throw new ServiceError('SESSION_INVALID', 'Invalid session', 401);
    return user;
  }
  async logout(token?: string) {
    if (!token) return;
    // Serialize with writes/login so a completed logout cannot race a later mutation.
    const session = await this.db.authSession.findUnique({
      where: { tokenHash: tokenHash(token) },
    });
    if (session)
      await this.db.$transaction(async (tx) => {
        await this.locks.lock(tx, session.userId);
        await tx.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
    this.event('logout');
  }
  async logoutAll(identity: AuthIdentity) {
    await this.db.$transaction(async (tx) => {
      await this.requireCurrent(tx, identity);
      await tx.user.update({
        where: { id: identity.userId },
        data: { credentialVersion: { increment: 1 } },
      });
      await tx.authSession.updateMany({
        where: { userId: identity.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    this.event('logout_all', identity.userId);
  }
  async me(identity: AuthIdentity) {
    // Recheck active state/version; return an explicit public field selection.
    const user = await this.db.user.findFirst({
      where: {
        id: identity.userId,
        deletedAt: null,
        disabledAt: null,
        credentialVersion: identity.credentialVersion,
      },
      select: publicUser,
    });
    if (!user)
      throw new ServiceError('SESSION_INVALID', 'Invalid session', 401);
    return user;
  }
  private async confirm(identity: AuthIdentity, password?: string) {
    const snapshot = await this.db.user.findUnique({
      where: { id: identity.userId },
    });
    const valid = await this.passwords.verify(
      password ?? '',
      snapshot?.password ?? null,
    );
    if (
      !password ||
      !valid ||
      !snapshot ||
      snapshot.credentialVersion !== identity.credentialVersion
    )
      throw new ServiceError(
        'REAUTHENTICATION_FAILED',
        'Reauthentication failed',
        401,
      );
    return snapshot;
  }
  async update(identity: AuthIdentity, input: UpdateMeInput) {
    const snapshot = await this.db.user.findUnique({
      where: { id: identity.userId },
    });
    if (!snapshot)
      throw new ServiceError('SESSION_INVALID', 'Invalid session', 401);
    const sensitive =
      input.newPassword !== undefined ||
      (input.email !== undefined && input.email !== snapshot.email);
    if (sensitive) await this.confirm(identity, input.currentPassword);
    const password =
      input.newPassword === undefined
        ? undefined
        : await this.passwords.hash(input.newPassword);
    try {
      const user = await this.db.$transaction(async (tx) => {
        await this.requireCurrent(tx, identity);
        const user = await tx.user.update({
          where: { id: identity.userId },
          data: {
            name: input.name,
            avatar: input.avatar,
            email: input.email,
            password,
            ...(sensitive ? { credentialVersion: { increment: 1 } } : {}),
          },
          select: publicUser,
        });
        if (sensitive)
          await tx.authSession.updateMany({
            where: { userId: identity.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        return user;
      });
      this.event(
        sensitive ? 'credentials_changed' : 'profile_changed',
        identity.userId,
      );
      return { user, reauthenticationRequired: sensitive };
    } catch (error) {
      return this.mapError(error);
    }
  }
  async delete(identity: AuthIdentity, currentPassword: string) {
    await this.confirm(identity, currentPassword);
    await this.db.$transaction(async (tx) => {
      await this.requireCurrent(tx, identity);
      await tx.user.update({
        where: { id: identity.userId },
        data: { deletedAt: new Date(), credentialVersion: { increment: 1 } },
      });
      await tx.authSession.updateMany({
        where: { userId: identity.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    this.event('account_deleted', identity.userId);
  }
}
