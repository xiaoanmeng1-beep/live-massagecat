'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),os=require('node:os');
const {VoiceLibrary}=require('../voice-library'),{parse,generate}=require('../scripts/generate-reviewed-voice.cjs');
const wav=require('./voice-fixture.cjs');
function setup(t){
  const d=fs.mkdtempSync(p.join(os.tmpdir(),'voice-reviewed-'));const lib=new VoiceLibrary(d);
  t.after(()=>{lib.close();fs.rmSync(d,{recursive:true,force:true})});lib.installed=()=>true;return lib;
}
test('编辑稿的动态报价模板与固定录音分开，七个原因各自保留',()=>{
  const copy=fs.readFileSync(p.resolve(__dirname,'../docs/直播估车-播报话术校对稿.md'),'utf8'),r=parse(copy);
  a.equal(r.rows.length+r.templates.length,copy.split(/\r?\n/).filter(l=>/^\d+\s*[：:.、]/.test(l)).length);
  a.ok(r.templates.length&&r.templates.every(t=>t.includes('{价格}')&&t.includes('{车系}')));
  const missing=r.rows.filter(x=>x.scene==='missing');a.equal(new Set(missing.map(x=>x.reason)).size,7);
  a.ok(r.rows.every(x=>!x.text.includes('{价格}')));
});
test('批量制作只以数据库唯一来源为准，出错整批不入库；测试复用现有 WAV，不合成声音',async t=>{
  const lib=setup(t),r={templates:['{车系}，{价格}'],rows:[{scene:'intro',text:'甲'},{scene:'intro',text:'乙'}]};
  const stored=lib.store.read();await a.rejects(generate(lib,r),/上传原始/);
  const fixture=wav(lib.root),ref=lib.setReference(fixture).reference;lib.setReferenceText(ref.id,'');
  lib.pool.run=async req=>{a.equal(req.refId,ref.id);if(req.text==='乙')throw Error('测试故障');return fs.readFileSync(fixture)};
  await a.rejects(generate(lib,r),/测试故障/);a.deepEqual(lib.store.read(),stored);
  lib.pool.run=async req=>req.warm?null:fs.readFileSync(fixture);
  await generate(lib,r);const next=lib.store.read().scenes.intro.rows;a.deepEqual(next.map(x=>x.text),['甲','乙']);
  a.ok(next.every(x=>x.sourceId===ref.id));a.deepEqual(lib.store.audio(next[0].clip),fs.readFileSync(fixture));
});
