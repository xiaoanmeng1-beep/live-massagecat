// Isolated board fixture: keep the platform profile slot empty, even in captures.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
module.exports=async function checkHostGuide(w,reload){
  const wc=w.webContents, run=s=>wc.executeJavaScript(s), send=(method,params)=>wc.debugger.sendCommand(method,params);
  const tick=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  const skins=['bubble','chevron','route'], key='board-host-guide-v1';
  const click=async sel=>{
    const pt=await run(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:el.contains(document.elementFromPoint(x,y))}})()`);
    assert.ok(pt.hit,'pointer target '+sel);
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:pt.x,y:pt.y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
    await tick();
  };
  const open=async()=>{if(!await run('hostGuideSettings.open'))await click('#hostGuideSettings>summary');};
  const select=skin=>click('label:has(input[name=hostGuideSkin][value='+skin+'])>span');
  const saved=await run('localStorage.getItem('+JSON.stringify(key)+')');
  const banner=await run("localStorage.getItem('valuation-banner-delta-v2')");
  const motion=value=>send('Emulation.setEmulatedMedia',{features:value?[{name:'prefers-reduced-motion',value}]:[]});
  await motion('no-preference');await tick();
  const cycle=await run(`(()=>{
    const fins=[...hostGuide.querySelectorAll('.guide-fin')], animations=fins.flatMap(f=>f.getAnimations());
    const sample=phase=>{for(const a of animations){a.pause();a.currentTime=3700*phase}
      return fins.map(f=>{const s=getComputedStyle(f);return {light:Number(s.opacity),shape:s.clipPath}})};
    const states=[.06,.15,.24,.34,.65].map(sample);for(const a of animations)a.play();
    return states;
  })()`);
  assert.deepEqual(cycle.map(phase=>phase.map(f=>f.light)),[[.32,.32,.32],[1,.32,.32],[1,1,.32],[1,1,1],[1,1,1]]);
  assert.ok(cycle[4].every((f,i)=>f.shape!==cycle[3][i].shape));
  const hops=await run(`(()=>{
    const caption=hostGuide.querySelector('.host-caption'),a=caption.getAnimations()[0],rect=e=>e.getBoundingClientRect();
    const samples=[.1,.14,.19,.23,.27,.75].map(phase=>{
      a.pause();a.currentTime=a.effect.getTiming().duration*phase;
      const t=rect(caption),pointer=rect(hostGuide.querySelector('.host-guide-pointer')),queue=rect(document.querySelector('.queue-box'));
      return {y:t.top,clear:t.top>=pointer.bottom-.1,fixed:[queue.y,rect(valuationBanner).y,pointer.y]};
    });a.play();return samples;
  })()`);
  const [rest,first,land,second,end,wait]=hops;
  assert.ok(first.y<second.y&&second.y<rest.y-1);
  for(const f of [land,end,wait])assert.equal(f.y,rest.y);
  for(const f of hops){assert.ok(f.clear);assert.deepEqual(f.fixed,rest.fixed)}
  // Inspect an untouched mount, rather than CSS animations sought via WAAPI above.
  await motion('reduce');await reload();await tick();
  assert.ok(await run("matchMedia('(prefers-reduced-motion:reduce)').matches"));
  assert.equal(await run("getComputedStyle(hostGuide.querySelector('.host-caption')).animationName"),'none');
  assert.deepEqual(await run("Array.from(hostGuide.querySelectorAll('.guide-fin'),f=>[getComputedStyle(f).animationName,getComputedStyle(f).clipPath])"),cycle[4].map(f=>['none',f.shape]));
  await motion(null);
  await open();await click('#hostGuideInput');
  await run('hostGuideInput.select()');
  await send('Input.insertText',{text:'点主播头像\n关注·私信'});await tick();
  assert.equal(await run("document.querySelector('.host-guide-detail').textContent"),'关注·私信');
  for(const skin of skins){
    await select(skin);
    assert.ok(await run(`hostGuide.dataset.skin==='${skin}'&&hostGuideInput.value==='点主播头像\\n关注·私信'&&document.querySelector('.host-guide-lead').textContent==='点主播头像'`));
  }
  await reload();await tick();
  assert.ok(await run("hostGuide.dataset.skin==='route'&&hostGuideInput.value==='点主播头像\\n关注·私信'&&document.querySelector('input[value=route]').checked"));
  const cols=await run('boardShell.style.gridTemplateColumns');
  for(const width of [280,420,580]){
    await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)';true");await tick();
    let anchor=null;
    for(const skin of skins){
      await run("document.querySelector('input[value="+skin+"]').click();true");await tick();
      const result=await run(`(()=>{const rect=e=>e.getBoundingClientRect(),host=rect(hostGuide.parentNode),t=rect(hostGuide.querySelector('.host-caption')),main=rect(valuationBanner),a=rect(hostGuide.querySelector('.host-guide-pointer'));
        const slot=getComputedStyle(hostGuide.parentNode,'::before'),zoom=parseFloat(getComputedStyle(boardContent).zoom)||1;
        const clear=hostGuide.parentNode.children.length===1 && slot.visibility==='hidden' && parseFloat(slot.width)>=30-.1 && a.top>=host.top+parseFloat(slot.height)*zoom-1;
        return {anchor:[host.x,host.y,host.width,main.x],slot:[slot.width,slot.height,zoom,slot.visibility],lane:[a.top,a.bottom,t.top],fits:clear&&t.left>=host.left-.5&&t.right<=host.right+.5&&t.right<main.left&&a.bottom<=t.top+1,overflow:hostGuide.scrollWidth-hostGuide.clientWidth}})()`);
      assert.ok(result.fits&&result.overflow<=1,JSON.stringify({width,skin,result}));
      if(anchor)assert.deepEqual(result.anchor,anchor);anchor=result.anchor;
    }
  }
  await run(`boardShell.style.gridTemplateColumns=${JSON.stringify(cols)};hostGuideInput.value='<b>文字</b>\\n第二行';hostGuideInput.dispatchEvent(new Event('input'));true`);
  assert.ok(await run("!hostGuide.querySelector('b')&&hostGuide.textContent.includes('<b>文字</b>')"));
  await run("hostGuideInput.value='';hostGuideInput.dispatchEvent(new Event('input'));true");
  await reload();await tick();
  assert.ok(await run("hostGuide.hidden&&hostGuideInput.value===''&&document.querySelector('.board-host').offsetWidth>0"));
  assert.equal(await run("localStorage.getItem('valuation-banner-delta-v2')"),banner);
  if(process.env.HOST_GUIDE_PREVIEW){
    await run(`(()=>{
      hostGuideInput.value='点头像\\n关注·私信';hostGuideInput.dispatchEvent(new Event('input'));
      const sheet=document.createElement('section');sheet.id='guideSheet';
      sheet.innerHTML='<header><small>直播公屏　/　头像引导</small><h1>追上去 · 提示框外观</h1></header><div class="picks"></div><footer>上方留给平台的真实头像和昵称。</footer>';
      const css=document.createElement('style');css.textContent=\`
        #guideSheet {position:fixed;z-index:2147483647;left:0;top:0;width:940px;padding:22px 28px 18px;box-sizing:border-box;color:#14353e;background:radial-gradient(ellipse at 3% 15%,#eee7d9,transparent 58%),radial-gradient(ellipse at 85% 15%,#a2cfe3,transparent 60%),linear-gradient(125deg,#c6dcd9,#dcecf0 58%,#bad9dd);font:14px/1.4 "PingFang SC",sans-serif}
        #guideSheet header small {font-size:11px;color:#42606a;letter-spacing:.08em}#guideSheet h1 {font-size:24px;line-height:1.2;margin:6px 0 16px}
        #guideSheet .picks{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}#guideSheet article {background:#ffffff37;border:1px solid #ffffffcd;border-radius:15px;padding:15px 18px 13px}
        #guideSheet .eyebrow {font-size:10px;font-weight:650;color:#477582;letter-spacing:.15em}#guideSheet h2{margin:3px 0 0;font-size:17px}#guideSheet .slot{position:relative;height:158px;display:grid;place-items:center;container-type:inline-size}
        #guideSheet .board-host{position:relative;align-self:center;justify-self:center;width:78px;transform:scale(1.52)}
        #guideSheet .board-host::before {inline-size:30px}
        #guideSheet p,#guideSheet footer {margin:0;font-size:12px;color:#3e5d65}#guideSheet footer{margin-top:12px;font-size:11px}
        #guideSheet .guide-fin {animation:none}
      \`;document.head.append(css);
      for(const [i,[skin,name,caption]] of [['bubble','圆角气泡','圆角玻璃底。'],['chevron','胶囊','两端全圆角。'],['route','双行路签','主次文案分行。']].entries()){
        const article=document.createElement('article');article.innerHTML='<div class="eyebrow">0'+(i+1)+'</div><h2>'+name+'</h2><div class="slot"></div><p>'+caption+'</p>';
        const host=document.querySelector('.board-host').cloneNode(true),g=host.querySelector('.host-guide');g.removeAttribute('id');g.dataset.skin=skin;
        article.querySelector('.slot').append(host);sheet.querySelector('.picks').append(article);
      }document.body.append(sheet);return true;
    })()`);await tick();
    const size=await run("({x:0,y:0,width:guideSheet.offsetWidth,height:guideSheet.offsetHeight})");
    fs.writeFileSync(process.env.HOST_GUIDE_PREVIEW,(await wc.capturePage(size)).resize({width:1410}).toPNG());
  }
  await run(saved===null?'localStorage.removeItem('+JSON.stringify(key)+')':'localStorage.setItem('+JSON.stringify(key)+','+JSON.stringify(saved)+')');
  await reload();await tick();
  console.log('PASS: independent host CTA text/styles, mouse selection, persistence, empty state, literal text and layout at 280/420/580.');
};
