import { Module } from '@nestjs/common';
import { BrowserController } from './controllers/browser.controller';
import { BrowserRunsService } from './services/browser-runs.service';
@Module({ controllers: [BrowserController], providers: [BrowserRunsService] })
export class BrowserApiModule {}
