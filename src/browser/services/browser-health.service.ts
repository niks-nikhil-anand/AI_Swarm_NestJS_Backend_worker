import { Injectable } from '@nestjs/common';
import { SessionManagerService } from './session-manager.service';
@Injectable()
export class BrowserHealthService {
  constructor(private readonly sessions: SessionManagerService) {}
  snapshot() {
    return { activeSessions: this.sessions.count() };
  }
}
