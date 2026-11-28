'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DataStore}=require('../data-store');
const {registerFailureIpc}=require('../failure-ipc');
const {QuoteBoard,attemptLiveMatch}=require('../live-board');

test('直播匹配未入队与已入队后报价失败分开；重复事件和解析异常有原因',async()=>{
  const board=new QuoteBoard({quote:async()=>({ok:false,code:'TIMEOUT'}),pause:async()=>{}});
  const event={id:1,eventId:'e1'},parse=()=>({ok:true,job:event});
  assert.deepEqual(attemptLiveMatch(parse,board,event),{ok:true});
  await new Promise(setImmediate);
  assert.equal(attemptLiveMatch(parse,board,event).code,'DUPLICATE_EVENT');
  assert.deepEqual(attemptLiveMatch(()=>({ok:false,code:'NO_TRIM',reason:'未匹配到配置'}),board,event),{ok:false,code:'NO_TRIM',reason:'未匹配到配置'});
  assert.match(attemptLiveMatch(()=>{throw Error('测试错误');},board,event).reason,/测试错误/);
});

test('SQLite 重开、分页、全部导出、取消与限定范围清空',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'match-failures-')),file=path.join(temp,'test.db'),output=path.join(temp,'全部.csv');
  let store=new DataStore(file);
  t.after(()=>{store.db.close();fs.rmSync(temp,{recursive:true,force:true});});
  const sample='=1+1,"带引号"\n第二行';
  function add(text,n){
    const id=store.saveLiveComment({room:'123456',name:'测试观众',text,receivedAt:1000000+n});
    assert.equal(store.recordMatchFailure(id,'AMBIGUOUS_SERIES','车系有歧义'),true);
    assert.equal(store.recordMatchFailure(id,'OTHER','覆盖'),false);
    return id;
  }
  for(let i=0;i<64;i++)add(i===0?sample:'评论 '+i,i);
  store.db.close();store=new DataStore(file);
  const pages=[],first=store.listMatchFailures();
  for(let p=first;;p=store.listMatchFailures(p.rows.at(-1).id)){pages.push(...p.rows.map(r=>r.id));if(!p.more)break;}
  assert.equal(first.rows.length,30);assert.equal(new Set(pages).size,64);assert.equal(pages.at(-1),1);
  const handlers=new Map(),frame={},sender={mainFrame:frame,send(){}},win={webContents:sender,isDestroyed:()=>false};
  const evt={sender,senderFrame:frame};
  let confirm=async()=>({response:0}),save=async()=>({canceled:true});
  registerFailureIpc({handle:(k,fn)=>handlers.set(k,fn)},{showSaveDialog:()=>save(),showMessageBox:()=>confirm()},()=>win,store);
  const run=(k,...args)=>handlers.get('live:failures-'+k)(evt,...args);
  assert.throws(()=>handlers.get('live:failures-list')({sender,senderFrame:{}}));
  assert.deepEqual(await run('export'),{canceled:true});assert.equal(fs.existsSync(output),false);
  save=async()=>({filePath:output,canceled:false});
  assert.equal((await run('export')).count,64);
  const csv=fs.readFileSync(output,'utf8');
  assert.ok(csv.startsWith('\uFEFF时间,直播间,观众昵称,评论内容,失败原因,原因代码\r\n'));
  assert.ok(csv.includes('"\'=1+1,""带引号""\n第二行"'));
  assert.equal(csv.match(/,"AMBIGUOUS_SERIES"\r\n/g).length,64);
  assert.deepEqual(await run('clear'),{canceled:true});assert.equal(store.matchFailureStats().total,64);
  confirm=async()=>{add('在确认期间到达',80);return {response:1};};
  assert.deepEqual(await run('clear'),{count:64});
  assert.equal(store.listMatchFailures().rows[0].text,'在确认期间到达');
  assert.equal(store.listLiveComments().length,65);
  confirm=async()=>({response:1});await run('clear');assert.equal(store.listMatchFailures().total,0);
  assert.deepEqual(await run('export'),{count:0});
});
