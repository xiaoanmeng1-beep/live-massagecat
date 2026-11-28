// No generation unless an operator explicitly supplies --generate after reviewing the copy.
'use strict';
const fs=require('node:fs'),p=require('node:path'),{randomUUID,randomInt}=require('node:crypto');
const headings={'一、欢迎语':'welcome','二、直播间介绍':'intro','三、估车报价':'quote','四、信息不足':'missing'};
const codes={'提到多辆车':'MULTIPLE_CARS','年份不清楚':'DATE','多个可能车型':'AMBIGUOUS_SERIES','车名与型号矛盾':'MODEL_CONFLICT','车系未识别':'NO_SERIES','配置不匹配':'NO_TRIM','年份没有对应车款':'NO_YEAR_MATCH'};
function parse(text){
  const rows=[],templates=[];let scene='',sub='';
  for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line)continue;
    if(line.startsWith('## ')){scene=headings[line.slice(3)];sub='';if(!scene)throw Error('未知场景：'+line);continue}
    if(!scene)continue;
    if(line.startsWith('### ')){const name=line.slice(4);sub=scene==='missing'?codes[name]:scene==='quote'?(name.startsWith('实时报价主句')?'templates':name.startsWith('可选私信尾句')?'tails':''):'';
      if(!sub)throw Error('未知分组：'+line);continue}
    const m=line.match(/^\d+\s*[：:.、]\s*(.+)$/u);if(!m)throw Error('请把每句话单独编号：'+line);
    const value=m[1].trim();
    if(scene==='quote'&&sub==='templates'){
      if(!value.includes('{车系}')||!value.includes('{价格}'))throw Error('报价主句缺少占位符：'+value);
      templates.push(value);continue;
    }
    if(scene==='quote'&&sub!=='tails'||scene==='missing'&&!sub)throw Error('话术分组缺失');
    rows.push({scene,text:value,...(scene==='missing'?{reason:sub}:{})});
  }
  if(!rows.length)throw Error('文件中没有固定话术');
  return {rows,templates};
}
async function generate(lib,review){
  const source=lib.snapshot().reference;if(!source)throw Error('请先在应用的声音来源上传原始 WAV');
  const opt=lib.options({engine:'base',reference:source.id,refText:source.refText});const start=lib.store.read();
  const assets=new Map(),todo=review.rows.map(r=>({...r,id:randomUUID(),clip:randomUUID()}));
  try{
    await lib.warm({...opt,reference:source.id});
    await Promise.all(todo.map(async r=>{
      const bytes=await lib.pool.run({...opt,id:r.clip,text:r.text,seed:randomInt(0x7fffffff),clean:true},4);
      if(!bytes||bytes.length<=44||bytes.toString('ascii',8,12)!=='WAVE')throw Error('无有效录音：'+r.text);
      assets.set(r.clip,bytes);
    }));
    const next=structuredClone(lib.state);for(const scene of Object.keys(next.scenes)){
      // Retain manually added/replaced rows; replace only built-in and earlier published copy.
      next.scenes[scene].rows=next.scenes[scene].rows.filter(r=>!r.reviewed&&!/^(stock-)?(welcome|intro|quote|missing)-\d+$/.test(r.clip));
    }
    for(const r of todo)next.scenes[r.scene].rows.push({...r,engine:'base',reviewed:true,sourceId:source.id,
      ...(r.scene==='quote'?{role:'tail'}:r.scene==='missing'?{role:'advice'}:{})});
    next.quoteTemplates=review.templates;
    lib.store.save(next,id=>{const b=assets.get(id);if(!b)throw Error('缺少录音');return b},()=>{
      if(JSON.stringify(lib.store.read())!==JSON.stringify(start)||lib.store.source()?.id!==source.id)throw Error('生成期间话术库或声音来源已变化，本次未覆盖');
    });lib.state=next;
  }catch(e){for(const r of todo)lib.pool.cancel(r.clip);throw e}
}
async function main(){
  const [mode,file]=process.argv.slice(2);if(!['--check','--generate'].includes(mode)||!file||process.argv.length!==4)throw Error('用法：--check 校对稿.md；确认生成后才用 --generate 校对稿.md');
  const review=parse(fs.readFileSync(file,'utf8'));console.log('固定话术',review.rows.length,'动态模板',review.templates.length);if(mode==='--check')return;
  const {VoiceLibrary}=require('../voice-library'),lib=new VoiceLibrary(p.resolve(__dirname,'../data'));
  try{await generate(lib,review);console.log('已保存到 SQLite')}finally{lib.close()}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={parse,generate};
