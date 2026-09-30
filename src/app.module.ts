import { ResearchModule } from './research/research.module';
import { BrowserApiModule } from './browser/browser-api.module';
import { ArtifactApiModule } from './artifacts/artifact-api.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigurationModule } from './config/configuration';
import { SecurityModule } from './security/security.module';
import { PersistenceModule } from './persistence/persistence.module';
import { TemporalModule } from './temporal/temporal.module';
import { SearchModule } from './search/search.module';
import { HealthModule } from './health/health.module';
@Module({
  imports: [
    ConfigurationModule.forRole('api'),
    SecurityModule,
    PersistenceModule,
    TemporalModule,
    SearchModule,
    HealthModule,
    BrowserApiModule,
    ArtifactApiModule,
    ResearchModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
