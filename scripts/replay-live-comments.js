'use strict';
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser}=require('../live-parser');

// node scripts/replay-live-comments.js [database] [YYYY-MM-DD]
// Read-only audit: uses the parser only, never the live quote queue or API.
const file=process.argv[2]||resolve(__dirname,'../data/valuation.sqlite');
const date=process.argv[3];
const day=date && new Date(date+'T12:00:00+08:00');
if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(day.getTime()))){
  throw Error('回放日期须为 YYYY-MM-DD');
}
const db=new DatabaseSync(file,{readOnly:true});
try{
  const parse=makeParser(db,day?{today:()=>day}:{});
  const tally={match:0,ignored:0,failed:0}, report=[];
  for(const c of db.prepare('select id,comment_text text from live_comments order by id').all()){
    let r;
    try{r=parse(c);}catch(e){r={ok:false,code:'PARSE_ERROR',reason:e.message};}
    const status=r.ok?'match':r.ignored?'ignored':'failed';tally[status]++;
    report.push({...c,status,code:r.code,reason:r.reason||r.job?.reason,car:r.job?.car,input:r.job?.input});
  }
  process.stdout.write(JSON.stringify({tally,report},null,2)+'\n');
}finally{db.close();}
