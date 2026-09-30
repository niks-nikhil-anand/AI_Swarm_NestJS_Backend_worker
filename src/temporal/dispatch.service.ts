import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RunRepository, type Run } from '../persistence/run.repository';
import { TemporalService } from './temporal.service';

@Injectable()
export class DispatchService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running=false;
  private stopped=false;
  constructor(private readonly runs:RunRepository,private readonly temporal:TemporalService){}
  onModuleInit(){this.timer=setInterval(()=>void this.reconcile(),5000);this.timer.unref();}
  onModuleDestroy(){this.stopped=true;if(this.timer)clearInterval(this.timer);}
  async enqueue(run:Run){
    if(run.status!=='QUEUED'||run.dispatch_state==='DISPATCHED')return;
    try{await this.temporal.start(run);await this.runs.markDispatched(run);}
    catch{/* PENDING rows are reconciled after dependency recovery. */}
  }
  private async reconcile(){
    if(this.running||this.stopped)return;
    this.running=true;
    try{
      for(const run of await this.runs.pending()){if(this.stopped)break;await this.enqueue(run);}
      for(const run of await this.runs.active()){
        if(this.stopped)break;
        try{
          const status=await this.temporal.status(run);
          if(status==='CANCELLED')await this.runs.transition(run,'CANCELLED');
          else if(['FAILED','TIMED_OUT','TERMINATED'].includes(status))
            await this.runs.transition(run,'FAILED',{status:'FAILED',warnings:['WORKFLOW_'+status]});
        }catch{/* A dependency outage does not establish run failure. */}
      }
    }catch{/* Readiness reports dependency failures without credential leakage. */}
    finally{this.running=false;}
  }
}
