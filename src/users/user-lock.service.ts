import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConfigurationService } from '../config/configuration';

@Injectable()
export class UserLockService {
  private readonly table: Prisma.Sql;
  constructor(config: ConfigurationService) {
    const schema =
      new URL(config.value.databaseUrl).searchParams.get('schema') ?? 'public';
    // Only an escaped identifier is interpolated; user IDs are query parameters.
    this.table = Prisma.raw(`"${schema.replaceAll('"', '""')}"."users"`);
  }
  async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM ${this.table} WHERE id = ${id} FOR UPDATE`,
    );
  }
}
