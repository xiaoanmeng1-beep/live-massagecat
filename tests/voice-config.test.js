'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),p=require('node:path');
const {VoiceLibrary}=require('../voice-library'),Player=require('../app/voice-playback');
const wavFile=require('./voice-fixture.cjs');
const scratch=()=>fs.mkdtempSync(p.join(os.tmpdir(),'voice-lib-'));
test('reference picker is independent of scene and draft; stale reference IDs and invalid WAVs are rejected',async()=>{
  const tmp=scratch(),lib=new VoiceLibrary(tmp),wav=wavFile(tmp,'参考音色');
  lib.installed=()=>true;
  const before=structuredClone(lib.state),first=lib.setReference(wav).reference,second=lib.setReference(wav).reference;
  a.notEqual(first.id,second.id);a.equal(second.name,'参考音色.wav');a.equal(second.file,undefined);
  await a.rejects(lib.generate({engine:'base',text:'报价',reference:first.id,refText:'原话'}),/重新选择/);
  await a.rejects(lib.generate({engine:'base',text:'报价',reference:second.id,refText:'字'.repeat(401)}),/400/);
  a.equal(lib.referenceAudio(second.id).length,fs.statSync(wav).size);a.throws(()=>lib.referenceAudio(first.id),/更换/);
  const bad=p.join(tmp,'bad.wav');fs.writeFileSync(bad,'not a wav');a.throws(()=>lib.setReference(bad),/WAV/);
  a.equal(lib.snapshot().reference.id,second.id);a.deepEqual(lib.state,before);
});
test('new library stays empty; draft never enters rotation until committed; replace preserves slot and shared clips survive',()=>{
  const root=scratch(),lib=new VoiceLibrary(root);
  a.ok(Object.values(lib.state.scenes).every(s=>s.rows.length===0));
  const f=wavFile(root);lib.import(f,'quote');lib.import(f,'quote');
  const first=lib.import(f).draft.clip,orig=lib.state.scenes.quote.rows.map(x=>x.id);
  a.equal(lib.state.scenes.quote.rows.length,orig.length);
  lib.edit({op:'append',scene:'welcome',draft:first});
  lib.edit({op:'replace',scene:'quote',row:orig[1],draft:first});
  a.deepEqual(lib.state.scenes.quote.rows.map(x=>x.id),orig);
  const second=lib.import(f).draft.clip;
  a.throws(()=>lib.edit({op:'replace',scene:'quote',row:orig[0],draft:first}));
  lib.edit({op:'replace',scene:'quote',row:orig[1],draft:second});
  a.ok(lib.audio(first).length);lib.edit({op:'remove',scene:'welcome',row:lib.state.scenes.welcome.rows.at(-1).id});
  a.throws(()=>lib.audio(first));a.throws(()=>lib.audio('../valuation.sqlite'));
  a.deepEqual(new VoiceLibrary(root).state,JSON.parse(JSON.stringify({...lib.state,draft:null})));
});
test('sequential and shuffle bags, no repeat on shuffle boundary',()=>{
  const lib=new VoiceLibrary(scratch()),player=new Player({rng:()=>0,report(){}});
  for(let i=0;i<2;i++)lib.import(wavFile(lib.root),'welcome');
  lib.edit({op:'saveMode',scene:'welcome',mode:'sequence'});player.update(lib.state);const seq=()=>player.pick('welcome').id;
  const round=Array.from({length:lib.state.scenes.welcome.rows.length},seq);a.equal(new Set(round).size,round.length);a.equal(seq(),round[0]);
  lib.edit({op:'saveMode',scene:'welcome',mode:'random'});player.update(lib.state);
  const list=Array.from({length:6},seq);for(let i=1;i<list.length;i++)a.notEqual(list[i-1],list[i])
});
test('no overlapping automatic voices, priority/expiry, stale audio completion ignored after disconnect',async()=>{
  const lib=new VoiceLibrary(scratch()),played=[];let end,now=1000000,late;
  const player=new Player({now:()=>now,report(){},load:id=>Promise.resolve(id),play:(id,cb)=>{played.push(id);end=cb;return ()=>{}}});
  const files={};for(const scene of ['welcome','intro','quote','missing'])
    files[scene]=lib.import(wavFile(lib.root),scene,'DATE').scenes[scene].rows[0].clip;
  player.update(lib.state);player.setAuto(true);player.live('123');
  const turn=()=>new Promise(r=>setImmediate(r));
  player.cue('welcome','wrong');a.equal(player.current,null);
  player.cue('welcome','123');player.cue('missing','123');player.cue('quote','123');await turn();
  a.deepEqual(played,[files.welcome]);end();await turn();a.deepEqual(played,[files.welcome,files.quote]);
  now+=15000;end();await turn();a.equal(player.current,null);
  now+=120000;player.tick();await turn();a.equal(played.at(-1),files.intro);
  player.stop();player.load=()=>new Promise(r=>late=r);player.cue('quote','123');player.live('');late('old');await turn();
  a.equal(played.length,3);a.equal(player.current,null);
});
test('旧话术库迁移到 SQLite：固定 WAV 入库、试听不持久化、删除槽位不复活', t=>{
  const root=scratch();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacy=p.join(root,'voice-library');fs.mkdirSync(p.join(legacy,'clips'),{recursive:true});
  const source=wavFile(root),bytes=fs.readFileSync(source);
  const row={id:'old-row',clip:require('node:crypto').randomUUID(),text:'原有欢迎'};
  fs.writeFileSync(p.join(legacy,'clips',row.clip+'.wav'),bytes);
  const old={version:1,draft:null,scenes:{}};for(const s of ['welcome','intro','quote','missing'])
    old.scenes[s]={enabled:true,mode:'sequence',rows:s==='welcome'?[row,{id:'retired',clip:'stock-welcome-0'}]:[]};
  fs.writeFileSync(p.join(legacy,'library.json'),JSON.stringify(old));
  const staged=new VoiceLibrary(root,{stageLegacy:true});staged.close();
  old.scenes.welcome.rows[0].text='旧窗口在重启前调整过';
  fs.writeFileSync(p.join(legacy,'library.json'),JSON.stringify(old));let lib=new VoiceLibrary(root);
  a.deepEqual(lib.state.scenes.welcome.rows[0],old.scenes.welcome.rows[0]);
  a.equal(lib.state.scenes.missing.rows.length,0);a.equal(lib.state.scenes.welcome.rows.length,1);
  const id=lib.import(source).draft.clip;
  a.throws(()=>lib.store.audio(id));lib.edit({op:'append',scene:'intro',draft:id});
  a.deepEqual(lib.store.audio(id),bytes);a.deepEqual(fs.readdirSync(lib.clips),[row.clip+'.wav']);lib.close();
  lib=new VoiceLibrary(root);a.equal(lib.state.draft,null);a.deepEqual(lib.audio(id),bytes);
  lib.edit({op:'remove',scene:'intro',row:lib.state.scenes.intro.rows.at(-1).id});
  a.throws(()=>lib.store.audio(id));lib.close();
});
test('唯一声音来源：以 BLOB 保存，重传原子替换、无效上传保留上个，并与固定录音分开',t=>{
  const root=scratch();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const wav=p.join(root,'当前来源.wav'),source=wavFile(root,'测试音色'),audio=fs.readFileSync(source);
  fs.writeFileSync(wav,audio);let lib=new VoiceLibrary(root);a.equal(lib.snapshot().reference,null);
  const original=lib.setReference(wav).reference;lib.setReferenceText(original.id,'准确原话');fs.unlinkSync(wav);
  lib.close();lib=new VoiceLibrary(root);
  a.equal(lib.snapshot().reference.id,original.id);a.equal(lib.snapshot().reference.refText,'准确原话');a.deepEqual(lib.referenceAudio(original.id),audio);
  const fixed=lib.import(source,'intro').scenes.intro.rows.at(-1);
  const other=lib.setReference(wavFile(root,'另一个音色')).reference;
  a.notEqual(other.id,original.id);a.equal(other.refText,'');a.throws(()=>lib.referenceAudio(original.id));a.deepEqual(lib.audio(fixed.clip),audio);
  fs.writeFileSync(wav,'bad');a.throws(()=>lib.setReference(wav));a.equal(lib.store.source().id,other.id);
  a.equal(lib.store.db.prepare('SELECT COUNT(*) AS n FROM voice_source').get().n,1);
  lib.installed=()=>true;a.deepEqual(lib.options({engine:'base',reference:other.id},true),{engine:'base',refDb:lib.store.file,refId:other.id,refText:''});
  a.throws(()=>lib.setReferenceText(original.id,'旧原话'));lib.close();
});
test('信息不足录音必须绑定分类；替换保留原分类，不动其他类',t=>{
  const root=scratch(),lib=new VoiceLibrary(root),wav=wavFile(root);
  t.after(()=>{lib.close();fs.rmSync(root,{recursive:true,force:true})});
  for(const reason of ['DATE','MULTIPLE_CARS'])lib.import(wav,'missing',reason);
  const draft=lib.import(wav).draft.clip;
  for(const reason of [undefined,'UNKNOWN']){
    a.throws(()=>lib.import(wav,'missing',reason),/拦截原因/);
    a.throws(()=>lib.edit({op:'append',scene:'missing',draft,reason}),/拦截原因/);
  }
  lib.edit({op:'append',scene:'missing',draft,reason:'DATE'});
  const [first,other]=lib.state.scenes.missing.rows;
  lib.edit({op:'replace',row:first.id,scene:'missing',draft,reason:'NO_TRIM'});
  const [changed,unchanged]=lib.store.read().scenes.missing.rows;
  a.equal(changed.reason,'DATE');a.equal(changed.clip,draft);a.equal(changed.id,first.id);a.deepEqual(unchanged,other);
});
