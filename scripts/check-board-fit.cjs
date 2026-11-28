// Run: ./node_modules/.bin/electron scripts/check-board-fit.cjs
// Render the real public board with local sample quotes. No production IPC, login or database.
'use strict';
const {app,BrowserWindow,session} = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'quote-board-fit-'));
app.setPath('userData',path.join(tmp,'profile'));
const dir = path.resolve(__dirname,'../app');
const html = fs.readFileSync(path.join(dir,'index.html'),'utf8')
  .replace('<head>','<head><base href="'+pathToFileURL(dir+'/').href+'">')
  .replace(/<script src="\.\/(?!board-view|board-height|board-banner|host-guide)[^"]+"><\/script>/g,'')
  .replace('<script src="./board-view.js">','<script>window.desktop={onQuoteBoard(fn){window.draw=fn},getQuoteBoard(){return Promise.resolve({rev:0,pending:[],history:[]})}}</script><script src="./board-view.js">');
fs.writeFileSync(path.join(tmp,'screen.html'),html);
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:1000,height:810,useContentSize:true,webPreferences:{backgroundThrottling:false}});
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));
  const run=s=>w.webContents.executeJavaScript(s), load=()=>w.loadFile(path.join(tmp,'screen.html'));
  const tick=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  const fill=async(rev,count,long=false,pending)=>{
    const history=Array.from({length:count},(_,i)=>({id:i,car:long?'奔驰E级 E 300 L 豪华型 插电式混合动力 四驱长轴距版':'本田 思域 自动舒适型',name:'林*****',input:{registration:i===4?'':(2022-i)+'-09',mileage:6},low:13.8,high:16.8}));
    await run('draw('+JSON.stringify({rev,history,pending:pending??history})+')');await tick();
  };
  const measure=()=>run(`(()=>{
    const rect=el=>el.getBoundingClientRect(),pane=rect(boardViewport),grip=rect(boardHeightDivider),side=rect(document.querySelector('.account-column details'));
    const cards=[...document.querySelectorAll('.quote-card')],els=[...document.querySelectorAll('.quote-card, .car-name, .card-price, .board-vehicle-photo, .host-caption, .queue-box')];
    return {h:pane.height,width:pane.width,card:cards[0]&&rect(cards[0]).height,photo:cards[0]&&rect(cards[0].querySelector('.board-vehicle-photo')).height,
      price:cards[0]&&rect(cards[0].querySelector('.card-price')).height,count:cards.length,
      fit:els.every(e=>{const r=rect(e);return r.top>=pane.top-1 && r.bottom<=pane.bottom+1 && r.left>=pane.left-1 && r.right<=pane.right+1}),
      // In history the amount can sit above the full-width model. The two
      // boxes must still be disjoint and inside this card at every board zoom.
      inners:cards.every(c=>{const r=rect(c),t=rect(c.querySelector('.car-name')),p=rect(c.querySelector('.card-price'));
        return [t,p].every(b=>b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top-1&&b.bottom<=r.bottom+1)
          && (t.right<=p.left+1||p.right<=t.left+1||t.bottom<=p.top+1||p.bottom<=t.top+1)}),
      height:rect(boardContent).height,side:[side.left,side.width,side.top],x:grip.left+grip.width/2,y:grip.top+grip.height/2};
  })()`);
  await load();
  await run("Quill.find(valuationBanner).setContents([{insert:'直播估价｜收车参考价'},{insert:'\\n',attributes:{header:2}},{insert:'想知道爱车值多少？评论发：车型配置、上牌年份、公里数、所在城市。例：朗逸 230TSI，2017年，12万公里，杭州。\\n'}],'silent');true");
  const slots=()=>run(`[...document.querySelectorAll('#boardCurrent > *,#boardHistory > *')].map(c=>({
    sample:c.matches('.sample-quote'),featured:c.matches('.featured-quote'),height:c.getBoundingClientRect().height,
    surface:getComputedStyle(c).backgroundImage+'|'+getComputedStyle(c).backgroundColor+'|'+getComputedStyle(c).borderRadius,
    marked:/示例报价|演示参考价/.test(c.textContent),
    identity:!!c.querySelector('.board-person .board-name')?.textContent.trim()&&!!c.querySelector('.board-person .board-avatar')?.textContent.trim(),
    populated:!!c.querySelector('.car-name')?.textContent.trim()&&!!c.querySelector('.card-price b')?.textContent,
    localPhoto:c.querySelector('img')?.src?.includes('/quote-samples/')&&c.querySelector('img').naturalWidth>0
  }))`);
  await tick();
  assert.ok(await run(`(()=>{
    const rect=el=>el.getBoundingClientRect(), banner=rect(valuationBanner), text=rect(valuationBanner.querySelector('.ql-editor'));
    const host=rect(document.querySelector('.board-host')),q=rect(document.querySelector('.queue-box'));
    const hero=rect(boardCurrent),history=rect(boardHistory.parentElement);
    const z=parseFloat(getComputedStyle(boardContent).zoom)||1, gap=parseFloat(getComputedStyle(liveBoard).rowGap)*z;
    return banner.height/z>=99 && host.right<banner.left && Math.abs(host.top-banner.top)<1
      && text.top>=banner.top && text.bottom<=banner.bottom && Math.abs((text.top-banner.top)-(banner.bottom-text.bottom))<2
      && Math.abs(hero.top-q.bottom-gap)<1 && Math.abs(history.top-hero.bottom-gap)<1;
  })()`),'prominent copy card alongside the host, only the normal grid gap on either side of the hero');
  const initial=await slots();
  await run("Promise.all([...document.querySelectorAll('.sample-quote img')].map(img=>img.decode())).then(()=>true)");
  assert.equal(initial.length,5);assert.ok(initial.every((c,i)=>c.sample&&!c.marked&&c.identity&&c.populated&&c.height>0&&c.featured===(i===0)));
  assert.ok(await run("boardCurrent.querySelector('.price-label').textContent==='收车参考价'"));
  assert.ok((await slots()).every(c=>c.localPhoto));
  for(let i=0;i<80&&!await run("!!quoteEdge.paperShaderMount");i++)await new Promise(r=>setTimeout(r,40));
  assert.ok(await run("queueCount.textContent==='0人'&&boardQueue.children.length===0&&!queueEmpty.hidden&&quoteEdge.hasAttribute('data-active')&&!!quoteEdge.paperShaderMount"),'bundled sample gets a live rim without adding a viewer');

  if(process.env.QUOTE_SAMPLE_PREVIEW){
    const rect=await run("(()=>{const {x,y,width,height}=boardViewport.getBoundingClientRect();return {x:Math.floor(x),y:Math.floor(y),width:Math.floor(width),height:Math.floor(height)}})()");
    fs.writeFileSync(process.env.QUOTE_SAMPLE_PREVIEW,(await w.webContents.capturePage(rect)).resize({width:420}).toPNG());
  }
  await fill(1,5);const full=await measure();assert.ok(full.fit&&full.count===5);
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#boardCurrent .quote-context, #boardHistory .quote-context'), el=>el.textContent)"),
    ['2022 年 · 6 万公里','2021 年 · 6 万公里','2020 年 · 6 万公里','2019 年 · 6 万公里','6 万公里']);
  w.webContents.debugger.attach('1.3');
  const mouse=(type,x,y,buttons)=>w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons,clickCount:type==='mouseMoved'?0:1});
  const drag=async(target)=>{
    const s=await measure(), y=s.y+target-s.h;
    await mouse('mousePressed',s.x,s.y,1);await mouse('mouseMoved',s.x,y,1);await mouse('mouseReleased',s.x,y,0);
    await tick();const d=await measure();assert.ok(Math.abs(d.h-target)<2,JSON.stringify(d));return d;
  };
  const short=await drag(340),tall=await drag(620);
  assert.deepEqual(tall.side,short.side);assert.equal(short.width,tall.width);
  for(const k of ['card','photo','price']) assert.ok(tall[k]>short[k], k+': '+JSON.stringify([short,tall]));
  for(const d of [short,tall])assert.ok(d.fit&&d.inners&&d.count===5,JSON.stringify(d));
  await drag(180);await fill(2,5,true);
  for(const width of [280,390,580]){
    await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)'");await tick();
    const d=await measure();assert.ok(d.fit&&d.inners&&d.count===5,JSON.stringify(d));
  }
  await fill(3,0);assert.ok((await measure()).fit);
  const sample=await slots();
  for(const n of [1,2,4,5]){
    await fill(3+n,n,false,[]);
    const rows=await slots();assert.equal(rows.length,5);
    rows.forEach((row,i)=>{
      assert.equal(row.sample,i>=n);assert.equal(row.marked,false);
      assert.equal(row.surface,sample[i].surface);
      assert.ok(row.identity&&row.populated&&row.height>0);
    });
    assert.ok(await run("queueCount.textContent==='0人'&&!document.querySelector('.quote-flight-layer')"));
    assert.ok((await measure()).fit);
  }
  await fill(9,0);assert.ok((await slots()).every(c=>c.sample&&!c.marked&&c.identity&&c.populated));
  await fill(10,5,true);assert.ok((await measure()).fit);
  await load();await fill(1,5);assert.equal((await measure()).h,180);
  await run("boardHeightDivider.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");await tick();
  assert.ok(await run("!boardViewport.hasAttribute('data-sized') && !localStorage.getItem('live-board-height')"));
  console.log('PASS: 5 offline samples in regular quote layout without labels, real quotes replace them in order, queue unchanged; drag and responsive board fit.');
  await require('./check-quote-edge.cjs')(w);
  await load();await require('./check-board-handoff.cjs')(w,load);
  w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
