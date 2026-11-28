'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QuoteBoard,attemptLiveMatch,makeParser}=require('../live-board');
const {DatabaseSync}=require('node:sqlite');
const job=(id,opts={})=>({id,eventId:'r'+id,room:'12345',name:'观众甲',userId:'u1',
  input:{modelId:'m1',registration:'2024-01',mileage:3.1,provinceId:'20',cityId:'20',...opts.input},
  ...Object.fromEntries(Object.entries(opts).filter(([k])=>k!=='input'))});
const ok={ok:true,prices:{good:{low:21.92,high:23.2}}};
const done=async b=>{while(b.busy)await new Promise(setImmediate)};
test('同房间同观众同参数在等待、执行及最近五次成功内只报价一次；允许更改报价条件',async()=>{
  let release;
  const b=new QuoteBoard({holdMs:0,quote:()=>new Promise(r=>{release=()=>r(ok)})});
  b.add(job(1));b.add(job(2,{input:{mileage:4}}));await new Promise(setImmediate);
  for(const j of [job(3),job(4,{input:{mileage:4}})])assert.equal(b.admit(j).code,'REPEAT_VIEWER_QUOTE');
  release();await new Promise(setImmediate);release();await done(b);
  assert.equal(b.admit(job(5,{name:'改过昵称'})).ignored,true);
  b.quote=async()=>ok;
  for(const [i,opts] of [{input:{registration:'2023-01'}},{input:{cityId:'30'}},{input:{modelId:'m2'}},
    {userId:'u2'},{room:'12346'}].entries())assert.equal(b.add(job(i+6,opts)),true);
  await done(b);
  assert.equal(b.history.length,5);
  assert.equal(b.add(job(12)),true);await done(b);
});
test('新消息可重试先前失败的报价',async()=>{
  let calls=0;const b=new QuoteBoard({holdMs:0,quote:async()=>++calls===1?{ok:false}:ok});
  b.add(job(1));await done(b);assert.equal(b.add(job(2)),true);await done(b);
  assert.equal(b.history.length,1);assert.equal(calls,2);
});
test('真实i8三种留言用实际车型库匹配，补白色或零事故不重复调报价或申请头像',async()=>{
  const db=new DatabaseSync(require('node:path').join(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  try{
    const parse=makeParser(db,{today:()=>new Date(2026,10,27)});let calls=0,avatars=0;
    const b=new QuoteBoard({holdMs:0,quote:async()=>{calls++;return ok;}});
    const results=[];
    for(const [i,text] of ['理想i8 正好一年 31000公里 多钱','理想i8 白色 正好一年 31000公里 多钱','理想i8 白色 正好一年 31000公里 多钱 零事故'].entries()){
      results.push(attemptLiveMatch(parse,b,{room:'861239320059',name:'狂*****',text,id:i+1,eventId:'i8-'+i},()=>avatars++));
      await done(b);
    }
    assert.deepEqual(results.map(r=>r.code||'OK'),['OK','REPEAT_VIEWER_QUOTE','REPEAT_VIEWER_QUOTE']);
    assert.equal(calls,1);assert.equal(avatars,1);assert.equal(b.history.length,1);
    assert.equal(attemptLiveMatch(parse,b,{room:'861239320059',name:'另一位观众',id:4,text:'理想i8 正好一年 31000公里 多钱'}).ok,true);
    await done(b);
  }finally{db.close()}
});
