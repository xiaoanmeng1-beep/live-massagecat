'use strict';
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {makeParser}=require('./live-parser');
const {quoteCacheKey,QUOTE_BASIS,GUAZI_CACHE_PREFIX}=require('./guazi-service');
class QuoteReplay {
  constructor({store,quote,provider='guazi',limit=Infinity,commentIds=null,interval=()=>5000,file,change=()=>{},pause=ms=>new Promise(r=>setTimeout(r,ms))}){
    if(limit!==Infinity&&(!Number.isSafeInteger(limit)||limit<1))throw Error('回归请求上限须为正整数');
    if(commentIds&&(!Array.isArray(commentIds)||!commentIds.length||commentIds.some(id=>!Number.isSafeInteger(id)||id<1)))throw Error('回归留言ID须为正整数列表');
    Object.assign(this,{store,quote,provider,limit,commentIds,interval,file,change,pause});this.running=false;this.report=null;
  }
  save(){fs.writeFileSync(this.file,JSON.stringify(this.report,null,2));this.change(this.report);}
  start(){if(this.running)return this.task;
    if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.previous-'+Date.now()+'.json');
    this.running=true;this.task=this.run().finally(()=>{this.running=false;});return this.task;}
  async run(){
    const parse=makeParser(this.store.db),rows=this.commentIds
      ?this.store.db.prepare(`SELECT id,comment_text text FROM live_comments WHERE id IN (${this.commentIds.map(()=>'?').join(',')}) ORDER BY id`).all(...this.commentIds)
      :this.store.db.prepare('SELECT id,comment_text text FROM live_comments ORDER BY id').all();
    const report=this.report={id:randomUUID(),provider:this.provider,quoteBasis:this.provider==='guazi'?QUOTE_BASIS:undefined,startedAt:Date.now(),state:'running',total:rows.length,matched:0,ignored:0,parseFailed:0,attempted:0,passed:0,failed:0,remaining:0,rows:[]};
    const jobs=[];
    for(const c of rows){let r;try{r=parse(c);}catch(e){r={ok:false,reason:e.message};}
      if(r.ok){report.matched++;jobs.push({comment:c,input:r.job.input,car:r.job.car});}
      else{if(r.ignored)report.ignored++;else report.parseFailed++;report.rows.push({...c,status:r.ignored?'ignored':'parse-failed',reason:r.reason});}}
    // Start with known cross-provider examples, then cover all matched comments.
    const guaziKeys=new Set(this.store.db.prepare('SELECT cache_key FROM quotes WHERE cache_key LIKE ?').all(GUAZI_CACHE_PREFIX+'%').map(r=>r.cache_key));
    const gkey=quoteCacheKey;
    jobs.sort((a,b)=>Number(guaziKeys.has(gkey(b.input)))-Number(guaziKeys.has(gkey(a.input))));
    report.remaining=jobs.length;this.save();
    const seen=new Map();
    for(const job of jobs){
      if(report.attempted>=this.limit){report.state='sample-completed';break;}
      const identity=JSON.stringify(job.input);
      if(seen.has(identity)){report.rows.push({...job,status:'reused',sameAs:seen.get(identity)});report.remaining--;this.save();continue;}
      if(report.attempted)await this.pause(this.interval());
      let result;try{result=await this.quote({...job.input,forceRefresh:true},{provider:this.provider,strictProvider:true});}
      catch(e){result={ok:false,code:'REQUEST_FAILED',message:e.message};}
      const p=result?.prices?.good,ok=result?.ok&&!result.cached&&Number.isFinite(p?.low)&&Number.isFinite(p?.high)&&p.low>0&&p.high>=p.low;
      report.attempted++;report.remaining--;if(ok)report.passed++;else report.failed++;
      // Comparisons use an EXISTING Che300 cache only. This replay must not
      // submit another Che300 request to fill a missing comparison.
      const date=String(job.input.registration).replace(/-(\d+)$/,(_,m)=>'-'+Number(m));
      const ckey=[job.input.provinceId,job.input.cityId,job.input.modelId,date,Number(job.input.mileage)].join(':');
      const che300=this.store.getQuote(ckey),cp=che300?.prices?.good;
      const comparison=ok&&cp?{che300:cp,che300FetchedAt:che300.fetchedAt,guazi:p,guaziModel:result.providerModel?.name,
        midpointDifferencePercent:100*((p.low+p.high)/(cp.low+cp.high)-1)}:null;
      report.rows.push({...job,status:ok?'quoted':'quote-failed',provider:result?.provider,quoteBasis:result?.quoteBasis,providerModel:result?.providerModel,requestParams:result?.requestParams,
        code:result?.code,reason:result?.message,prices:p,comparison,fetchedAt:result?.fetchedAt});
      seen.set(identity,job.comment.id);
      if(['AUTH_REQUIRED','NO_ACCOUNT','RATE_LIMITED','CAPTCHA_REQUIRED'].includes(result?.code)){
        report.state='blocked';report.blocked=result.code;break;
      }
      this.save();
    }
    if(report.state==='running')report.state='completed';report.finishedAt=Date.now();this.save();return report;
  }
}
module.exports={QuoteReplay};
