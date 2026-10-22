import { Injectable } from '@nestjs/common';
import { RunRepository, type Run } from '../persistence/run.repository';
import { DatabaseService } from '../persistence/database.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { SessionManagerService } from './services/session-manager.service';
import { BrowserService } from './services/browser.service';
import { randomUUID } from 'node:crypto';
import { BrowserRunRequestSchema } from './contracts/browser-request';
import { resumeBlocked, runBrowserSteps, uncertainSteps, type PriorStep, type StepApproval } from './browser-steps.runner';
import { ApprovalRepository, type Approval } from '../persistence/approval.repository';
import { ConfigurationService } from '../config/configuration';
import { PolicyError } from '../common/errors/policy.errors';
import { ServiceError } from '../common/errors/service.error';
import type { BrowserAction } from './contracts/browser-action';
import type { BrowserSession } from './contracts/browser-session';
import type { RunJob } from '../search/search-execution.service';
import type { ExecutionContext } from '../common/types/execution-context';
import { BrowserError } from '../common/errors/browser.errors';
import { ArticleSchema } from './adapters/playwright/playwright.adapter';
export interface BrowserJob extends RunJob{candidates?:{id:string;url:string}[]}

// Execution lease: renewed with every heartbeat, so it outlives Temporal's 20 s heartbeat
// timeout only while this attempt is alive.
export const LEASE_TTL_MS=30000;
const TERMINAL=['COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED'];
const LEASE_WAIT_MS=LEASE_TTL_MS+5000;
const RENEW_INTERVAL_MS=5000;
// Database errors are infrastructure failures: the attempt stops and Temporal retries it;
// replayable steps rebuild state and recorded non-replayable steps are never repeated.
const asStepApproval=(a:Approval):StepApproval=>({id:a.id,status:a.status,expiresAt:new Date(a.expires_at).toISOString(),payloadHash:a.payload_hash});
const persist=async<T>(work:()=>Promise<T>):Promise<T>=>{
  try{return await work();}
  catch(error){
    if(error instanceof ServiceError)throw error;
    throw new ServiceError('PERSISTENCE_UNAVAILABLE','Run storage is unavailable',503,true);
  }
};

@Injectable()
export class BrowserExecutionService{
  constructor(private readonly runs:RunRepository,private readonly db:DatabaseService,
    private readonly sessions:SessionManagerService,private readonly browser:BrowserService,
    private readonly artifacts:ArtifactService,private readonly approvals:ApprovalRepository,
    private readonly config:ConfigurationService){}

  // Partial result from what is persisted: latest record per step, evidence and extractions.
  private async snapshot(run:Run,status:string,warnings:string[]){
    const [steps,evidence,extractions]=await Promise.all([
      this.db.query("SELECT DISTINCT ON ((data->>'step')::int) (data->>'step')::int AS index,substr(kind,6) AS kind,status,(data->>'attempts')::int AS attempts,(data->>'runAttempt')::int AS \"runAttempt\",data->'error' AS error FROM browser_actions WHERE run_id=$1 AND kind LIKE 'step:%' ORDER BY (data->>'step')::int,sequence DESC",[run.id]),
      this.db.query("SELECT id,url,data->>'retrievedAt' AS \"retrievedAt\" FROM evidence WHERE run_id=$1 ORDER BY created_at",[run.id]),
      this.db.query('SELECT id,step,url,evidence_id AS "evidenceId" FROM extractions WHERE run_id=$1 ORDER BY step',[run.id]),
    ]);
    return {status,partial:true,steps,evidence,extractions,warnings};
  }

  // Waits for a stale lease (owner stopped renewing) instead of running concurrently.
  // Returns the run when another attempt finished it meanwhile.
  private async claim(run:Run,owner:string,signal:AbortSignal|undefined,heartbeat:()=>void){
    const until=Date.now()+LEASE_WAIT_MS;
    while(!(await persist(()=>this.runs.claimLease(run,owner,LEASE_TTL_MS)))){
      const current=await persist(()=>this.runs.get(run.id,run.tenant_id,run.project_id));
      if(TERMINAL.includes(current.status))return current;
      if(Date.now()>until)throw new ServiceError('RUN_BUSY','Another attempt is executing this run',409,true);
      if(signal?.aborted)throw new BrowserError('CANCELLED','Run cancelled',409);
      heartbeat();
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    return undefined;
  }

  // retry: Temporal attempt number, and whether no further attempt follows this one.
  // stop: the worker is shutting down. Unlike `signal` (the run was cancelled), it only ends
  // this attempt: the browser closes, the lease is released and the run stays open for retry.
  async execute(job:BrowserJob,signal?:AbortSignal,heartbeat:()=>void=()=>{},retry={attempt:1,final:true},stop?:AbortSignal){
    const run=await persist(()=>this.runs.get(job.runId,job.tenantId,job.projectId));
    if(!['browser','research'].includes(run.kind))throw new BrowserError('INVALID_RUN','Not a browser run');
    if(['COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED'].includes(run.status))return run.output;
    const actor:ExecutionContext={tenantId:run.tenant_id,projectId:run.project_id,userId:run.user_id,requestId:run.id,capabilities:['browser']};
    const owner=randomUUID();
    let session:BrowserSession|undefined;
    let cancelled=false,leased=false,leaseLost=false,stopping=false;
    const abort=()=>{cancelled=true;if(session)void this.browser.close(session.id).catch(()=>undefined);};
    const halt=()=>{stopping=true;if(session)void this.browser.close(session.id).catch(()=>undefined);};
    // Another attempt took over (this one stalled past the lease): stop without touching the run.
    // Renewal also delivers cancellation: the API marks the run CANCELLED, and this sees it
    // within one interval even while a step (e.g. a slow model call) is in progress, without
    // waiting for Temporal's throttled heartbeat response.
    const renew=async()=>{
      heartbeat();
      if(!leased||leaseLost)return;
      const status=await this.runs.renewLease(run,owner,LEASE_TTL_MS).catch(()=>'UNKNOWN');
      if(status===undefined){
        // A terminal transition releases the lease with it: a run cancelled through the API
        // is a cancellation of this attempt, not a takeover by another one.
        const current=await this.runs.get(run.id,run.tenant_id,run.project_id).catch(()=>undefined);
        if(current?.status==='CANCELLED'){if(!cancelled)abort();return;}
        leaseLost=true;
        if(session)void this.browser.close(session.id).catch(()=>undefined);
      }else if(status==='CANCELLED'&&!cancelled)abort();
    };
    const renewal=setInterval(()=>void renew(),RENEW_INTERVAL_MS);
    // The stored outcome wins when a transition is rejected (e.g. cancelled meanwhile); what
    // this attempt did is kept as that run's output, under the stored status.
    const finish=async<T extends {status:string;warnings?:string[]}>(status:string,output:T)=>{
      if(await persist(()=>this.runs.transition(run,status,output))){
        // A finished run leaves no approval that could still be decided or consumed.
        if(TERMINAL.includes(status))await this.approvals.closeOpen(run,'RUN_'+status).catch(()=>undefined);
        return output;
      }
      const current=await persist(()=>this.runs.get(run.id,run.tenant_id,run.project_id));
      if(current.output==null)
        await persist(()=>this.runs.recordTerminalOutput(run,{...output,status:current.status,warnings:[...(output.warnings||[]),'RUN_'+current.status]}));
      return (await persist(()=>this.runs.get(run.id,run.tenant_id,run.project_id))).output;
    };
    const warnings:string[]=[],evidence:unknown[]=[];
    try{
      const request=BrowserRunRequestSchema.parse(run.kind==='research'?{urls:(job.candidates||[]).map(c=>c.url)}:run.input);
      if(signal?.aborted)throw new BrowserError('CANCELLED','Run cancelled',409);
      const finished=await this.claim(run,owner,signal,heartbeat);
      if(finished)return finished.output;
      leased=true;
      // A run waiting for approval resumes only with an approved, unexpired approval; a
      // rejected, revoked, cancelled or expired one ends it, keeping what completed.
      let approvalResume=false;
      if(run.status==='AWAITING_APPROVAL'){
        let [approval]=await persist(()=>this.approvals.forRun(run));
        if(approval&&['PENDING','APPROVED'].includes(approval.status)&&new Date(approval.expires_at).getTime()<=Date.now())
          approval=(await persist(()=>this.approvals.expireIfDue(approval)))??approval;
        if(approval?.status==='PENDING')return run.output;
        if(approval?.status!=='APPROVED'){
          const output=await persist(()=>this.snapshot(run,'PARTIAL',['APPROVAL_'+(approval?.status??'MISSING')]));
          return finish('PARTIAL',output);
        }
        approvalResume=true;
      }
      if(!(await persist(()=>this.runs.transition(run,'RUNNING'))))
        return (await persist(()=>this.runs.get(run.id,run.tenant_id,run.project_id))).output;
      const prior=await persist(()=>this.db.query<PriorStep>("SELECT (data->>'step')::int AS index,substr(kind,6) AS kind,status,data->>'attemptId' AS \"attemptId\" FROM browser_actions WHERE run_id=$1 AND kind LIKE 'step:%' ORDER BY sequence",[run.id]));
      const [approval]=await persist(()=>this.approvals.forRun(run));
      // A submit step acts only after consuming its approval, so until then its records are
      // not an uncertain outcome. An open approval means the run already reached its submit
      // step with every earlier outcome known (uncertain ones still block below).
      const effective=approval?.status==='CONSUMED'?prior:prior.filter(p=>p.kind!=='submit');
      if(approval&&['PENDING','APPROVED'].includes(approval.status))approvalResume=true;
      if('steps' in request&&resumeBlocked(effective,approvalResume)){
        // An earlier attempt started a step that may have changed state; never replay it.
        const uncertain=uncertainSteps(effective);
        // A consequential action that may have run: its approval outcome is UNKNOWN.
        if(approval?.status==='CONSUMED'&&uncertain.some(p=>p.kind==='submit'))
          await persist(()=>this.approvals.recordOutcome(run,approval.id,'UNKNOWN','attempt ended after the action may have started'));
        const output=await persist(()=>this.snapshot(run,prior.some(p=>p.status==='success')?'PARTIAL':'FAILED',['RESUME_UNSAFE',...(uncertain.length?['OUTCOME_UNKNOWN']:[])]));
        return finish(output.status,output);
      }
      if(stop?.aborted)throw new ServiceError('WORKER_SHUTDOWN','The worker is shutting down',503,true);
      session=await this.sessions.create(actor);
      signal?.addEventListener('abort',abort,{once:true});
      stop?.addEventListener('abort',halt,{once:true});
      if(stop?.aborted)halt();
      let sequence=Number((await persist(()=>this.db.query('SELECT COALESCE(MAX(sequence),0) AS sequence FROM browser_actions WHERE run_id=$1',[run.id])))[0].sequence);
      // Fencing: an attempt that lost the run (it stalled and another took over) stops
      // before its next browser action or write.
      const fence=async()=>{
        await renew();
        if(leaseLost)throw new ServiceError('LEASE_LOST','Another attempt took over this run',409);
      };
      const execute=async(action:BrowserAction)=>{
        await fence();
        if(signal?.aborted||stopping||(await persist(()=>this.runs.get(run.id,run.tenant_id,run.project_id))).status==='CANCELLED')
          throw new BrowserError('CANCELLED','Run cancelled',409);
        const result=await this.browser.execute(session!.id,actor,action);
        await fence();
        await persist(()=>this.db.query('INSERT INTO browser_actions(id,run_id,sequence,kind,status,data) VALUES($1,$2,$3,$4,$5,$6)',
          [result.actionId,run.id,++sequence,action.kind,result.status,JSON.stringify({error:result.error,durationMs:result.durationMs})]));
        if(result.status==='failed')throw new BrowserError(result.error!.code,result.error!.message,400,result.error!.retryable);
        return result.data;
      };
      if('steps' in request){
        const ttlMs=this.config.value.approvals?.ttlMs||600000;
        const output=await runBrowserSteps(request,{
          session,runAttempt:retry.attempt,execute,runId:run.id,attemptId:owner,
          approvals:{
            forStep:async(step)=>{const a=await persist(()=>this.approvals.forStep(run,step));return a&&asStepApproval(a);},
            request:async(step,proposal)=>asStepApproval(await persist(async()=>{await fence();return this.approvals.request(run,step,proposal,ttlMs);})),
            consume:async(step,id,payloadHash,pageHash)=>{
              await fence();
              if(await persist(()=>this.approvals.consume(run,step,id,payloadHash,pageHash,owner)))return;
              // Not consumed: name the reason, and retire an approval that no longer matches.
              const current=await persist(()=>this.approvals.forStep(run,step));
              if(!current||current.id!==id)throw new PolicyError('APPROVAL_NOT_FOUND','No approval for this step');
              if(current.status==='CONSUMED')throw new PolicyError('APPROVAL_ALREADY_CONSUMED','The approval was already used');
              if(current.status!=='APPROVED')throw new PolicyError('APPROVAL_'+current.status,'The approval is '+current.status.toLowerCase());
              if(new Date(current.expires_at).getTime()<=Date.now()){
                await persist(()=>this.approvals.expireIfDue(current,'worker'));
                throw new PolicyError('APPROVAL_EXPIRED','The approval expired before execution');
              }
              const code=current.payload_hash!==payloadHash?'APPROVAL_PAYLOAD_CHANGED':'APPROVAL_PAGE_CHANGED';
              await persist(()=>this.approvals.invalidate(current,code));
              throw new PolicyError(code,'The action or page differs from what was approved');
            },
            authorize:(step,pageHash)=>{session!.approvedAction={step,pageHash};},
            outcome:async(id,outcome,detail)=>{await persist(()=>this.approvals.recordOutcome(run,id,outcome,detail));},
          },
          cancelled:()=>cancelled||stopping||!!signal?.aborted,
          record:(step,input)=>persist(async()=>{await fence();await this.db.query('INSERT INTO browser_actions(id,run_id,sequence,kind,status,data) VALUES($1,$2,$3,$4,$5,$6)',
            [randomUUID(),run.id,++sequence,'step:'+step.kind,step.status,JSON.stringify({...step,step:step.index,input})]);}),
          saveEvidence:(url,item)=>persist(async()=>{await fence();return this.runs.saveEvidence(run,url,item);}),
          saveSourcedExtraction:(url,item,extraction)=>persist(async()=>{await fence();return this.runs.saveSourcedExtraction(run,url,item,extraction);}),
          saveScreenshot:async(bytes,key)=>(await persist(async()=>{await fence();return this.artifacts.save(run,bytes,'image/png',key);})).id,
        });
        return finish(output.status,output);
      }
      const input=request;
      for(const url of input.urls){
        try{
          const prior=await persist(()=>this.db.query('SELECT data FROM evidence WHERE run_id=$1 AND url=$2',[run.id,url]));
          if(prior.length){evidence.push(prior[0].data);continue;}
          const tabId=[...session.tabs.keys()][0];
          await execute({kind:'open',tabId,url});
          const article=ArticleSchema.parse(await execute({kind:'extract',tabId,schemaId:'article'}));
          if(!article.text.trim())throw new BrowserError('EMPTY_EVIDENCE','Source has no readable evidence');
          let artifactId:string|undefined;
          if(input.screenshot){
            const bytes=await execute({kind:'screenshot',tabId});
            if(!Buffer.isBuffer(bytes))throw new BrowserError('SCREENSHOT_FAILED','Invalid screenshot result');
            artifactId=(await persist(()=>this.artifacts.save(run,bytes,'image/png','capture-'+url))).id;
          }
          const item={...article,requestedUrl:url,retrievedAt:new Date().toISOString(),schemaId:'article',
            extraction:'deterministic-dom',verification:'captured-source-text',artifactId};
          await persist(()=>this.runs.saveEvidence(run,url,item,job.candidates?.find(c=>c.url===url)?.id));
          evidence.push(item);
        }catch(error){
          if(signal?.aborted||error instanceof BrowserError&&error.code==='CANCELLED')throw error;
          if(error instanceof ServiceError&&['PERSISTENCE_UNAVAILABLE','LEASE_LOST'].includes(error.code))throw error;
          warnings.push(error instanceof BrowserError?error.code:'SOURCE_FAILED');
        }
      }
      const status=evidence.length?(warnings.length?'PARTIAL':'COMPLETED'):'FAILED';
      return finish(status,{status,evidence,warnings});
    }catch(error){
      // A worker shutdown interrupts the attempt only; Temporal retries it on a running worker.
      if(stopping&&!signal?.aborted&&!cancelled)
        throw new ServiceError('WORKER_SHUTDOWN','The worker is shutting down; the run continues on the next attempt',503,true);
      const wasCancelled=signal?.aborted||cancelled||error instanceof BrowserError&&error.code==='CANCELLED';
      const code=error instanceof ServiceError?error.code:'BROWSER_FAILED';
      // The attempt that took over owns the run now; a busy run is retried by Temporal.
      if(code==='LEASE_LOST'||code==='RUN_BUSY')throw error;
      // A retryable failure keeps the run RUNNING for the next Temporal attempt.
      if(wasCancelled||retry.final||!(error instanceof ServiceError&&error.retryable)){
        const status=wasCancelled?'CANCELLED':'FAILED';
        try{
          await this.runs.transition(run,status);
          await this.approvals.closeOpen(run,'RUN_'+status);
          // Whatever completed before the failure stays visible with an explicit warning.
          await this.runs.recordTerminalOutput(run,await this.snapshot(run,status,[wasCancelled?'CANCELLED':code]));
        }catch{/* Storage unavailable: the dispatcher reconciles the run from the workflow. */}
      }
      throw error;
    }finally{
      clearInterval(renewal);
      signal?.removeEventListener('abort',abort);
      stop?.removeEventListener('abort',halt);
      if(session)await this.browser.close(session.id).catch(()=>undefined);
      if(leased&&!leaseLost)await this.runs.releaseLease(run,owner).catch(()=>undefined);
    }
  }
}
