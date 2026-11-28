'use strict';
(()=>{
  const panel=document.getElementById('voicePanel'),api=window.desktop;
  if(!panel||!api?.getVoices)return;
  const el=id=>document.getElementById('voice'+id);
  let library,busy=false,action='',statusEpoch=0;
  const rules=window.LiveVoices,storeKey='live-voice-rules-v2';let prefs={};
  try{prefs=JSON.parse(localStorage.getItem(storeKey))||{}}catch{}
  function save(){try{localStorage.setItem(storeKey,JSON.stringify(prefs))}catch{}}
  const profile=()=>({engine:el('Model').value,style:el('Style').value,reference:library?.reference?.id,refText:el('RefText').value});
  let warmEpoch=0,warmState="";
  function warm(){
    const p=profile(),seq=++warmEpoch;
    if(!library||!(p.engine==='base'?library.canClone&&library.reference:library.canGenerate))return;
    el('Engine').textContent=warmState='正在预热本机语音模型…';
    api.warmVoice(p).then(()=>{if(seq===warmEpoch)el('Engine').textContent=warmState='模型已预热 · 直播和试听共用'}).catch(e=>{if(seq===warmEpoch)el('Engine').textContent=warmState='预热失败：'+e.message});
  }
  const player=new rules.LivePlayer({
    synth:(text,id,scene)=>api.makeLiveVoice({...profile(),text,id,scene}),abort:id=>api.dropLiveVoice(id).catch(()=>{}),settings:()=>({...prefs,templates:prefs.templates||library?.quoteTemplates}),
    load:(id,item)=>item.bytes||(item.reference?api.voiceReferenceAudio(id):api.voiceAudio(id)),report:msg=>{el('Playing').textContent=msg},
    play(bytes,done){
      const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})),audio=new Audio(url);
      audio.onended=()=>done();audio.onerror=()=>done('请确认 WAV 文件可播放');
      audio.play().catch(e=>done(e.message));
      return ()=>{audio.onended=audio.onerror=null;audio.pause();audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url)};
    }
  });
  // Each visible recording owns its controls and cursor. Opening the settings does
  // not read every WAV into memory; closed banks never fetch their recordings.
  const widgets=new Map(),observer=new IntersectionObserver(entries=>{
    for(const e of entries)if(e.isIntersecting)widgets.get(e.target)?.load();
  });
  function clearAudio(slot){
    const w=widgets.get(slot);if(!w)return;
    widgets.delete(slot);observer.unobserve(slot);
    if(player.current?.audition===w)player.stop(false);
    w.audio.onplay=w.audio.onpause=w.audio.onended=w.audio.onerror=null;
    w.audio.pause();w.audio.removeAttribute('src');w.audio.load();
    if(w.url)URL.revokeObjectURL(w.url);slot.replaceChildren();
  }
  function showAudio(slot,item,isReference=false){
    const old=widgets.get(slot);
    if(old&&item?.clip===old.clip)return;
    clearAudio(slot);if(!item)return;
    const audio=document.createElement('audio'),replay=document.createElement('button');
    audio.controls=true;audio.preload='metadata';audio.className='voice-audio';
    audio.setAttribute('aria-label',item.text+' 播放器');replay.type='button';replay.textContent='从头重听';
    const w={clip:item.clip,audio,loading:null,url:null};
    const release=()=>{if(player.current?.audition===w){player.stop(false);player.drain()}};
    audio.onplay=()=>{if(audio.paused||player.current?.audition===w)return;
      player.stop(false);player.current={preview:true,audition:w,clip:item.clip};
      player.cleanup=()=>audio.pause();player.report('正在播放：'+item.text);
    };
    audio.onpause=()=>{if(audio.paused)release()};audio.onended=release;
    audio.onerror=()=>{release();note('这条 WAV 播放失败。')};
    w.load=()=>{
      if(w.url)return Promise.resolve(true);
      if(!w.loading)w.loading=(isReference?api.voiceReferenceAudio(item.clip):api.voiceAudio(item.clip)).then(bytes=>{
        if(widgets.get(slot)!==w)return false;
        audio.src=w.url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));return true;
      }).catch(err=>{if(widgets.get(slot)===w)note('录音读取失败：'+err.message);return false}).finally(()=>{w.loading=null});
      return w.loading;
    };
    replay.onclick=async()=>{if(await w.load()&&widgets.get(slot)===w){audio.currentTime=0;audio.play().catch(e=>note(e.message))}};
    widgets.set(slot,w);slot.append(audio,replay);observer.observe(slot);
  }
  const note=s=>{el('Note').textContent=s};
  let job=null,progressEvents=0;
  const stages={waiting:'先生成直播报价，随后继续试听',loading:'加载模型',preparing:'准备声音',generating:'正在合成',finishing:'整理试听音频',cancelling:'正在取消'};
  function drawJob(){
    el('Job').hidden=!job;if(!job)return;
    const stage=job.stage,secs=Math.max(0,Math.floor((Date.now()-job.started)/1000));
    const n={loading:1,preparing:2,generating:3,finishing:4}[stage];
    if(n)el('JobBar').value=n;else el('JobBar').removeAttribute('value');
    el('JobText').textContent=(n?n+'/4 · ':'')+(stages[stage]||'处理中')+
      (stage==='generating'?' · 已合成约 '+(job.tokens/12.5).toFixed(1)+' 秒音频':'')+' · 已用 '+secs+' 秒';
    el('Cancel').disabled=stage==='cancelling';
  }
  function updateJob(p){
    job=p&&stages[p.stage]?p:null;drawJob();buttons();
    if(!job&&p&&action!=='generate'){
      api.getVoices().then(s=>{library=s;render()}).catch(e=>note(e.message));
      note(p.stage==='complete'?'新试听稿已就绪。':p.stage==='cancelled'?'已取消，上一条试听稿保留。':'生成失败。');
    }
  }
  api.onVoiceProgress(p=>{progressEvents++;updateJob(p)});
  api.getVoiceProgress().then(p=>{if(!progressEvents&&p)updateJob(p)}).catch(()=>{});
  el('Cancel').onclick=async()=>{if(!job)return;el('Cancel').disabled=true;try{await api.cancelVoice(job.id)}catch(e){note(e.message);drawJob()}};
  const base=()=>el('Model').value==='base';
  if(['base','design'].includes(prefs.engine))el('Model').value=prefs.engine;
  el('Model').onchange=()=>{prefs.engine=el('Model').value;save();note('');render();warm()};
  panel.addEventListener('toggle',()=>{if(panel.open)warm()});
  el('RefText').oninput=()=>{buttons();const id=library?.reference?.id;if(id)api.saveVoiceRefText(id,el('RefText').value).catch(e=>note(e.message))};
  el('PickReference').onclick=()=>work('reference',async()=>{
    const next=await api.chooseVoiceReference();
    if(next){el('RefText').value='';setTimeout(warm,0)}
    return next;
  },'已选参考录音，可以直接生成。');
  for(const key of ['Style','Text']){
    const field=el(key),store='voice-editor-v1-'+key;
    try{const value=localStorage.getItem(store);if(value!==null)field.value=value}catch{}
    field.addEventListener('input',()=>{try{localStorage.setItem(store,field.value)}catch{};buttons()});
  }
  const names={welcome:'欢迎语',intro:'直播间介绍',quote:'估车报价',missing:'信息不足提醒'};
  const banks=new Map();
  function append(scene){
    if(library?.draft)edit(scene,{op:'append',draft:library.draft.clip,reason:banks.get(scene)?.reason?.value},'试听稿已加入「'+names[scene]+'」。');
  }
  for(const [scene,name] of Object.entries(names)){
    const bank=el('BankTemplate').content.firstElementChild.cloneNode(true);
    bank.dataset.bank=scene;bank.setAttribute('aria-label',name);bank.querySelector('h3').textContent=name;
    const parts={nodes:new Map()};
    const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent='管理话术';detail.append(summary);
    for(const node of Array.from(bank.children).slice(1))detail.append(node);
    bank.append(detail);
    const info=document.createElement('p');info.className='voice-rule-hint';bank.querySelector('header').after(info);
    info.textContent={welcome:'进人后聚合欢迎 · 有评论可提前播 · 一个随机池',intro:'空档约 3 秒 · 主题轮换',quote:'即时车系＋价格 · 私信尾句默认约 1/3',missing:'仅空档 · 昵称前五字＋老板 · 最多每分钟一次'}[scene];
    if(scene==='quote'){
      const ed=document.createElement('textarea');ed.setAttribute('aria-label','报价主句模板，每行一句');ed.rows=3;ed.value=(prefs.templates||rules.templates).join('\n');
      ed.onchange=()=>{const v=ed.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        if(!v.length||v.length>12||v.some(x=>x.length>90||!x.includes('{车系}')||!x.includes('{价格}'))){ed.value=(prefs.templates||rules.templates).join('\n');note('每句都要有 {车系} 和 {价格}，最多 12 句。');return}prefs.templates=v;save()};
      const label=document.createElement('label');label.textContent='报价主句 · 每行一句';label.append(ed);summary.after(label);
    }
    if(scene==='missing'){
      const select=document.createElement('select');select.setAttribute('aria-label','拦截原因');
      for(const [code,title] of Object.entries(rules.reasonLabels))select.add(new Option(title,code));
      const label=document.createElement('label');label.textContent='拦截原因';label.append(select);summary.after(label);
      parts.reason=select;select.onchange=()=>{if(library)renderBank(scene,parts)};

    }

    for(const key of ['import','append','count'])parts[key]=bank.querySelector('[data-'+key+']');
    parts.rows=bank.querySelector('ol');parts.rows.setAttribute('aria-label',name+'录音列表');
    parts.import.onclick=()=>work('import',()=>api.importVoice(scene,parts.reason?.value),'录音已添加到「'+name+'」。');
    parts.append.onclick=()=>append(scene);
    const target=document.createElement('button');target.type='button';target.textContent=name;
    target.dataset.target=scene;target.onclick=()=>append(scene);parts.target=target;el('DraftTargets').append(target);
    banks.set(scene,parts);el('Banks').append(bank);
  }
  function buttons(){
    const ready=base()?library?.canClone&&library.reference:library?.canGenerate&&el('Style').value.trim();
    el('Generate').disabled=busy||!!job||!ready||!el('Text').value.trim();
    el('Model').disabled=busy||!library;
    el('PickReference').disabled=busy||!library?.canClone;
    el('RefText').disabled=busy;
    el('DesignFields').hidden=base();el('BaseFields').hidden=!base();
    el('Generate').textContent=action==='generate'?'正在本机生成…':'生成试听稿';
    el('Import').disabled=busy||!library;
    el('Export').disabled=busy||!library?.draft;
    for(const b of banks.values()){
      b.import.disabled=busy||!library;
      b.append.disabled=b.target.disabled=busy||!library?.draft;
    }
    el('Auto').disabled=!library;
  }
  function render(){
    buttons();if(!library)return;player.update(library);
    const ref=library.reference;
    showAudio(el('RefSlot'),base()&&ref?{clip:ref.id,text:ref.name}:null,true);
    showAudio(el('DraftSlot'),library.draft);
    el('RefName').textContent=ref?ref.name+' · '+ref.seconds.toFixed(1)+' 秒'+(ref.seconds<5?'（偏短）':''):'尚未上传参考 WAV';
    el('Engine').textContent=(base()?library.canClone:library.canGenerate)?(warmState||'本机 Qwen3 · 离线生成'):'本机未安装所选的生成引擎。已有语音可直接播放，也可导入其他电脑生成的 WAV。';
    el('Draft').hidden=!library.draft;el('DraftText').textContent=library.draft?.text||'';
    for(const [scene,b] of banks)renderBank(scene,b);
  }
  function renderBank(scene,b){
    const all=library.scenes[scene].rows,reason=b.reason?.value;
    const rows=reason?rules.rowsForReason(all,reason):all;
    const category=rules.reasonLabels[reason],list=b.rows;
    b.count.textContent=all.length+' 条';
    if(category){
      b.count.textContent=all.length+' 条 · 本类 '+rows.length+' 条';
      b.target.textContent=names[scene]+' · '+category;
    }
    const keep=new Set(rows.map(r=>r.id));
    for(const [id,n] of b.nodes)if(!keep.has(id)){clearAudio(n.slot);n.li.remove();b.nodes.delete(id)}
    if(!rows.length){
      if(!b.empty){b.empty=document.createElement('li');list.append(b.empty)}
      b.empty.textContent=category?'「'+category+'」暂无录音。':'这个场景还没有录音。';return;
    }
    b.empty?.remove();b.empty=null;
    rows.forEach((r,i)=>{
      let n=b.nodes.get(r.id);
      if(!n){
        const li=document.createElement('li'),p=document.createElement('p'),slot=document.createElement('div'),actions=document.createElement('div');
        actions.className='voice-actions';slot.dataset.playerRow=r.id;
        const replace=document.createElement('button'),remove=document.createElement('button');
        replace.type=remove.type='button';replace.textContent='用试听稿替换';remove.textContent='删除';
        actions.append(replace,remove);li.append(p,slot,actions);
        n={li,p,slot,replace,remove};b.nodes.set(r.id,n);
      }
      if(list.children[i]!==n.li)list.insertBefore(n.li,list.children[i]||null);
      n.p.textContent=(i+1)+'. '+r.text;showAudio(n.slot,r);
      n.replace.disabled=busy||!library.draft;n.remove.disabled=busy;
      n.replace.onclick=()=>{if(window.confirm('用当前试听稿替换第 '+(i+1)+' 条？'))
        edit(scene,{op:'replace',row:r.id,draft:library.draft.clip,reason:r.reason},'已替换，顺序不变。')};
      n.remove.onclick=()=>{if(window.confirm('删除第 '+(i+1)+' 条录音？'))edit(scene,{op:'remove',row:r.id},'已删除。')};
    });
  }
  async function work(kind,call,msg){
    if(busy)return;busy=true;action=kind;note(kind==='generate'?'正在合成，请稍等。成功后可试听再入库。':'');render();
    try{const next=await call();if(next?.cancelled){note('已取消生成，上一条试听稿保留。')}else if(next){library=next;note(msg)}}catch(e){note('操作失败：'+e.message)}
    finally{busy=false;action='';render()}
  }
  const edit=(scene,payload,msg)=>work('edit',()=>api.editVoice({scene,...payload}),msg);
  el('Generate').onclick=()=>{const p=base()
    ?{engine:'base',text:el('Text').value,refText:el('RefText').value,reference:library?.reference?.id}
    :{engine:'design',style:el('Style').value,text:el('Text').value};
    p.cleanAudio=el('Clean').checked;
    work('generate',()=>api.generateVoice(p),'新试听稿已就绪，尚未加入任何场景。')};
  el('Import').onclick=()=>work('import',()=>api.importVoice(),'录音已导入试听区。');
  el('Export').onclick=async()=>{
    if(busy||!library?.draft)return;
    busy=true;render();
    try{const name=await api.exportVoice(library.draft.clip);if(name)note('已导出：'+name)}
    catch(e){note('导出失败：'+e.message)}
    finally{busy=false;render()}
  };
  el('Auto').onchange=()=>{player.setAuto(el('Auto').checked);if(player.auto)warm();else api.endLiveVoices();
    note(player.auto?(player.room?'自动播报已开启。':'已开启，等待直播间进入采集状态。'):'自动播报已关闭。')};
  function sync(s){const capture=s?.process?.capture;
    player.live(s?.state==='connected'&&capture?.room===s.room&&capture?.phase==='listening'?s.room:'')}
  api.onLiveStatus(s=>{statusEpoch++;sync(s)});
  api.getLiveStatus().then(s=>{if(!statusEpoch)sync(s)}).catch(()=>{});
  api.onVoiceCue(({scene,room,...event})=>player.cue(scene,room,event));
  const timer=setInterval(()=>{player.tick();if(job)drawJob()},1000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);player.setAuto(false);for(const slot of widgets.keys())clearAudio(slot);observer.disconnect();api.endLiveVoices()},{once:true});
  buttons();api.getVoices().then(state=>{if(!state?.scenes)return;library=state;
    if(!prefs.templates&&state.quoteTemplates?.length){const ed=panel.querySelector('[data-bank=quote] textarea');if(ed)ed.value=state.quoteTemplates.join('\n')}
    if(state.reference?.refText)el('RefText').value=state.reference.refText;
    render();warm()}).catch(e=>note('语音库读取失败：'+e.message));
})();
