import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigurationService } from '../config/configuration';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigurationService) {
    const schema =
      new URL(config.value.databaseUrl).searchParams.get('schema') ?? 'public';
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.value.databaseUrl,
          max: 10,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
        },
        { schema, onPoolError: () => undefined },
      ),
      transactionOptions: { maxWait: 5000, timeout: 10000 },
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
