'use strict';
const test=require('node:test'),a=require('node:assert/strict'),Pool=require('../resident-voice');
function fixture(idleMs=10){const lanes=[];
  const pool=new Pool(null,{idleMs,makeLane:notify=>{
    const l={begin(j){this.job=j},end(data){const j=this.job;this.job=null;this.loaded=j.req.engine;notify(j,null,data)},
      abort(){const j=this.job;this.job=null;notify(j,Object.assign(Error('cancel'),{cancelled:true}))},close(){this.closed=true;this.job=null}};
    lanes.push(l);return l;
  }});return {pool,lanes,job:(id,priority=3)=>pool.run({id,text:id,engine:'base'},priority)}
}
test('一个任务立即起跑；有积压才开旁路，快路连续取下一条，不需成对等待，空闲后回收旁路',async()=>{
  const {pool,lanes,job}=fixture();const one=job('慢');a.equal(lanes.length,1);a.equal(lanes[0].job.req.id,'慢');
  const two=job('快'),three=job('第三'),four=job('第四');a.equal(lanes.length,2);a.equal(lanes[1].job.req.id,'快');
  lanes[1].end('2');a.equal(lanes[1].job.req.id,'第三');lanes[1].end('3');a.equal(lanes[1].job.req.id,'第四');lanes[1].end('4');
  a.deepEqual(await Promise.all([two,three,four]),['2','3','4']);a.equal(lanes[0].job.req.id,'慢');lanes[0].end('1');a.equal(await one,'1');
  await new Promise(r=>setTimeout(r,25));a.equal(lanes[1].closed,true);a.equal(pool.lanes.length,1);pool.close();
});
test('预热与单条生成共用主路；取消排队项不会停其他任务',async()=>{
  const {pool,lanes,job}=fixture();const warm=pool.run({id:'w',engine:'base',warm:true},2),one=job('甲');
  a.equal(lanes.length,1);lanes[0].end();await warm;a.equal(lanes[0].job.req.id,'甲');
  const two=job('乙'),three=job('丙');pool.cancel('丙');await a.rejects(three,/取消/);
  lanes[1].end('b');lanes[0].end('a');a.deepEqual(await Promise.all([one,two]),['a','b']);pool.close();
});
test('两路忙时，新报价先用一路，已被取消的录音不重排',async()=>{
  const {pool,lanes,job}=fixture();const slow=job('慢'),other=job('另外'),quote=job('报价',0);
  const active=lanes.find(l=>l.job?.req.id==='报价');a.ok(active);pool.cancel('慢');await a.rejects(slow,/取消/);
  active.end('钱');lanes.find(l=>l.job?.req.id==='另外').end('好');a.deepEqual(await Promise.all([quote,other]),['钱','好']);pool.close();
});
