'use strict';
// Read a DATABASE COPY. No web requests, login access or production writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {DataStore}=require('../data-store');
const {GuaziService,sourceVehicle}=require('../guazi-service');
const {CatalogPhotos,localVehiclePhoto}=require('../vehicle-photos');
const {QuoteAccountPool}=require('../quote-account-pool');
const {makeParser,QuoteBoard}=require('../live-board');
const [file,priorFile,out]=process.argv.slice(2);
if(!file||!priorFile||!out||path.resolve(file)===path.resolve(__dirname,'../data/valuation.sqlite'))throw Error('请指定数据库副本、历史报告、输出文件');
const store=new DataStore(file),prior=JSON.parse(fs.readFileSync(priorFile));
const raw=fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8');
const fn=name=>{const start=raw.search(new RegExp('^(?:async )?function '+name+'\\(','m')),rest=raw.slice(start);if(start<0)throw Error(name);return rest.slice(0,rest.indexOf('\n}\n')+2);};
(async()=>{
  let networkCalls=0;
  const photos=new CatalogPhotos({store,fetch:async()=>{networkCalls++;throw Error('离线审计不联网');},decode:b=>b});
  const guazi=new GuaziService({store,photos,call:async()=>{networkCalls++;throw Error('离线审计不发接口');}});
  guazi.catalog=async scope=>{const r=store.db.prepare("SELECT payload FROM provider_catalog WHERE provider='guazi' AND scope=?").get(scope);
    if(!r)throw Object.assign(Error('本地目录缺少 '+scope),{code:'CATALOG_NOT_CACHED'});return JSON.parse(r.payload);};
  const linked=guazi.indexKnownPhotos();
  const ctx=vm.createContext({dataStore:store,sourceVehicle,localVehiclePhoto,emitLog:()=>{}});
  for(const name of ['originalVehiclePhotoUrl','normalizeCachedQuote','cachedQuoteForInput'])vm.runInContext(fn(name),ctx);
  const pool=new QuoteAccountPool({store,list:()=>[{provider:'che300',id:'c',status:'authenticated'},{provider:'guazi',id:'g',status:'authenticated'}],
    activate:()=>{},count:()=>0,cache:(p,i)=>p==='guazi'?guazi.getCached(i):ctx.cachedQuoteForInput(i,false),
    request:async()=>({ok:false,code:'AUDIT_REQUIRES_ONLINE',message:'待真实车商报价验证'})});
  const parse=makeParser(store.db),rows=[],cards=new Map(),results=new Map();
  const board=new QuoteBoard({holdMs:0,quote:async input=>{const r=await pool.run(input);results.set(JSON.stringify(input),r);return r;},
    change:s=>{for(const h of s.history)cards.set(h.id,h);}});
  for(const old of prior.rows.filter(x=>x.status==='quoted')){
    const r=parse(old.comment),entry={id:old.comment.id,text:old.comment.text,previousCar:old.car,parseOk:r.ok,input:r.job?.input,car:r.job?.car};
    if(!r.ok)entry.failure=r.reason;
    else{
      entry.sameInput=JSON.stringify(r.job.input)===JSON.stringify(old.input);
      try{const match=await guazi.resolve(r.job.input);entry.guazi={ok:match.ok,code:match.code,reason:match.message,car:match.model?.name,id:match.model?.id,params:match.params};}
      catch(e){entry.guazi={ok:false,code:e.code||'AUDIT_ERROR',reason:e.message};}
      board.add({...r.job,id:old.comment.id,eventId:'audit:'+old.comment.id});
    }
    rows.push(entry);
  }
  while(board.busy)await new Promise(setImmediate);
  for(const row of rows){const result=results.get(JSON.stringify(row.input));row.cachedPrice=!!result?.cached;row.cardShown=cards.has(row.id);
    if(result?.ok){row.price=result.prices.good;row.provider=result.provider;row.hasLocalPhoto=/^data:image\//.test(cards.get(row.id)?.photo||'');}}
  const summary={previouslyQuoted:rows.length,stillParse:rows.filter(r=>r.parseOk).length,sameInput:rows.filter(r=>r.sameInput).length,
    guaziCatalogReady:rows.filter(r=>r.guazi?.ok).length,cacheQuotes:rows.filter(r=>r.cachedPrice).length,cachedCards:rows.filter(r=>r.cardShown).length,
    cachedCardsWithLocalPhoto:rows.filter(r=>r.hasLocalPhoto).length,needsOnlineDealer:rows.filter(r=>r.parseOk&&!r.cachedPrice).length,
    sharedFamilyLinks:linked,networkCalls};
  fs.writeFileSync(out,JSON.stringify({createdAt:new Date().toISOString(),mode:'offline-cache-and-catalog-audit',summary,rows},null,2));
  console.log(JSON.stringify({summary,failures:rows.filter(r=>!r.parseOk||!r.guazi?.ok)},null,2));
  if(networkCalls)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>store.db.close());
