import { Module } from '@nestjs/common';
import { BrowserModule } from './browser.module';
import { ArtifactModule } from '../artifacts/artifact.module';
import { BrowserExecutionService } from './browser-execution.service';
@Module({
  imports: [BrowserModule, ArtifactModule],
  providers: [BrowserExecutionService],
  exports: [BrowserExecutionService, BrowserModule],
})
export class BrowserExecutionModule {}
