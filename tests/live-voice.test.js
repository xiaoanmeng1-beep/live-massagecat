'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LivePlayer,salutation,price,reasonLabels}=require('../app/live-voice');
const turn=()=>new Promise(r=>setImmediate(r));
function rig(random=()=>0){
  let clock=0;
  const jobs=[],played=[],cancelled=[],notes=[];
  const p=new LivePlayer({now:()=>clock,rng:random,ident:()=>'j'+jobs.length,
    load:(key,row)=>row.bytes||key,report:n=>notes.push(n),abort:k=>cancelled.push(k),
    play:(bytes,done,tag)=>{const event={bytes,done,tag};played.push(event);return ()=>event.stopped=true},
    synth:(text,id,scene)=>new Promise((resolve,reject)=>jobs.push({text,id,scene,resolve,reject}))});
  p.update({scenes:Object.fromEntries(['quote','intro','welcome','missing'].map(k=>[k,{enabled:true,rows:
    Array.from({length:3},(_,i)=>({id:k+i,clip:k+i,text:k+i,reason:k==='missing'?['DATE','MULTIPLE_CARS','NO_TRIM'][i]:undefined,role:k==='quote'?'tail':undefined}))}]))});
  p.setAuto(true);p.live('room');
  const cue=(scene,e)=>p.cue(scene,'room',e);
  return {p,jobs,played,cancelled,notes,cue,quote:(id,series='朗逸')=>cue('quote',{id,series,low:1.77,high:2.3}),
    advance:ms=>{clock+=ms;p.tick()},ready:async n=>{jobs[n].resolve(Buffer.from('wav '+n));await turn()},end:async()=>{played.at(-1).done();await turn()}};
}
test('点名只截取屏幕上的前五个字符，复合 emoji、组合字不拆；没有昵称只念老板',()=>{
  assert.equal(salutation(' 春天里的小汽车 '),'春天里的小老板');
  assert.equal(salutation('小林'),'小林老板');assert.equal(salutation('12345678'),'12345老板');
  assert.equal(salutation('👩🏽‍🔧a\u0301你好呀呀'),'👩🏽‍🔧a\u0301你好呀老板');
  assert.equal(salutation('直播观众'),'直播观众老板');assert.equal(salutation(null),'老板');
  assert.deepEqual([1.77,2.3,0.82,4.02,10.1,0].map(price),['一万七千七百','两万三千','八千二百','四万零二百','十万一千','']);
});
test('聚合欢迎和三秒补介绍；每轮不重复；同一个欢迎池',async()=>{
  const r=rig();for(let i=0;i<2;i++)r.cue('welcome');await turn();assert.equal(r.played.length,0);
  r.cue('welcome');await turn();assert.equal(r.played.at(-1).tag.scene,'welcome');await r.end();
  r.advance(2999);await turn();assert.equal(r.played.length,1);
  for(let i=0;i<3;i++){r.advance(i?3000:1);await turn();assert.equal(r.played.at(-1).tag.scene,'intro');await r.end()}
  assert.equal(new Set(r.played.slice(1).map(e=>e.bytes)).size,3);
});
test('报价即刻生成；后台合成时可补介绍；换车后两条都只播主句',async()=>{
  const r=rig();r.quote(1);assert.match(r.jobs[0].text,/朗逸.*一万七千七百到两万三千/);
  r.advance(3000);await turn();assert.equal(r.played.at(-1).tag.scene,'intro');
  await r.ready(0);assert.deepEqual(r.played.map(e=>e.tag.scene),['intro','quote']);assert.ok(r.played[0].stopped);
  r.quote(2,'威驰');assert.equal(r.jobs.length,2);await r.ready(1);assert.equal(r.played.length,2);
  await r.end();assert.equal(r.played.at(-1).tag.scene,'quote');assert.match(r.played.at(-1).tag.words,/威驰/);
  await r.end();assert.equal(r.played.length,3);assert.ok(r.p.slots.every(s=>!s.bytes));
});
test('新车取消未完成的旧报价、断线取消当前；忽略迟到音频和失效回调',async()=>{
  const r=rig();r.quote(1);r.quote(2);assert.deepEqual(r.cancelled,['j0']);
  await r.ready(0);assert.equal(r.played.length,0);await r.ready(1);assert.equal(r.played.length,1);
  const old=r.played[0];r.quote(3);r.p.live('');assert.ok(r.cancelled.includes('j2'));
  await r.ready(2);old.done();assert.equal(r.played.length,1);assert.equal(r.p.tail,null);assert.equal(r.p.slots.length,0);
});
test('普通报价随机接一段现成尾句，不额外生成；概率没命中只报主句',async()=>{
  for(const [rand,expect] of [[.3,['quote','tail']],[.34,['quote']]]){
    const r=rig(()=>rand);r.quote(7);r.quote(7);await r.ready(0);await r.end();
    assert.deepEqual(r.played.map(x=>x.tag.scene),expect);assert.equal(r.jobs.length,1);
  }
});
test('信息不足按原因点名，只在空闲时播、每分钟最多一次，已入队或过期的提醒不补播',async()=>{
  const r=rig();const hint=()=>r.cue('missing',{viewer:'u1',name:'阿杰是个老司机',code:'MULTIPLE_CARS'});
  hint();assert.equal(r.jobs[0].text,'阿杰是个老老板，');
  await r.ready(0);assert.equal(r.played.length,0);r.advance(3000);await turn();assert.equal(r.played.at(-1).tag.scene,'missing');
  await r.end();assert.equal(r.played.at(-1).bytes,'missing1');await r.end();hint();assert.equal(r.jobs.length,1);
  const s=rig();s.cue('missing',{viewer:'m',name:'小小',code:'DATE'});s.cue('admitted',{viewer:'m'});await s.ready(0);
  assert.deepEqual(s.cancelled,['j0']);assert.equal(s.played.length,0);
  const t=rig();t.cue('missing',{viewer:'b',name:'小小',code:'DATE'});t.advance(10001);await t.ready(0);
  assert.ok(!t.played.some(x=>x.tag.scene==='missing'));assert.deepEqual(t.cancelled,['j0']);
});
test('绑定原因录音时先点名再播指定文件；失败的报价不读假价格',async()=>{
  const r=rig();r.p.library.scenes.missing.rows=[{id:'custom',clip:'custom',reason:'DATE',text:'年份没看清'}];
  r.cue('missing',{viewer:'u',name:'小林',code:'DATE'});assert.equal(r.jobs[0].text,'小林老板，');
  await r.ready(0);r.advance(9600);await turn();r.advance(1500);await r.end();assert.equal(r.played.at(-1).bytes,'custom');
  await r.end();r.quote(4);r.jobs[1].reject(Error('模型失败'));await turn();
  assert.equal(r.played.filter(x=>x.tag.scene==='quote').length,0);
});

test('有观众进场后，连续评论可提前触发同一组欢迎；只聊天不凭空欢迎',async()=>{
  const r=rig();for(let i=0;i<3;i++)r.cue('comment');await turn();assert.equal(r.played.length,0);
  r.cue('welcome');for(let i=0;i<3;i++)r.cue('comment');await turn();
  assert.deepEqual(r.played.map(x=>x.tag.scene),['welcome']);
});

test('空分类、未分类、未知原因均不播；有录音时只取命中的分类，与编辑器筛选无关',async()=>{
  for(const code of Object.keys(reasonLabels)){
    const r=rig();r.p.library.scenes.missing.rows=[{id:'1',clip:'other',reason:code==='DATE'?'NO_TRIM':'DATE'},{id:'2',clip:'old'}];
    r.p.settings=()=>({reasons:{[code]:'旧版自定义文字'}});
    for(const c of [code,undefined,'UNKNOWN'])r.cue('missing',{name:'小林',code:c});
    assert.equal(r.jobs.length,0);
    r.p.library.scenes.missing.rows.push({id:'3',clip:'exact',reason:code,text:'同分类'});
    r.cue('missing',{name:'小林',code});await r.ready(0);r.advance(3000);await turn();
    assert.equal(r.jobs[0].text,'小林老板，');await r.end();assert.equal(r.played.at(-1).bytes,'exact');
  }
});
test('移除正在等候的分类录音，取消称呼，迟到的音频也不播',async()=>{
  const r=rig();r.cue('missing',{name:'小林',code:'DATE'});
  const state=structuredClone(r.p.library);state.scenes.missing.rows=[];r.p.update(state);
  await r.ready(0);r.advance(3000);await turn();assert.deepEqual(r.cancelled,['j0']);assert.ok(r.played.every(x=>x.tag.scene!=='missing'));
});
