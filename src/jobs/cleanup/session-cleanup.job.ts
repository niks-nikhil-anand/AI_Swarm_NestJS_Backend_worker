import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SessionManagerService } from '../../browser/services/session-manager.service';
@Injectable()
export class SessionCleanupJob implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly sessions: SessionManagerService) {}
  onModuleInit() {
    this.timer = setInterval(
      () => void this.sessions.cleanupExpired().catch(() => undefined),
      30000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
