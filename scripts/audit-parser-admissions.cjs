'use strict';
// Usage: node scripts/audit-parser-admissions.cjs DB BEFORE.json YYYY-MM-DD [cohorts.json] [prior-quotes.json]
// BEFORE is stdout from scripts/replay-live-comments.js BEFORE editing. Compare
// the exact same ordered events, never use a current parser as its own baseline.
const {DatabaseSync}=require('node:sqlite');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const {makeParser,QuoteBoard,attemptLiveMatch}=require('../live-board');
const [file,baseline,date,cohorts,priorQuotes]=process.argv.slice(2);
if(!file ||!baseline||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('需要数据库、修改前快照和回放日期');
const get=file=>JSON.parse(readFileSync(file,'utf8'));
const before=get(baseline);
const status=r=>r.ok?'match':r.ignored?'ignored':'failed';
const tally=list=>list.reduce((o,x)=>{o[x.status]++;return o;},{match:0,ignored:0,failed:0});
async function audit(){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const parse=makeParser(db,{today:()=>new Date(date+'T12:00:00+08:00')});
    const events=db.prepare('select id,comment_text text from live_comments order by id').all();
    assert.deepEqual(events.map(r=>[r.id,r.text]),before.report.map(r=>[r.id,r.text]),'样本已经改变；请分别在同一份数据库快照上做前后回放');
    const calls=[],admitted=[],gains=[],lost=[],changed=[],unresolved=[],newRows=[];
    const board=new QuoteBoard({holdMs:0,quote:async input=>{calls.push(input);return {ok:true,prices:{good:{low:1,high:2}}};}});
    for(const [idx,event] of events.entries()){
      const old=before.report[idx];let parsed;
      const admission=attemptLiveMatch(e=>parsed=parse(e),board,event);
      assert.equal(admission.ok,parsed.ok);
      const row={id:event.id,text:event.text,status:status(parsed),car:parsed.job?.car,input:parsed.job?.input,
        reason:parsed.job?.reason||parsed.reason,code:parsed.code,path:parsed.matchPath,evidence:parsed.matchEvidence};
      newRows.push(row);
      if(admission.ok)admitted.push(parsed.job.input);
      if(row.status==='match' && old.status!=='match')gains.push({...row,before:old.reason});
      if(row.status!=='match' && old.status==='match')lost.push({before:old,after:row});
      if(row.status==='match' && old.status==='match' && JSON.stringify(old.input)!==JSON.stringify(row.input))changed.push({before:old,after:row});
      if(row.status==='failed')unresolved.push(row);
    }
    while(board.busy)await new Promise(setImmediate);
    assert.deepEqual(calls,admitted,'入队到报价回调传参或顺序不一致');
    assert.equal(board.blocked,null);assert.equal(board.pending.length,0);
    assert.deepEqual(board.history.map(c=>c.id),newRows.filter(r=>r.status==='match').slice(-5).reverse().map(r=>r.id));
    const previous=new Map(before.report.map(r=>[r.text,r])),current=new Map(newRows.map(r=>[r.text,r]));
    const subsets={};
    for(const [name,texts] of Object.entries(cohorts?get(cohorts):{})){
      assert.ok(texts.every(t=>previous.has(t)&&current.has(t)),'CSV有未回放留言');
      subsets[name]={size:texts.length,before:tally(texts.map(t=>previous.get(t))),after:tally(texts.map(t=>current.get(t)))};
    }
    if(priorQuotes){
      const texts=get(priorQuotes).rows.filter(r=>r.status==='quoted').map(r=>r.comment.text);
      assert.ok(texts.every(t=>previous.has(t)&&current.has(t)),'历史报价样本不在回放集中');
      subsets.previouslyQuoted={size:texts.length,before:tally(texts.map(t=>previous.get(t))),after:tally(texts.map(t=>current.get(t)))};
    }
    return {mode:'offline / production parser and QueueBoard / stub quote / no platform requests',
      date,events:events.length,before:tally(before.report),after:tally(newRows),oldMatchesLost:lost.length,
      unchangedIgnored:before.report.filter((r,i)=>r.status==='ignored'&&newRows[i].status==='ignored').length,
      queueCallbacks:calls.length,subsets,gains,lost,changed,unresolved};
  }finally{db.close();}
}
audit().then(report=>console.log(JSON.stringify(report,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
