'use strict';
const fs=require('node:fs'), path=require('node:path'), {randomUUID,randomInt}=require('node:crypto');
const ResidentVoice=require('./resident-voice');
const VoiceStore=require('./voice-store');
const {reasonLabels}=require('./app/live-voice');
const scenes=['welcome','intro','quote','missing'];
const retiredSeed=id=>/^(?:stock-)?(?:welcome|intro|quote|missing)-\d+$/.test(id);
const defaults=()=>({version:1,draft:null,scenes:Object.fromEntries(scenes.map(s=>[s,{
  mode:'sequence',enabled:true,rows:[]
}]))});
const validID=id=>typeof id==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const clean=(v,max)=>typeof v==='string'&&v.trim()&&v.trim().length<=max?v.trim():null;
function requireReason(k){if(!Object.hasOwn(reasonLabels,k))throw Error('请选择信息不足的拦截原因');return k}
const wavLimit=24*1024*1024;
class VoiceLibrary{
  constructor(directory,{stageLegacy=false}={}){
    this.root=path.join(directory,'voice-library');this.engine=path.join(directory,'qwen3-tts');
    this.clips=path.join(this.root,'clips');fs.mkdirSync(this.clips,{recursive:true});
    this.pool=new ResidentVoice(this);this.transient=new Set();
    this.file=path.join(this.root,'library.json');
    this.store=new VoiceStore(path.join(directory,'valuation.sqlite'));
    this.reference=this.store.source();
    const disk=this.store.read(),stored=disk?.pendingLegacySync?null:disk;
    const previous=stored||(fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):defaults());
    if(previous.version!==1||!scenes.every(s=>Array.isArray(previous.scenes?.[s]?.rows)))throw Error('话术库格式异常，原文件已保留');
    this.state=structuredClone(previous);
    // Retired bundled recordings are never re-imported, including from pre-SQLite catalogs.
    let migrated=false;
    for(const scene of scenes){
      const s=this.state.scenes[scene],rows=s.rows.filter(r=>!retiredSeed(r.clip));
      if(rows.length!==s.rows.length){s.rows=rows;migrated=true}
    }
    if(this.state.draft&&retiredSeed(this.state.draft.clip)){this.state.draft=null;migrated=true}
    if(!stored&&this.state.draft)this.draftBytes=this.legacyAudio(this.state.draft.clip);
    if(!stored||migrated)this.store.save(stageLegacy?{...this.state,pendingLegacySync:true}:this.state,id=>this.legacyAudio(id));
  }
  legacyAudio(id){
    if(!validID(id))throw Error('无效录音：'+id);
    const file=path.join(this.clips,id+'.wav');
    if(fs.statSync(file).size>wavLimit)throw Error('音频过大');
    return fs.readFileSync(file);
  }
  commit(next,assets){
    this.store.save(next,id=>{const bytes=assets?.get(id)||(this.state.draft?.clip===id&&this.draftBytes);
      if(!bytes)throw Error('缺少对应的场景录音：'+id);return bytes});
    this.state=next;
  }
  refs(state){return state?[state.draft?.clip,...scenes.flatMap(s=>state.scenes[s].rows.map(r=>r.clip))].filter(Boolean):[]}
  python(){return path.join(this.engine,'.venv','bin','python')}
  installed(engine='design'){
    const folder=engine==='base'?'model-base':'model';
    return process.platform==='darwin'&&fs.existsSync(this.python())&&fs.existsSync(path.join(this.engine,'generate.py'))
      &&['model.safetensors','speech_tokenizer/model.safetensors'].every(f=>fs.existsSync(path.join(this.engine,folder,f)));
  }
  snapshot(){return {...structuredClone(this.state),canGenerate:this.installed(),canClone:this.installed('base'),
    reference:this.reference?{...this.reference}:null}}
  setReference(file){
    if(this.busy)throw Error('请等当前生成完成');
    if(fs.statSync(file).size>wavLimit)throw Error('参考录音太大，请截取 3 到 30 秒');
    const b=fs.readFileSync(file);
    if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw Error('请选择 WAV 参考录音');
    let byteRate=0,dataSize=0;
    for(let i=12;i+8<=b.length;){
      const size=b.readUInt32LE(i+4),tag=b.toString('ascii',i,i+4),start=i+8;
      if(size>b.length-start)throw Error('参考 WAV 不完整');
      if(tag==='fmt '&&size>=16)byteRate=b.readUInt32LE(start+8);
      if(tag==='data')dataSize=size;
      i=start+size+(size%2);
    }
    if(!byteRate || dataSize/byteRate<3 || dataSize/byteRate>30)throw Error('请选择 3 到 30 秒的 WAV 参考录音');
    this.store.replaceSource(randomUUID(),path.basename(file),dataSize/byteRate,b);
    this.reference=this.store.source();return this.snapshot();
  }
  setReferenceText(id,text){
    if(typeof text!=='string'||text.length>400)throw Error('参考原话最多 400 字');
    if(!this.store.sourceText(id,text))throw Error('参考录音已更换');
    this.reference=this.store.source();
  }
  referenceAudio(id){return this.store.sourceAudio(id)}
  progress(){return this.job?{...this.job}:null}
  publish(stage,tokens){
    if(!this.job||(this.job.stage==='cancelling'&&stage!=='cancelled'))return;
    this.job.stage=stage;if(tokens!=null)this.job.tokens=tokens;
    this.onProgress?.(this.progress());
  }
  cancel(id){
    if(!this.job||this.job.id!==id)return false;
    if(this.job.stage==='cancelling')return true;
    this.publish('cancelling');
    this.pool.cancel(id);
    return true;
  }
  audio(id){
    if(!this.refs(this.state).includes(id))throw Error('这条语音已失效');
    if(this.state.draft?.clip===id&&this.draftBytes)return this.draftBytes;
    return this.store.audio(id);
  }
  edit({scene,op,row,draft,mode,enabled,reason}={}){
    if(!scenes.includes(scene))throw Error('请选择场景');
    const next=structuredClone(this.state),s=next.scenes[scene],i=s.rows.findIndex(r=>r.id===row);
    if(op==='saveMode'&&['sequence','random'].includes(mode))s.mode=mode;
    else if(op==='enable'&&typeof enabled==='boolean')s.enabled=enabled;
    else if(op==='remove'&&i>=0)s.rows.splice(i,1);
    else if(op==='append'||op==='replace'){
      if(!next.draft||next.draft.clip!==draft)throw Error('试听稿已变化，请重新选择');
      if(op==='append'){
        if(s.rows.length>=100)throw Error('每个场景最多保存 100 条');s.rows.push({...next.draft,id:randomUUID(),reason:scene==='missing'?requireReason(reason):undefined,role:scene==='quote'?'tail':scene==='missing'?'advice':undefined});
      }else if(i>=0)s.rows[i]={...next.draft,id:row,reason:scene==='missing'?requireReason(s.rows[i].reason):undefined,role:scene==='quote'?'tail':scene==='missing'?'advice':undefined};else throw Error('目标话术已变化');
    }else throw Error('操作或目标话术无效');
    this.commit(next);return this.snapshot();
  }
  options(p={},live=false){
    const engine=p.engine||'design';
    if(!['design','base'].includes(engine)||!this.installed(engine))throw Error('本机未安装所选语音模型');
    if(engine==='design')return {engine,style:clean(p.style,400)||'普通话男声，像车行老板平常说话，价格读清楚。'};
    if(p.reference&&p.reference!==this.reference?.id)throw Error('参考录音已更换');
    if(!this.reference)throw Error('请先在声音来源选择参考 WAV');
    return {engine,refDb:this.store.file,refId:this.reference.id,refText:clean(p.refText??this.reference.refText,400)||''};
  }
  async warm(p){
    const opts=this.options(p,true),key=opts.engine;
    if(this.warming?.key===key)return this.warming.promise;
    if(this.warming)this.pool.cancel(this.warming.id);
    const id=randomUUID(),promise=this.pool.run({...opts,id,warm:true},2).catch(e=>{if(!e.cancelled)throw e});
    this.warming={id,key,promise};try{await promise}finally{if(this.warming?.promise===promise)this.warming=null}
  }
  async ephemeral(p){
    if(!validID(p?.id)||!clean(p.text,160)||this.transient.has(p.id))throw Error('播报任务无效或重复');
    const opts=this.options(p,true);this.transient.add(p.id);
    try{return await this.pool.run({...opts,id:p.id,text:p.text,seed:randomInt(0x7fffffff),clean:true},p.scene==='quote'?0:3)}
    catch(e){if(e.cancelled)return null;throw e}
    finally{this.transient.delete(p.id)}
  }
  cancelLive(id){if(this.transient.has(id))this.pool.cancel(id)}
  endLive(){for(const id of this.transient)this.pool.cancel(id)}
  close(){this.pool.close();this.endLive();this.draftBytes=null;this.state.draft=null;this.store.close()}
  async generate({text,style,engine='design',reference,refText,cleanAudio=true}={}){
    if(!['design','base'].includes(engine))throw Error('未知的生成模型');
    if(this.busy)throw Error('正在生成上一条语音');if(!this.installed(engine))throw Error('此机未安装所选的生成引擎，可直接播放已有话术或导入 WAV');
    text=clean(text,300);if(!text)throw Error('请填写 300 字以内的目标话术');
    if(engine==='base'){
      if(!this.reference||this.reference.id!==reference)throw Error('请重新选择参考 WAV');
      if(refText!=null&&(typeof refText!=='string'||refText.trim().length>400))throw Error('参考原话最多 400 字');
      refText=refText?.trim()||'';
      style='参考音色：'+this.reference.name;
    }else{
      style=clean(style,400);if(!style)throw Error('请填写 400 字以内的语气提示词');
    }
    const clip=randomUUID(),seed=randomInt(0x7fffffff);
    this.busy=true;
    this.job={id:clip,stage:'loading',started:Date.now(),tokens:0};this.publish('loading');
    try{
      const bytes=await this.pool.run({...this.options({engine,style,reference,refText}),id:clip,text,seed,clean:!!cleanAudio},1,(s,n)=>this.publish(s,n));
      if(this.job.stage==='cancelling')throw Error('已取消');
      if(!bytes||bytes.length<=44)throw Error('引擎未返回有效音频');
      this.commit({...this.state,draft:{clip,text,style,seed,engine,mode:engine==='base'?(refText?'transcript':'audio-only'):'design'}});
      this.draftBytes=bytes;
      this.publish('complete');
      return this.snapshot();
    }catch(e){if(this.job.stage==='cancelling'){this.publish('cancelled');return {cancelled:true}}this.publish('failed');throw e}
    finally{this.job=null;this.busy=false}
  }
  import(file,scene,reason){
    if(this.busy)throw Error('请等当前生成完成');
    if(scene!==undefined&&!scenes.includes(scene))throw Error('目标场景无效');
    if(scene&&this.state.scenes[scene].rows.length>=100)throw Error('每个场景最多保存 100 条');
    if(fs.statSync(file).size>wavLimit)throw Error('请选择小于 24 MB 的 WAV 文件');
    const buf=fs.readFileSync(file);
    if(buf.length<=44||buf.toString('ascii',0,4)!=='RIFF'||buf.toString('ascii',8,12)!=='WAVE')throw Error('请选择 WAV 音频');
    const clip=randomUUID();
    const next=structuredClone(this.state),item={clip,text:path.basename(file,path.extname(file)).slice(0,300),style:'导入录音'};
    if(scene)next.scenes[scene].rows.push({...item,id:randomUUID(),reason:scene==='missing'?requireReason(reason):undefined,role:scene==='quote'?'tail':scene==='missing'?'advice':undefined});else next.draft=item;
    this.commit(next,scene?new Map([[clip,buf]]):undefined);if(!scene)this.draftBytes=buf;return this.snapshot();
  }
}
function registerVoiceIpc(ipc,library,window,dialog){
  const handle=(key,fn)=>ipc.handle('voice:'+key,(event,arg)=>{
    if(!window()||event.sender!==window().webContents||event.senderFrame!==event.sender.mainFrame)throw Error('仅支持主窗口');
    return fn(arg);
  });
  handle('get',()=>library.snapshot());handle('generate',p=>library.generate(p));handle('audio',id=>library.audio(id));
  library.onProgress=p=>{const win=window();if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('voice:progress',p)};
  handle('warm',p=>library.warm(p));handle('make-live',p=>library.ephemeral(p));handle('drop-live',id=>library.cancelLive(id));handle('end-live',()=>library.endLive());
  handle('progress-get',()=>library.progress());handle('cancel',id=>library.cancel(id));
  handle('reference-text',p=>library.setReferenceText(p.id,p.text));
  handle('reference-audio',id=>library.referenceAudio(id));
  handle('reference',async()=>{
    const {canceled,filePaths}=await dialog.showOpenDialog(window(),{title:'选择参考音色（本地 WAV）',properties:['openFile'],filters:[{name:'WAV 音频',extensions:['wav']}]});
    return canceled?null:library.setReference(filePaths[0]);
  });
  handle('export',async clip=>{
    const draft=library.state.draft;
    if(!draft||draft.clip!==clip)throw Error('请先生成或导入当前试听稿');
    const audio=library.audio(clip);
    const label=Array.from(draft.text).slice(0,32).join('').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();
    const {canceled,filePath}=await dialog.showSaveDialog(window(),{
      title:'导出当前试听稿',defaultPath:'话术-'+(label||'试听稿')+'.wav',
      filters:[{name:'WAV 音频',extensions:['wav']}]
    });
    if(canceled||!filePath)return null;
    await fs.promises.writeFile(filePath,audio);
    return path.basename(filePath);
  });
  handle('edit',p=>library.edit(p));handle('import',async target=>{
    const scene=typeof target==='string'?target:target?.scene;
    const {canceled,filePaths}=await dialog.showOpenDialog(window(),{title:scene?'添加场景录音':'导入试听稿',properties:['openFile'],filters:[{name:'WAV 音频',extensions:['wav']}]});
    return canceled?null:library.import(filePaths[0],scene,target?.reason);
  });
}
module.exports={VoiceLibrary,registerVoiceIpc};
