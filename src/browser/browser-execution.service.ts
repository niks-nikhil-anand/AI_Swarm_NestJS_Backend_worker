import { Injectable } from '@nestjs/common';
import { RunRepository } from '../persistence/run.repository';
import { DatabaseService } from '../persistence/database.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { SessionManagerService } from './services/session-manager.service';
import { BrowserService } from './services/browser.service';
import { BrowserRequestSchema } from './contracts/browser-request';
import type { BrowserAction } from './contracts/browser-action';
import type { BrowserSession } from './contracts/browser-session';
import type { RunJob } from '../search/search-execution.service';
import type { ExecutionContext } from '../common/types/execution-context';
import { BrowserError } from '../common/errors/browser.errors';
import { ArticleSchema } from './adapters/playwright/playwright.adapter';
export interface BrowserJob extends RunJob{candidates?:{id:string;url:string}[]}

@Injectable()
export class BrowserExecutionService{
  constructor(private readonly runs:RunRepository,private readonly db:DatabaseService,
    private readonly sessions:SessionManagerService,private readonly browser:BrowserService,
    private readonly artifacts:ArtifactService){}
  async execute(job:BrowserJob,signal?:AbortSignal,heartbeat:()=>void=()=>{}){
    const run=await this.runs.get(job.runId,job.tenantId,job.projectId);
    if(!['browser','research'].includes(run.kind))throw new BrowserError('INVALID_RUN','Not a browser run');
    if(['COMPLETED','PARTIAL','NO_RESULTS','FAILED','CANCELLED'].includes(run.status))return run.output;
    const actor:ExecutionContext={tenantId:run.tenant_id,projectId:run.project_id,userId:run.user_id,requestId:run.id,capabilities:['browser']};
    let session:BrowserSession|undefined;
    const abort=()=>{if(session)void this.browser.close(session.id).catch(()=>undefined);};
    const warnings:string[]=[],evidence:unknown[]=[];
    try{
      const input=BrowserRequestSchema.parse(run.kind==='research'?{urls:(job.candidates||[]).map(c=>c.url)}:run.input);
      if(signal?.aborted)throw new BrowserError('CANCELLED','Run cancelled',409);
      await this.runs.transition(run,'RUNNING');
      session=await this.sessions.create(actor);
      signal?.addEventListener('abort',abort,{once:true});
      let sequence=Number((await this.db.query('SELECT COALESCE(MAX(sequence),0) AS sequence FROM browser_actions WHERE run_id=$1',[run.id]))[0].sequence);
      const execute=async(action:BrowserAction)=>{
        heartbeat();
        if(signal?.aborted||(await this.runs.get(run.id,run.tenant_id,run.project_id)).status==='CANCELLED')
          throw new BrowserError('CANCELLED','Run cancelled',409);
        const result=await this.browser.execute(session!.id,actor,action);
        await this.db.query('INSERT INTO browser_actions(id,run_id,sequence,kind,status,data) VALUES($1,$2,$3,$4,$5,$6)',
          [result.actionId,run.id,++sequence,action.kind,result.status,JSON.stringify({error:result.error,durationMs:result.durationMs})]);
        if(result.status==='failed')throw new BrowserError(result.error!.code,result.error!.message);
        return result.data;
      };
      for(const url of input.urls){
        try{
          const prior=await this.db.query('SELECT data FROM evidence WHERE run_id=$1 AND url=$2',[run.id,url]);
          if(prior.length){evidence.push(prior[0].data);continue;}
          const tabId=[...session.tabs.keys()][0];
          await execute({kind:'open',tabId,url});
          const article=ArticleSchema.parse(await execute({kind:'extract',tabId,schemaId:'article'}));
          if(!article.text.trim())throw new BrowserError('EMPTY_EVIDENCE','Source has no readable evidence');
          let artifactId:string|undefined;
          if(input.screenshot){
            const bytes=await execute({kind:'screenshot',tabId});
            if(!Buffer.isBuffer(bytes))throw new BrowserError('SCREENSHOT_FAILED','Invalid screenshot result');
            artifactId=(await this.artifacts.save(run,bytes)).id;
          }
          const item={...article,requestedUrl:url,retrievedAt:new Date().toISOString(),schemaId:'article',
            extraction:'deterministic-dom',verification:'captured-source-text',artifactId};
          await this.runs.saveEvidence(run,url,item,job.candidates?.find(c=>c.url===url)?.id);
          evidence.push(item);
        }catch(error){
          if(signal?.aborted||error instanceof BrowserError&&error.code==='CANCELLED')throw error;
          warnings.push(error instanceof BrowserError?error.code:'SOURCE_FAILED');
        }
      }
      const status=evidence.length?(warnings.length?'PARTIAL':'COMPLETED'):'FAILED';
      const output={status,evidence,warnings};
      await this.runs.transition(run,status,output);
      return output;
    }catch(error){
      await this.runs.transition(run,signal?.aborted||error instanceof BrowserError&&error.code==='CANCELLED'?'CANCELLED':'FAILED');
      throw error;
    }finally{
      signal?.removeEventListener('abort',abort);
      if(session)await this.browser.close(session.id);
    }
  }
}
