'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DataStore}=require('../data-store');const {QuoteAccountPool}=require('../quote-account-pool');
function fixture(){
  const store=new DataStore(':memory:'),accounts=[{provider:'che300',id:'c',label:'C',status:'authenticated',n:0},{provider:'guazi',id:'g',label:'G',status:'authenticated',n:0}],trace=[];
  const args={store,list:()=>accounts,activate:a=>trace.push('activate:'+a.provider),cache:()=>null,count:a=>accounts.find(b=>b.id===a.id).n,
    request:async a=>{accounts.find(b=>b.id===a.id).n++;trace.push(a.provider);return {ok:true,provider:a.provider};}};
  const pool=new QuoteAccountPool(args);return {store,accounts,args,pool,trace};
}
test('20次车300→20次瓜子→车300，实际请求累计跨平台轮转且重开保留',async()=>{
  const f=fixture();try{
    for(let i=0;i<41;i++)await f.pool.run({forceRefresh:true});
    const providers=f.trace.filter(p=>!p.startsWith('activate:'));
    assert.deepEqual(providers,[...Array(20).fill('che300'),...Array(20).fill('guazi'),'che300']);
    assert.equal(f.pool.snapshot().used,1);
    const restored=new QuoteAccountPool(f.args);assert.equal(restored.snapshot().used,1);assert.equal(restored.snapshot().current,'che300:c');
  }finally{f.store.db.close();}
});
test('缓存不消耗次数，无备用账号继续用当前账号，不生成冷却',async()=>{
  const f=fixture();try{
    f.accounts.pop();for(let i=0;i<21;i++)await f.pool.run({forceRefresh:true});
    assert.equal(f.pool.state.used,21);assert.equal(f.accounts[0].status,'authenticated');
    f.pool.cache=()=>({ok:true,cached:true});for(let i=0;i<30;i++)await f.pool.run({});
    assert.equal(f.pool.state.used,21);assert.equal(f.accounts[0].n,21);
  }finally{f.store.db.close();}
});
test('先查两个平台本地精确报价：跨平台命中无需登录、不激活账号、不计次数；显式平台回归隔离',async()=>{
  for(const [current,available] of [['che300','guazi'],['guazi','che300']]){
    const f=fixture();try{
      f.pool.state.current=current+':'+(current==='guazi'?'g':'c');f.pool.state.used=19;
      f.accounts.forEach(a=>a.status='expired');const lookups=[];
      f.pool.cache=(provider,input)=>{lookups.push(provider);return provider===available&&input.mileage===10?{ok:true,cached:true,fetchedAt:1,prices:{good:{low:1,high:2}}}:null;};
      const cached=await f.pool.run({mileage:10});assert.equal(cached.provider,available);assert.equal(cached.fetchedAt,1);
      assert.deepEqual(lookups,[current,available]);assert.deepEqual(f.trace,[]);assert.equal(f.pool.state.used,19);
      assert.equal((await f.pool.run({mileage:11})).code,'AUTH_REQUIRED');
      assert.equal((await f.pool.run({mileage:10,forceRefresh:true})).code,'AUTH_REQUIRED');
      assert.equal((await f.pool.run({mileage:10},null,{provider:current})).code,'AUTH_REQUIRED');
      assert.deepEqual(f.trace,[]);
    }finally{f.store.db.close();}
  }
});
test('价/目录缺失不借另一平台补查；限频立即返回，不用轮换规避',async()=>{
  const f=fixture();try{
    let calls=0;f.pool.request=async()=>{calls++;return {ok:false,code:'NO_MODEL'};};
    assert.equal((await f.pool.run({})).code,'NO_MODEL');assert.equal(calls,1);assert.equal(f.pool.state.used,0);
    f.pool.state.used=19;f.pool.request=async a=>{f.accounts.find(b=>b.id===a.id).n++;return {ok:false,code:'RATE_LIMITED'};};
    assert.equal((await f.pool.run({})).code,'RATE_LIMITED');assert.equal(f.pool.state.current,'che300:c');
  }finally{f.store.db.close();}
});
test('回归显式限定车300；登录失效只尝试已验证账号',async()=>{
  const f=fixture();try{
    for(let i=0;i<22;i++)assert.equal((await f.pool.run({forceRefresh:true},null,{provider:'che300'})).provider,'che300');
    assert.equal(f.accounts[1].n,0);
    f.pool.request=async a=>{if(a.provider==='che300'){f.accounts[0].status='expired';return {ok:false,code:'AUTH_REQUIRED'};}return {ok:true,provider:a.provider};};
    f.pool.state.used=0;assert.equal((await f.pool.run({})).provider,'guazi');
  }finally{f.store.db.close();}
});

test('手动跨平台切换操作全局指针，仅有一个当前账号，切换后从该账号开始计数',async()=>{
  const f=fixture();try{
    await f.pool.run({forceRefresh:true});assert.equal(f.pool.state.used,1);
    const first=f.pool.snapshot();assert.equal(first.accounts.filter(a=>a.current).length,1);
    f.pool.select('guazi','g');assert.equal(f.pool.snapshot().current,'guazi:g');assert.equal(f.pool.state.used,0);
    assert.equal(f.pool.snapshot().accounts.find(a=>a.provider==='che300').current,false);
    const n=f.pool.revision;f.pool.select('guazi','g');assert.equal(f.pool.revision,n);
    assert.equal((await f.pool.run({forceRefresh:true})).provider,'guazi');assert.equal(f.pool.state.used,1);
    f.pool.select('che300','c');assert.equal(f.pool.snapshot().current,'che300:c');
    assert.equal(f.pool.snapshot().accounts.filter(a=>a.current).length,1);
    f.accounts[1].status='verification-required';assert.throws(()=>f.pool.select('guazi','g'),/验证/);
    assert.equal(f.pool.snapshot().current,'che300:c');
  }finally{f.store.db.close();}
});
