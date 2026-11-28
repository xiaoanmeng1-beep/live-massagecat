'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DataStore}=require('../data-store');const {QuoteReplay}=require('../quote-replay');
function fixture(){
  const store=new DataStore(':memory:'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'lmc-replay-test-'));
  store.replaceBrands('passenger',[{id:'40',name:'本田',initial:'H'}]);
  store.replaceSeries('passenger','40',[{id:'388',name:'思域'}]);
  store.replaceModels('passenger','40','388',[{id:'1231162',year:'2019',name:'2019款 思域 220TURBO CVT劲动版 国V',minRegistrationYear:'2016',maxRegistrationYear:'2026',catalogPrice:'13.99万'}]);
  store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
  const save=text=>store.saveLiveComment({name:'测试观众',text});
  return {store,file:path.join(directory,'report.json'),save,close:()=>{store.db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
test('历史留言只强制请求瓜子，车300对比仅读缓存，重复条件不重复请求',async()=>{
  const f=fixture(),trace=[];
  try{
    f.save('19年思域6万公里');f.save('主播你好');f.save('19年思域6万公里');
    f.store.saveQuote('20:20:1231162:2019-1:6',{fetchedAt:1,prices:{good:{low:3,high:4}}});
    const replay=new QuoteReplay({store:f.store,file:f.file,pause:async()=>{},quote:async(input,options)=>{
      trace.push({input,options});return {ok:true,cached:false,provider:'guazi',prices:{good:{low:4,high:6}},providerModel:{name:'思域'},fetchedAt:2};
    }});
    const r=await replay.start();assert.equal(r.total,3);assert.equal(r.matched,2);assert.equal(r.ignored,1);assert.equal(r.attempted,1);assert.equal(r.passed,1);
    assert.equal(trace[0].options.provider,'guazi');assert.equal(trace[0].options.strictProvider,true);assert.equal(trace[0].input.forceRefresh,true);
    assert.deepEqual(r.rows.find(row=>row.status==='quoted').comparison.che300,{low:3,high:4});
    assert.equal(r.rows.filter(row=>row.status==='reused').length,1);
  }finally{f.close();}
});
test('瓜子需验证立即暂停，不跑后续请求；重跑保留上一轮原始报告',async()=>{
  const f=fixture();let calls=0;
  try{
    f.save('19年思域6万公里');f.save('19年思域7万公里');
    const replay=new QuoteReplay({store:f.store,file:f.file,pause:async()=>{},quote:async()=>{calls++;return {ok:false,code:'CAPTCHA_REQUIRED'};}});
    const first=await replay.start();assert.equal(first.state,'blocked');assert.equal(first.blocked,'CAPTCHA_REQUIRED');assert.equal(calls,1);assert.equal(first.remaining,1);
    await replay.start();assert.ok(fs.readdirSync(path.dirname(f.file)).some(name=>name.includes('.previous-')));
  }finally{f.close();}
});
test('有限真实请求抽样到上限停止，不把剩余历史留言算作已完成',async()=>{
  const f=fixture();try{
    f.save('19年思域6万公里');f.save('19年思域7万公里');let calls=0;
    const replay=new QuoteReplay({store:f.store,file:f.file,limit:1,pause:async()=>{},quote:async()=>{
      calls++;return {ok:true,cached:false,provider:'guazi',quoteBasis:'dealer',prices:{good:{low:2,high:3}}};
    }});
    const r=await replay.start();assert.equal(calls,1);assert.equal(r.state,'sample-completed');assert.equal(r.remaining,1);assert.equal(r.quoteBasis,'dealer');
  }finally{f.close();}
});
test('指定以前成功过的留言作为真实回归样本，不顺带报价其它评论',async()=>{
  const f=fixture();try{
    f.save('19年思域6万公里');f.save('19年思域7万公里');const selected=f.store.db.prepare('SELECT max(id) id FROM live_comments').get().id,seen=[];
    const replay=new QuoteReplay({store:f.store,file:f.file,commentIds:[selected],pause:async()=>{},quote:async input=>{
      seen.push(input.mileage);return {ok:true,cached:false,provider:'guazi',quoteBasis:'dealer',prices:{good:{low:2,high:3}}};
    }});
    const r=await replay.start();assert.equal(r.total,1);assert.equal(r.attempted,1);assert.deepEqual(seen,[7]);
    assert.throws(()=>new QuoteReplay({store:f.store,commentIds:[0]}),/ID/);
  }finally{f.close();}
});
