// Isolated Electron fixture, using the actual markup, banner settings and renderer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function(w,reload){
  const run=s=>w.webContents.executeJavaScript(s),tick=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  await require('./check-banner-editor.cjs')(w,reload);
  await require('./check-host-guide.cjs')(w,reload);
  await run("boardShell.style.gridTemplateColumns='420px 12px minmax(0,1fr)';Quill.find(bannerRichInput).setText('直播估价｜收车参考价');true");await tick();
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  const photos=db.prepare('select rowid,image_data from vehicle_photos').all();db.close();
  const jobs=[[10,'阿杰','威驰','1.5L 自动挡',4.20,4.80],[4,'小林','朗逸','230TSI 手动舒适版',1.77,2.30],[1,'岩语','奥迪A3','Sportback',7.50,8.10],[5,'小周','奥迪A4L','舒适型',8.30,9.20],[6,'晨光','奔驰A级','A 200 L',5.27,6.02]].map(([id,name,seriesName,trim,low,high])=>({id,name,seriesName,car:seriesName+' '+trim,photo:photos.find(p=>p.rowid===id).image_data,input:{registration:'2017-05',mileage:12},low,high}));
  await run('window.jobs='+JSON.stringify(jobs)+";window.nr=100;window.drawJobs=(ids,n=0)=>draw({rev:++nr,pending:Array.from({length:n},(_,i)=>({userId:'q'+i,name:['小林','阿周','陈哥'][i%3]+(i>2?'超长昵称用来测窄屏显示': '')})),history:ids.map(i=>jobs[i])});drawJobs([0,2,3,4])");
  await run("Promise.all([...boardCurrent.querySelectorAll('img')].map(x=>x.decode())).then(()=>true)");
  for(let i=0;i<80&&!await run("!!quoteEdge.paperShaderMount");i++)await new Promise(r=>setTimeout(r,40));
  assert.ok(await run("!!quoteEdge.paperShaderMount"));
  await run("Promise.allSettled(boardCurrent.parentElement.getAnimations().map(a=>a.finished)).then(()=>true)");
  const metrics=()=>run(`(()=>{
    const box=document.querySelector('.queue-box'),r=el=>el.getBoundingClientRect();
    return [r(box).height,r(boardCurrent).top,r(boardHistory).top,r(boardContent).height,
      parseFloat(getComputedStyle(boardContent).zoom)];
  })()`);
  for(const width of [280,420,580]){
    await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)';drawJobs([0,2,3,4])");await tick();
    const baseline=await metrics();
    for(const count of [1,3,12,0]){
      await run("drawJobs([0,2,3,4],"+count+")");await tick();
      const current=await metrics();
      assert.deepEqual(current,baseline,JSON.stringify({width,count,baseline,current}));
    }
  }
  await run("boardShell.style.gridTemplateColumns='420px 12px minmax(0,1fr)';drawJobs([0,2,3,4])");await tick();
  const dir=process.env.QUOTE_HANDOFF_FRAMES;
  const rect=await run("(()=>{const {x,y,width,height}=boardViewport.getBoundingClientRect();return {x:Math.floor(x),y:Math.floor(y),width:Math.ceil(width),height:Math.ceil(height)}})()");
  if(dir)fs.mkdirSync(dir,{recursive:true});
  const capture=async i=>{
    await run("quoteEdge.paperShaderMount.setSpeed(0);quoteEdge.paperShaderMount.setFrame("+i*1000/60+");new Promise(r=>requestAnimationFrame(()=>r(true)))");
    fs.writeFileSync(path.join(dir,String(i).padStart(3,'0')+'.png'),(await w.webContents.capturePage(rect)).resize({width:600}).toPNG());
  };
  await run("window.oldHero=boardCurrent.firstChild;window.oldPhoto=oldHero.querySelector('.board-vehicle-photo img');window.oldRow=boardHistory.firstChild;window.originalRim=quoteEdge.firstChild;true;");
  if(dir)for(let i=0;i<30;i++)await capture(i);
  assert.ok(await run("drawJobs([1,0,2,3,4]);window.acts=[...liveBoard.getAnimations({subtree:true})].filter(a=>a.constructor.name==='Animation');acts.forEach(a=>a.pause());document.querySelector('.quote-flight-layer')?.contains(oldHero)&&boardHistory.children[1]===oldRow&&boardHistory.firstChild.querySelector('.board-vehicle-photo img')===oldPhoto&&boardHistory.firstChild.textContent.includes('威驰')&&originalRim===quoteEdge.firstChild&&acts.length>=4"));
  await tick();
  assert.ok(await run(`(()=>{
    const panel=boardCurrent.parentElement;
    const reveal=acts.find(a=>a.effect.target===boardCurrent.firstChild.querySelector('.card-price'));
    const flight=document.querySelector('.quote-flight-layer');
    const title=boardHistory.firstChild.querySelector('.car-name'),oldTitle=flight.querySelector('.car-name');
    const opacity=el=>Number(getComputedStyle(el).opacity);
    if(acts.some(a=>a.effect.getKeyframes().some(k=>Object.keys(k).some(p=>!['offset','easing','composite','computedOffset','transform','transformOrigin','opacity'].includes(p)))))return false;
    if(quoteEdge.paperShaderMount.speed!==1)return false;
    if(!reveal||reveal.effect.getTiming().duration!==1650||!panel.contains(quoteEdge)||!panel.contains(boardCurrent))return false;
    if(acts.some(a=>a.effect.target===panel || a.effect.target===boardCurrent.firstChild || a.effect.target===quoteEdge))return false;
    let last=0;
    for(const f of [0,.05,.25,.40,.50,.60,.76,.99]){
      acts.forEach(a=>a.currentTime=f*1650);
      const now=opacity(reveal.effect.target);
      if(opacity(panel)!==1||Math.abs(opacity(quoteEdge)-.86)>.01||getComputedStyle(quoteEdge).visibility!=='visible')return false;
      if(now<last || (f<=.05&&!(now>.26&&now<.30)) || (f===.40&&!(now>0&&now<1)) || (f>=.76&&now!==1))return false;
      if(opacity(title)+opacity(oldTitle)<.99)return false;
      last=now;
    }
    acts.forEach(a=>a.currentTime=0);
    jobs[1]={...jobs[1],name:'小林（已补充）'};
    drawJobs([1,0,2,3,4]);
    return document.querySelector('.quote-flight-layer')===flight && reveal.playState==='paused'
      && boardCurrent.querySelector('.board-name').textContent===jobs[1].name;
  })()`),'the edge stays fully visible while new text fades, old title never disappears, and late name does not cancel handoff');
  async function checkTravel(){
    const pos=await run(`[0,.22,.50,.78,.9999].map(f=>{
      acts.forEach(a=>a.currentTime=f*a.effect.getTiming().duration);
      const rect=el=>el.getBoundingClientRect(),box=r=>[r.left,r.top,r.width,r.height];
      const layer=document.querySelector('.quote-flight-layer'),row=boardHistory.firstChild;
      const surface=rect(layer.querySelector('.quote-flight-surface:not(.quote-flight-landing)')),hero=rect(layer.querySelector('.featured-quote'));
      const dest=rect(row),photo=rect(row.querySelector('.board-vehicle-photo')),price=rect(row.querySelector('.card-price'));
      return {surface:box(surface),hero:box(hero),dest:box(dest),photoX:photo.left+photo.width/2,
        amountY:price.top+price.height/2,sibling:rect(row.nextElementSibling).top};
    })`);
    const first=pos[0],last=pos.at(-1),near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1.3);
    assert.ok(near(first.surface,first.hero)&&near(last.surface,last.dest),'surface starts at hero and lands on row: '+JSON.stringify(pos));
    assert.ok(pos.every((p,i)=>!i||(p.surface[1]>=pos[i-1].surface[1]&&p.surface[3]<=pos[i-1].surface[3]+.2)),JSON.stringify(pos));
    assert.ok(last.surface[1]-first.surface[1]>8&&first.surface[3]-last.surface[3]>8);
    assert.ok(first.photoX-pos[2].photoX>4&&pos[2].photoX-last.photoX>1,'car moves across the card');
    assert.ok(last.amountY-first.amountY>6&&last.sibling-first.sibling>6,'amount descends and existing quotes make room: '+JSON.stringify(pos));
    await run('acts.forEach(a=>a.currentTime=0);true');
  }
  await checkTravel();
  const space=await run("(()=>{const r=boardHistory.firstChild.getBoundingClientRect(),p=boardViewport.getBoundingClientRect();return [r.left-p.left,p.right-r.right]})()");
  assert.ok(space.every(n=>n>=6),JSON.stringify(space));
  const end=30+Math.ceil(await run("Math.max(...acts.map(a=>a.effect.getTiming().duration))")*60/1000);
  if(dir){for(let i=30;i<end+30;i++){
    if(i<end)await run('acts.forEach(a=>a.currentTime='+((i-30)*1000/60)+')');
    else if(i===end)await run('acts.forEach(a=>a.finish());true');
    await capture(i);
  }}else await run('acts.forEach(a=>a.finish());true');
  await tick();assert.ok(await run("!document.querySelector('.quote-flight-layer')&&boardCurrent.textContent.includes('朗逸')&&boardHistory.children.length===4"));
  assert.ok(await run("window.photoNow=boardCurrent.querySelector('.board-vehicle-photo img');jobs[1]={...jobs[1],name:'新昵称'};drawJobs([1,0,2,3,4]);boardCurrent.textContent.includes('新昵称')&&photoNow===boardCurrent.querySelector('.board-vehicle-photo img')&&!document.querySelector('.quote-flight-layer')"));
  await run("drawJobs([3,1,0,2,4]);drawJobs([2,3,1,0,4]);Promise.allSettled(liveBoard.getAnimations({subtree:true}).filter(a=>a.constructor.name==='Animation').map(a=>a.finished)).then(()=>true)");
  assert.ok(await run("document.querySelectorAll('.quote-flight-layer').length===0&&boardCurrent.textContent.includes('奥迪A3')&&boardHistory.firstChild.textContent.includes('奥迪A4L')"));
  for(const [width,order] of [[280,[1,2,3,0,4]],[580,[4,1,2,3,0]]]){
    await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)'");await tick();
    await run('drawJobs('+JSON.stringify(order)+');window.acts=liveBoard.getAnimations({subtree:true}).filter(a=>a.constructor.name==="Animation");acts.forEach(a=>a.pause());true');
    await tick();await checkTravel();await run('acts.forEach(a=>a.finish());true');await tick();
  }
  await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.ok(await run("drawJobs([0,4,1,2,3]);!document.querySelector('.quote-flight-layer')&&boardHistory.firstChild.textContent.includes('奔驰')"));
  console.log('PASS: 1.65s fold, steady live rim during handoff, queue height invariant, continuous title, quote enrichment, rapid/reduced motion, and landing at 280/420/580px.');
};
