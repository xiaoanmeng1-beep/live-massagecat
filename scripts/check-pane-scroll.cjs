// Exercise native wheel scrolling in the real layout without touching a running valuation.
'use strict';
const {app,BrowserWindow,ipcMain,session}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'valuation-pane-scroll-'));
app.setPath('userData',path.join(tmp,'profile'));
const dir=path.resolve(__dirname,'../app');
const preload=path.resolve(dir,'../preload.js');
app.whenReady().then(async()=>{
  const ses=session.fromPartition('pane-scroll-test');
  ses.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>cb({cancel:true}));
  for(const [,name] of fs.readFileSync(preload,'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)){
    ipcMain.handle(name,()=>name==='live:board'?{rev:0,pending:[],history:[]}:[]);
  }
  const w=new BrowserWindow({show:false,useContentSize:true,titleBarStyle:'hiddenInset',webPreferences:{backgroundThrottling:false,session:ses,preload}});
  const wc=w.webContents,run=s=>wc.executeJavaScript(s);
  await w.loadFile(path.join(dir,'index.html'));
  wc.debugger.attach();
  const sleep=n=>new Promise(ok=>setTimeout(ok,n));
  const setup=()=>run(`(()=>{
    window.L=document.querySelector('.valuation-column');window.R=document.querySelector('.account-column');
    window.T=document.querySelector('.titlebar-drag-region');
    for(const el of R.querySelectorAll('details'))el.open=true;
    // Left normally fits. Add only a blank fixture below the board to exercise overflow both ways.
    if(!L.querySelector('[data-scroll-fixture]')){
      const tail=document.createElement('div');tail.dataset.scrollFixture='';tail.style.height='1600px';L.append(tail);
    }
    L.scrollTop=R.scrollTop=0;return true;
  })()`);
  const stat=()=>run(`({left:L.scrollTop,right:R.scrollTop,page:document.scrollingElement.scrollTop,
    header:T.getBoundingClientRect().top,barBottom:T.getBoundingClientRect().bottom,drag:getComputedStyle(T).webkitAppRegion,
    hero:boardViewport.getBoundingClientRect().top, config:R.firstElementChild.getBoundingClientRect().top,
    leftMax:L.scrollHeight-L.clientHeight,rightMax:R.scrollHeight-R.clientHeight})`);
  const wheel=async(side,dy)=>{
    const point=await run(`(()=>{const r=${side}.getBoundingClientRect();return {x:r.left+16,y:Math.min(innerHeight-24,r.top+76)}})()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:dy});
    await sleep(230);
  };
  const fixed=(s,base)=>{assert.equal(s.page,0);assert.equal(s.header,0);assert.equal(s.barBottom,base.barBottom);assert.equal(s.drag,'drag');};
  for(const [width,height] of [[920,760],[650,420],[400,350]]){
    w.setContentSize(width,height);await setup();await sleep(130);
    const base=await stat();
    assert.ok(base.leftMax>0 && base.rightMax>0,'Both columns must have their own overflow: '+JSON.stringify(base));
    assert.ok(base.hero>=base.barBottom && base.config>=base.barBottom);
    const prices=await run(`[...boardHistory.children].map(row=>{
      const priceEl=row.querySelector('.card-price');
      const rect=e=>e.getBoundingClientRect(), card=rect(row), price=rect(priceEl);
      const info=rect(row.querySelector('.card-info'));
      return {offset:(price.top+price.bottom-card.top-card.bottom)/2,
        inside:price.left>=card.left && price.right<=card.right && price.top>=card.top && price.bottom<=card.bottom,
        right:price.left>=info.right-1 && card.right-price.right<12,
        black:[...priceEl.querySelectorAll('b,small')].every(el=>getComputedStyle(el).color==='rgb(0, 0, 0)')};
    })`);
    assert.equal(prices.length,4);
    assert.ok(prices.every(p=>Math.abs(p.offset)<1 && p.inside && p.right && p.black),JSON.stringify(prices));
    if(width===920){
      const metrics=await run(`(()=>{
        const row=boardHistory.firstElementChild, zoom=parseFloat(getComputedStyle(boardContent).zoom)||1;
        const size=sel=>+(parseFloat(getComputedStyle(row.querySelector(sel)).fontSize)*zoom).toFixed(1);
        return {model:size('.car-name'),price:size('.card-price b'),meta:size('.quote-context'),name:size('.board-name')};
      })()`);
      console.log('Displayed history text (CSS px):',metrics);
      assert.ok(metrics.model>=18&&metrics.price>=25&&metrics.meta>=14&&metrics.name>=14,
        'Check the visible sizes after board auto-fit, not just the stylesheet');
      if(process.env.QUOTE_HISTORY_PREVIEW){
        const rect=await run('(()=>{const r=boardHistory.parentElement.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()');
        fs.writeFileSync(process.env.QUOTE_HISTORY_PREVIEW,(await wc.capturePage(rect)).toPNG());
      }
    }
    await wheel('R',180);const r=await stat();fixed(r,base);
    assert.ok(r.right>0);assert.equal(r.left,0);assert.equal(r.hero,base.hero);
    await wheel('L',150);const l=await stat();fixed(l,base);
    assert.ok(l.left>0);assert.equal(l.right,r.right);assert.equal(l.config,r.config);
    await run('R.scrollTop=R.scrollHeight;true');await wheel('R',640);
    const edge=await stat();fixed(edge,base);assert.equal(edge.left,l.left);assert.ok(Math.abs(edge.right-edge.rightMax)<=1);
    await run('L.scrollTop=0;true');await wheel('L',-640);
    const top=await stat();fixed(top,base);assert.equal(top.left,0);assert.equal(top.right,edge.right);
    console.log('PASS '+width+'x'+height+': independent left/right wheel, no scroll chaining, fixed native drag strip.');
  }
  w.destroy();app.quit();
}).catch(err=>{console.error(err);app.exit(1);});
