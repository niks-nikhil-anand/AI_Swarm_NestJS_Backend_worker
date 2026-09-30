import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  record(
    event: string,
    ids: {
      tenantId?: string;
      projectId?: string;
      runId?: string;
      actionId?: string;
    },
    outcome: string,
  ) {
    // Whitelisted fields only: no queries, tokens, page text, URLs or credentials.
    this.logger.log(
      JSON.stringify({ event, ...ids, outcome, at: new Date().toISOString() }),
    );
  }
}
