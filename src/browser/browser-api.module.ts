import { Module } from '@nestjs/common';
import { BrowserController } from './controllers/browser.controller';
import { ApprovalsController } from './controllers/approvals.controller';
import { BrowserRunsService } from './services/browser-runs.service';
import { ApprovalsService } from './services/approvals.service';
@Module({
  controllers: [BrowserController, ApprovalsController],
  providers: [BrowserRunsService, ApprovalsService],
})
export class BrowserApiModule {}
