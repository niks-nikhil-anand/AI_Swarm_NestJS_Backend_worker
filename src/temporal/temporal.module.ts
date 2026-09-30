import { Global, Module } from '@nestjs/common';
import { TemporalService } from './temporal.service';
import { DispatchService } from './dispatch.service';
@Global()
@Module({
  providers: [TemporalService, DispatchService],
  exports: [TemporalService, DispatchService],
})
export class TemporalModule {}
