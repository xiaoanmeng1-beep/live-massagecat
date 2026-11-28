// Offline Electron regression: real toolbar hit targets, drag selection and keyboard/IME input.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
async function check(w, reload) {
  const wc = w.webContents, run = s => wc.executeJavaScript(s);
  const send = (method, params) => wc.debugger.sendCommand(method, params);
  const tick = () => run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  const tb='.banner-format-tools ', root='#bannerRichInput .ql-editor', board='#valuationBanner .ql-editor';
  const query = (selector, prop) => run('document.querySelector('+JSON.stringify(selector)+')?.'+prop);
  const coords = async sel => {
    const pt=await run(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;
      el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      return {x,y,hit:el.contains(document.elementFromPoint(x,y))}})()`);
    assert.ok(pt?.hit,'hit target: '+sel+' '+JSON.stringify(pt));return pt;
  };
  const mouse=(type,p)=>send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
  async function click(sel) {const p=await coords(sel);await mouse('mousePressed',p);await mouse('mouseReleased',p);await tick();}
  const type=text=>send('Input.insertText',{text});
  const choose=async (name,value)=>{
    await click(tb+'.ql-picker.ql-'+name+' .ql-picker-label');
    await click(tb+'.ql-picker.ql-'+name+' .ql-picker-item[data-value="'+value+'"]');
  };
  const summary='.settings-group:has(#bannerRichInput) > summary';
  async function open(){if (!await query('#bannerRichInput', "closest('details').open")) await click(summary);}
  const style = (selector, property) => run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&getComputedStyle(n)[${JSON.stringify(property)}]})()`);
  async function drag(word) {
    const points=await run(`(()=>{const e=document.querySelector('${root}');e.scrollIntoView({block:'nearest'});
      const it=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n;while(n=it.nextNode()){
        const i=n.data.indexOf(${JSON.stringify(word)});if(i<0)continue;
        const pos=j=>{const r=document.createRange();r.setStart(n,j);r.collapse(true);const b=r.getBoundingClientRect();return {x:b.x+.2,y:b.y+b.height/2}};
        return [pos(i),pos(i+${word.length})]}})()`);
    assert.ok(points,'drag word '+word);await mouse('mousePressed',points[0]);await mouse('mouseMoved',points[1]);await mouse('mouseReleased',points[1]);await tick();
    assert.equal(await run('getSelection().toString()'),word);
  }
  assert.ok(await query(root,'isContentEditable'));
  assert.equal(await query(board,'isContentEditable'),false);
  assert.equal(await query(board,'textContent'),'');
  assert.ok(await run("!document.querySelector('#useBannerExample,.ticker-track,#bannerPrimaryInput,#bannerTickerInput')"));
  await run("localStorage.setItem('valuation-banner-copy',JSON.stringify({primary:'我的原标题 X月份',ticker:'原来的第二段'}))");
  await reload();await tick();
  assert.equal(await query(board+' h2','textContent'),'我的原标题 X月份');
  assert.equal(await query(board+' p','textContent'),'原来的第二段');
  await run(`localStorage.removeItem('valuation-banner-delta-v2');localStorage.setItem('valuation-banner-rich-text-v1','<h2>直播估价</h2><p>评论发：<strong>车型</strong></p><p>上牌时间 · 公里数</p>')`);
  await reload();await tick();await open();
  assert.equal(await query(board+' strong','textContent'),'车型');

  // Select only two characters by dragging, then go through popup menus with the mouse.
  await drag('估价');
  await choose('size','32px');await choose('font','serif');
  await choose('color','#0066cc');await choose('background','#ffffcc');await choose('align','center');
  for(const base of [root,board]){
    const match=await run(`(()=>{const h=document.querySelector('${base} h2'),it=document.createTreeWalker(h,NodeFilter.SHOW_TEXT);
      const parts=[];let n;while(n=it.nextNode()){const s=getComputedStyle(n.parentElement);parts.push([n.data,s.fontSize,s.color,s.fontFamily]);}
      return {parts,align:getComputedStyle(h).textAlign,high:[...h.querySelectorAll('*')].some(e=>e.textContent==='估价'&&getComputedStyle(e).backgroundColor==='rgb(255, 255, 204)')}})()`);
    assert.equal(match.align,'center');assert.ok(match.high,JSON.stringify(match));assert.deepEqual(match.parts.map(x=>x[0]),['直播','估价']);
    assert.ok(match.parts[1][1]==='32px'&&match.parts[1][2]==='rgb(0, 102, 204)'&&match.parts[1][3].includes('serif'),JSON.stringify(match));
  }
  await click(tb+'.ql-picker.ql-size .ql-picker-label');
  await click(tb+'.banner-custom-size input');await type('37');await click(tb+'.banner-custom-size button');
  for(const base of [root,board]) assert.ok(await run(`[...document.querySelectorAll('${base} h2 *')].some(n=>n.textContent==='估价'&&getComputedStyle(n).fontSize==='37px')`),'custom size applies only to selected text');
  const serialized=await query(board,'innerHTML');
  await reload();await tick();
  assert.equal(await query(board,'innerHTML'),serialized,'reload keeps the exact displayed formatting');
  assert.ok(await run("localStorage.getItem('valuation-banner-rich-text-v1').includes('直播估价')&&localStorage.getItem('valuation-banner-copy').includes('原来的第二段')"));
  await open();await click(root+' p:last-child');
  const key=async(key,code,vk,modifiers=0)=>{for(const t of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type:t,key,code,windowsVirtualKeyCode:vk,modifiers});};
  await key('End','End',35);await key('Enter','Enter',13);
  await click(tb+'.ql-bold');await click(tb+'.ql-italic');
  await send('Input.imeSetComposition',{text:'粗斜体',selectionStart:3,selectionEnd:3});await type('粗斜体');await tick();
  assert.equal(await query(board+' strong em, '+board+' em strong','textContent'),'粗斜体','combined pending marks survive IME typing');
  await click(tb+'[data-history=undo]');assert.ok(!await query(board,'textContent.includes("粗斜体")'));
  await click(tb+'[data-history=redo]');assert.ok(await query(board,'textContent.includes("粗斜体")'));
  await click(tb+'.ql-list[value=bullet]');assert.ok(await query(board+' li[data-list=bullet]','textContent.includes("粗斜体")'));
  await click(tb+'.ql-list[value=ordered]');assert.ok(await query(board+' li[data-list=ordered]','textContent.includes("粗斜体")'));

  // Synthetic paste supplies an isolated clipboard payload; the system clipboard is untouched.
  await run(`(()=>{const data=new DataTransfer();data.setData('text/html','<p style="text-align:right"><strong style="font-size:24px;color:#205d9c;background-color:#ffffcc">保留格式</strong></p><iframe></iframe><span onclick="bad()" style="position:fixed">结束</span>');document.querySelector('${root}').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,cancelable:true,bubbles:true}));return true})()`);
  await tick();
  for(const base of [root,board]){
    assert.ok(await query(base,'innerText.includes("结束")'));
    assert.ok(await run(`[...document.querySelectorAll('${base} strong, ${base} strong *')].some(n=>n.textContent.includes('保留格式')&&getComputedStyle(n).fontSize==='24px'&&getComputedStyle(n).color==='rgb(32, 93, 156)')`));
    assert.ok(!await query(base,'querySelector("iframe,[onclick],[style*=fixed]")'));
  }
  if(process.env.QUOTE_BANNER_PREVIEW){
    // Capture user-facing UI in the isolated profile, never touch the real broadcast copy.
    await run(`(()=>{const q=Quill.find(bannerRichInput);q.setContents([{insert:'直播估价',attributes:{size:'32px',bold:true}},{insert:'｜收车参考价',attributes:{size:'20px',color:'#205d9c'}},{insert:'\\n'},{insert:'评论发：',attributes:{bold:true}},{insert:'车型、年份、里程和城市'},{insert:'\\n'}]);q.blur();window.scrollTo(0,0);return true})()`);
    await tick();fs.writeFileSync(process.env.QUOTE_BANNER_PREVIEW,(await wc.capturePage()).toPNG());
  }
  assert.equal(await style('#valuationBanner','borderLeftWidth'),await style('#valuationBanner','borderRightWidth'),'no accent stripe');
  const material=await style('#valuationBanner','backgroundImage');
  assert.ok(material.includes('linear-gradient'));
  for(const selector of ['.host-caption','.queue-box','.settings-group'])assert.equal(await style(selector,'backgroundImage'),material);

  assert.ok(await run("document.querySelector('.board-masthead').firstElementChild.matches('.board-host')&&document.querySelectorAll('.board-masthead .valuation-banner').length===1"));
  console.log('PASS: real mouse drag + size/font/colors/align, caret bold+italic then IME, lists, undo/redo, paste, both legacy migrations, exact formatted reload, single card/host preserved.');
}
module.exports=check;
if(path.resolve(process.argv[1] || '.')===__filename){
  const {app,BrowserWindow,session}=require('electron');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'quote-rich-ui-'));app.setPath('userData',path.join(tmp,'profile'));
  app.whenReady().then(async()=>{
    const dir=path.resolve(__dirname,'../app');
    const file=path.join(tmp,'screen.html');
    const html=fs.readFileSync(path.join(dir,'index.html'),'utf8').replace('<head>','<head><base href="'+require('node:url').pathToFileURL(dir+'/').href+'">')
      .replace(/<script src="\.\/(?!board-view|board-height|board-banner|host-guide)[^"]+"><\/script>/g,'')
      .replace('<script src="./board-view.js">','<script>window.desktop={onQuoteBoard(){},getQuoteBoard(){return Promise.resolve({rev:0,pending:[],history:[]})}}</script><script src="./board-view.js">');
    fs.writeFileSync(file,html);
    const w=new BrowserWindow({show:false,width:1040,height:830,useContentSize:true,webPreferences:{backgroundThrottling:false}});
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));
    const load=()=>w.loadFile(file);console.log('Loading isolated rich-text window');w.webContents.debugger.attach('1.3');
    await load();await check(w,load);w.destroy();app.quit();
  }).catch(e=>{console.error(e);app.exit(1)});
}
