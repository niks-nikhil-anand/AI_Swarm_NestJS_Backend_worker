import { Module } from '@nestjs/common';
import { ArtifactService } from './artifact.service';
import { LocalStorage } from './storage/local.storage';
@Module({
  providers: [ArtifactService, LocalStorage],
  exports: [ArtifactService],
})
export class ArtifactModule {}
