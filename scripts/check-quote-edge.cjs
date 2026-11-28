// Invoked by check-board-fit.cjs in its isolated, network-blocked Electron window.
const assert=require('node:assert/strict');
const fs=require('node:fs');
module.exports=async function checkQuoteEdge(w){
  const run=s=>w.webContents.executeJavaScript(s);
  const wait=async predicate=>{
    for(let i=0;i<120;i++){
      if(await run(predicate))return;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Timed out: '+predicate+'; state: '+await run('quoteEdge.outerHTML.slice(0,900)'));
  };
  await run(`window.fixtureRev=20;
    window.paint=(r,g,b)=>{
      const c=document.createElement('canvas');c.width=100;c.height=80;
      const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,100,80);
      ctx.fillStyle='rgb('+[r,g,b]+')';ctx.fillRect(17,29,66,26);return c.toDataURL();
    };
    window.showJob=(photo,id='q',overrides={})=>{
      const job={id,photo,name:'阿杰',car:'本田 缤智',input:{registration:'2016-05',mileage:15},low:4.20,high:4.80,...overrides};
      draw({rev:++fixtureRev,pending:[],history:[job,{...job,id:'old'}]});
    };
    window.red=paint(162,37,56);window.blue=paint(22,70,170);
    showJob(red);
  `);
  const active="quoteEdge.hasAttribute('data-active')";
  await wait(active);
  const redColor=await run("quoteEdge.style.getPropertyValue('--edge-body')");
  await wait("!!quoteEdge.paperShaderMount");
  assert.ok(await run(`(async()=>{
    const url=new URL('../node_modules/@paper-design/shaders/dist/shaders/pulsing-border.js',document.baseURI);
    const {pulsingBorderFragmentShader}=await import(url.href);
    const m=quoteEdge.paperShaderMount;
    return m.fragmentShader===pulsingBorderFragmentShader &&
      quoteEdge.childElementCount===1 && quoteEdge.firstElementChild===m.canvasElement &&
      quoteEdge.getAnimations({subtree:true}).length===0;
  })()`),'only the official Paper shader draws the moving edge');
  assert.deepEqual(await run(`(()=>{
    const m=quoteEdge.paperShaderMount,u=m.providedUniforms;
    return [m.speed,u.u_scale,u.u_roundness,u.u_thickness,u.u_softness,u.u_intensity,
      u.u_bloom,u.u_spots,u.u_spotSize,u.u_pulse,u.u_smoke,u.u_smokeSize,u.u_aspectRatio,
      u.u_rotation,u.u_offsetX,u.u_offsetY,u.u_marginLeft,u.u_marginRight,u.u_marginTop,
      u.u_marginBottom,u.u_colorsCount,u.u_colors.map(c=>c[3]),u.u_colorBack];
  })()`),[1,.6,.25,.1,.75,.2,.25,4,.5,.25,.3,.6,0,0,0,0,0,0,0,0,5,[1,1,.8,.30,.22],[0,0,0,0]],'original motion and paint alpha plus two low-alpha accents');
  assert.ok(await run(`(()=>{
    const s=quoteEdge.getBoundingClientRect(),c=boardCurrent.getBoundingClientRect();
    return Math.abs(s.left+.2*s.width-c.left)<2 && Math.abs(s.top+.2*s.height-c.top)<2 &&
      Math.abs(s.width*.6-c.width)<2 && Math.abs(s.height*.6-c.height)<2;
  })()`),'shared contour lands on the outer card, not over the vehicle or price');
  const savedColumns=await run('boardShell.style.gridTemplateColumns');
  for(const width of [280,440,875]){
    await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)';new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))");
    const layout=await run(`(()=>{
      const rect=e=>e.getBoundingClientRect(),outer=rect(boardCurrent.parentElement),c=rect(boardCurrent),anchor=rect(quoteEdge.parentElement);
      const pane=rect(boardViewport),queue=rect(document.querySelector('.queue-box')),history=rect(boardHistory.parentElement);
      return {room:[c.left-outer.left,c.top-outer.top,outer.right-c.right,outer.bottom-c.bottom],
        anchored:['left','right','top','bottom'].every(k=>Math.abs(anchor[k]-c[k])<1),
        clip:getComputedStyle(quoteEdge.parentElement).overflow,bleed:getComputedStyle(quoteEdge.parentElement).overflowClipMargin,
        bounded:outer.left>=pane.left-1&&outer.right<=pane.right+1&&outer.top>=queue.bottom&&outer.bottom<=history.top};
    })()`);
    const [left,top,right,bottom]=layout.room;
    assert.ok(left>5&&Math.abs(left-right)<1&&Math.abs(top)<1&&Math.abs(bottom)<1&&layout.clip==='clip'&&/([1-9]\d*|0?\.\d*[1-9])px/.test(layout.bleed)&&layout.anchored&&layout.bounded,
      'halo follows the card without empty strips above/below at width '+width+': '+JSON.stringify(layout));
  }
  await run('boardShell.style.gridTemplateColumns='+JSON.stringify(savedColumns));
  assert.deepEqual(await run(`(()=>{
    const card=boardCurrent.firstElementChild,photo=card.querySelector('.board-vehicle-photo');
    return [getComputedStyle(card).backgroundImage.includes('linear-gradient'),getComputedStyle(card).backdropFilter.includes('blur'),
      photo.querySelector('img').src===red,photo.querySelector('canvas')===null];
  })()`),[true,true,true,true],'frosted hero with its original image source preserved');
  assert.ok(await run(`(async()=>{const m=quoteEdge.paperShaderMount,f=m.getCurrentFrame();await new Promise(r=>setTimeout(r,120));return m.getCurrentFrame()>f})()`));
  assert.equal(await run("document.querySelectorAll('#boardHistory canvas').length"),0);
  await run("window.firstCanvas=quoteEdge.firstChild;showJob(blue,'blue')");
  await wait(active+" && quoteEdge.style.getPropertyValue('--edge-body')!=="+JSON.stringify(redColor));
  assert.ok(await run("firstCanvas===quoteEdge.firstChild"));
  const blueColor=await run("quoteEdge.style.getPropertyValue('--edge-body')");
  await run("window.desktop.getFeaturedPhoto=()=>new Promise(r=>window.resolveOld=r);showJob('https://img.che300.com/test.jpg','slow')");
  await wait('typeof resolveOld==="function"');
  assert.ok(await run("quoteEdge.hasAttribute('data-active') && firstCanvas===quoteEdge.firstChild"),'rim survives a pending remote decode without a blank frame');
  assert.match(await run("boardCurrent.textContent"),/4.20～4.80/);
  await run("showJob(blue,'newest');resolveOld(red)");
  await wait(active);
  assert.equal(await run("quoteEdge.style.getPropertyValue('--edge-body')"),blueColor);
  await run("window.desktop.getFeaturedPhoto=async()=>red;showJob('https://img.che300.com/test.jpg','cdn')");
  await wait(active+" && quoteEdge.style.getPropertyValue('--edge-body')==="+JSON.stringify(redColor));
  // No image, placeholder, damaged bytes, or unreadable remote image never hide price.
  for(const [i,src] of ['', 'car-silhouette.svg','data:image/png;base64,AAAA','https://img.che300.com/unavailable.jpg'].entries()){
    await run("window.desktop.getFeaturedPhoto=async()=>null;showJob("+JSON.stringify(src)+","+i+")");
    await new Promise(r=>setTimeout(r,60));
    assert.equal(await run(active),false);
    assert.match(await run("boardCurrent.textContent"),/4.20～4.80/);
  }
  // Reduced motion stops RAF; the live shader's frame counter must remain stable.
  await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await run("showJob(red,'still')");
  await wait(active);
  assert.ok(await run(`(async()=>{const m=quoteEdge.paperShaderMount,f=m.getCurrentFrame();await new Promise(r=>setTimeout(r,150));return f===m.getCurrentFrame()})()`));
  await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  // The featured identity card is the only viewer surface with a split model
  // title and a dedicated full-width amount row. Check painted bounds, not just CSS.
  {
    const name='小林和喜欢自驾的朋友们一起看车聊配置'.repeat(3);
    const long='两厢 280TSI DSG豪华版 国VI';
    const dir=process.env.QUOTE_ID_PREVIEW;
    let photo=await run('red');
    if(dir){
      const {DatabaseSync}=require('node:sqlite'),path=require('node:path');
      const db=new DatabaseSync(path.resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
      try{photo=db.prepare('SELECT image_data FROM vehicle_photos WHERE rowid=4').get().image_data;}finally{db.close();}
      fs.mkdirSync(dir,{recursive:true});
    }
    for(const [width,trim,viewer] of [[420,'230TSI 手动舒适版','小林'],[320,long,name],[280,long+' 特别纪念长轴距四驱版本',name]]){
      const job={seriesName:'朗逸',car:'朗逸 '+trim,name:viewer,low:1.77,high:2.30,input:{registration:'2017-05',mileage:12}};
      await run("boardShell.style.gridTemplateColumns='"+width+"px 12px minmax(0,1fr)';showJob("+JSON.stringify(photo)+",'identity',"+JSON.stringify(job)+")");
      await wait(active);
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))');
      const v=await run(`(()=>{
        const card=boardCurrent.firstElementChild,q=s=>card.querySelector(s),rect=e=>e.getBoundingClientRect();
        const info=rect(q('.card-info')),img=rect(q('.board-vehicle-photo')),footer=rect(q('.card-price')),owner=rect(q('.board-person'));
        const title=q('.car-name'),trim=q('.car-trim'),name=q('.board-name'),amount=q('.quote-amount'),unit=rect(amount.lastChild),value=rect(amount.firstChild);
        const inside=(r,b)=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1;
        const textRects=e=>{const r=document.createRange();r.selectNodeContents(e);return [...r.getClientRects()].filter(b=>b.width&&b.height)};
        return {title:title.textContent,trim:trim.textContent,nickname:name.title,amount:amount.textContent,ellipsis:name.scrollWidth>name.clientWidth+1,
          wraps:trim.offsetHeight>1.6*parseFloat(getComputedStyle(trim).lineHeight),
          allText:textRects(trim).every(r=>inside(r,info))&&textRects(amount).every(r=>inside(r,rect(card))&&r.left>=footer.left-1&&r.right<=footer.right+1&&r.top>=footer.top-1),
          positioned:owner.bottom<=info.top+1&&info.right<=img.left+1&&Math.max(info.bottom,img.bottom)<=footer.top+1&&unit.left>=value.right-1&&unit.top<value.bottom,
          footerWidth:footer.width>=info.width+img.width};
      })()`);
      assert.equal(v.title,job.car);assert.equal(v.trim,trim);assert.equal(v.nickname,viewer);assert.equal(v.amount,'1.77～2.30万');
      assert.ok(v.positioned&&v.allText&&v.footerWidth,JSON.stringify({width,...v}));
      if(width<=320){assert.ok(v.ellipsis&&v.wraps,JSON.stringify({width,...v}));}
      if(dir){
        const r=await run("(()=>{const {left,top,right,bottom}=boardCurrent.parentElement.getBoundingClientRect();return {x:Math.floor(left),y:Math.floor(top),width:Math.ceil(right)-Math.floor(left),height:Math.ceil(bottom)-Math.floor(top)}})()");
        fs.writeFileSync(require('node:path').join(dir,'identity-'+width+'.png'),(await w.webContents.capturePage(r)).toPNG());
      }
    }
    await run('boardShell.style.gridTemplateColumns='+JSON.stringify(savedColumns));
    console.log('PASS: third-card layout, unabridged wrapping trim, nickname ellipsis and complete footer price at 280/320/420.');
  }
  // Optional screenshot, using local demo imagery rather than production IPC.
  if(process.env.QUOTE_EDGE_PREVIEW){
    const {DatabaseSync}=require('node:sqlite'),path=require('node:path');
    const db=new DatabaseSync(path.resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
    const imgs=db.prepare('SELECT image_data FROM vehicle_photos ORDER BY rowid').all();db.close();
    const history=[[10,'阿杰','丰田 威驰',4.2,4.8],[1,'小林','奥迪 A3',7.5,8.1],
      [4,'老周','大众 朗逸',5.1,5.6],[5,'阿文','奥迪 A4L',8.3,9.2],[6,'小许','奔驰 A 级',6.6,7.3]].map(([row,name,car,low,high],id)=>({
        id,photo:imgs[row-1]?.image_data,name,car,low,high,input:{registration:'2016-05',mileage:15-id}
      }));
    await run("boardShell.style.gridTemplateColumns='420px 12px minmax(0,1fr)';valuationBanner.textContent='二手车直播估价　发车型、年份、公里数';draw({rev:++fixtureRev,pending:[{name:'小李'},{name:'大吴'}],history:"+JSON.stringify(history)+"})");
    await wait(active);
    await new Promise(r=>setTimeout(r,350));
    const r=await run("(()=>{const {x,y,width,height}=boardViewport.getBoundingClientRect();return {x:Math.ceil(x),y:Math.ceil(y),width:Math.floor(width),height:Math.ceil(height)}})()");
    fs.writeFileSync(process.env.QUOTE_EDGE_PREVIEW,(await w.webContents.capturePage(r)).toPNG());
    if(process.env.QUOTE_EDGE_FRAMES){
      // Capture the reserved halo too, rather than re-cropping it in the video.
      const rect=await run("(()=>{const {left,top,right,bottom}=boardCurrent.parentElement.getBoundingClientRect();return {x:Math.floor(left),y:Math.floor(top),width:Math.ceil(right)-Math.floor(left),height:Math.ceil(bottom)-Math.floor(top)}})()");
      const path=require('node:path'),dir=process.env.QUOTE_EDGE_FRAMES;
      fs.mkdirSync(dir,{recursive:true});
      const refDir=process.env.QUOTE_EDGE_REFERENCE_FRAMES;
      let refRect;
      if(refDir){
        fs.mkdirSync(refDir,{recursive:true});
        refRect=await run(`(async()=>{
          const m=quoteEdge.paperShaderMount;
          const {presetUniforms}=await import(new URL('quote-edge-preset.mjs',document.baseURI).href);
          const host=document.createElement('div');host.style.cssText='position:fixed;right:0;top:0;width:480px;height:270px;z-index:9999';
          document.body.append(host);
          const u=presetUniforms();window.refMount=new m.constructor(host,m.fragmentShader,
            {...u,u_noiseTexture:m.providedUniforms.u_noiseTexture},{alpha:true},0,0,1,640000);
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const {x,y,width,height}=host.getBoundingClientRect();return {x,y,width,height};
        })()`);
        assert.deepEqual(await run('refMount.providedUniforms.u_colors.map(c=>c.map(v=>Math.round(v*255))).concat([refMount.providedUniforms.u_colorBack])'),
          [[13,193,253,255],[217,21,239,255],[255,63,46,204],[0,0,0,1]]);
      }
      // Export at even 60 Hz intervals without making capture/PNG I/O set the
      // pacing of the animation. The earlier 100 ms polling made previews jerk.
      const speed=await run('quoteEdge.paperShaderMount.speed');
      await run('quoteEdge.paperShaderMount.setSpeed(0)');
      try{
        for(let i=0;i<240;i++){
          await run('quoteEdge.paperShaderMount.setFrame('+i*1000/60*speed+');window.refMount?.setFrame('+i*1000/60*speed+');new Promise(r=>requestAnimationFrame(()=>r(true)))');
          const frame=await w.webContents.capturePage(rect);
          fs.writeFileSync(path.join(dir,String(i).padStart(3,'0')+'.png'),frame.resize({width:640}).toPNG());
          if(refDir)fs.writeFileSync(path.join(refDir,String(i).padStart(3,'0')+'.png'),
            (await w.webContents.capturePage(refRect)).resize({width:640}).toPNG());
        }
      }finally{await run('window.refMount?.dispose();quoteEdge.paperShaderMount.setSpeed('+speed+')');}
    }
  }
  await run("quoteEdge.paperShaderMount.canvasElement.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()");
  await wait("!quoteEdge.paperShaderMount");
  assert.ok(await run(active));
  console.log('PASS: Paper WebGL shader mounted/reused, red/blue and remote palettes, stale async result, neutral/error states, reduced motion, GPU fallback.');
};
