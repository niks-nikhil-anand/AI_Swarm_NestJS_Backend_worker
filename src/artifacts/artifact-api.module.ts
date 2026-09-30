import { Module } from '@nestjs/common';
import { ArtifactModule } from './artifact.module';
import { ArtifactController } from './artifact.controller';
@Module({ imports: [ArtifactModule], controllers: [ArtifactController] })
export class ArtifactApiModule {}
