'use strict';
(()=>{
  const api=window.desktop,byId=id=>document.getElementById(id);
  const list=byId('guaziAccountList'),message=byId('guaziAccountMessage'),add=byId('addGuaziAccount');
  const states={unchecked:'登录状态待确认','signed-out':'请登录',authenticated:'已登录','verification-required':'需要完成滑块验证',opening:'正在打开登录表单',error:'登录页打开失败'};
  const panel=byId('guaziLoginPanel'),host=byId('guaziLoginHost'),notice=byId('guaziLoginNotice');
  let frame=0;
  function bounds(){
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      const hidden=panel.hidden || host.hidden || !byId('accountSettings').open || document.body.classList.contains('resizing-panels');
      const r=hidden?{x:0,y:0,width:0,height:0}:host.getBoundingClientRect();
      api.setGuaziLoginBounds({x:r.x,y:r.y,width:r.width,height:r.height});
    });
  }
  api.onGuaziLoginState(({phase})=>{
    panel.hidden=phase==='closed';host.hidden=phase!=='ready';
    byId('guaziLoginSpinner').hidden=phase!=='loading';byId('retryGuaziLogin').hidden=phase!=='failed';
    if(phase==='loading'){
      byId('accountSettings').open=true;notice.textContent='正在加载瓜子登录表单…';
      panel.scrollIntoView({block:'center'});
    }else if(phase==='failed')notice.textContent='瓜子登录页面加载失败，请重新加载';
    else if(phase==='closed')notice.textContent='';
    bounds();
  });
  api.onGuaziLoginFormState(data=>{
    if(panel.hidden)return;
    host.hidden=!(data.ready||data.challenge);host.classList.toggle('has-challenge',data.challenge);
    byId('guaziLoginSpinner').hidden=!!(data.ready||data.challenge);
    notice.textContent=data.challenge?'请在下方完成滑块验证':data.errorMessage||'';
    bounds();
  });
  byId('closeGuaziLogin').onclick=()=>api.closeGuaziLogin();
  byId('retryGuaziLogin').onclick=()=>api.retryGuaziLogin();
  new ResizeObserver(bounds).observe(host);
  new ResizeObserver(bounds).observe(document.querySelector('.account-column'));
  new MutationObserver(bounds).observe(document.body,{attributes:true,attributeFilter:['class']});
  document.querySelectorAll('.settings-group').forEach(g=>g.addEventListener('toggle',bounds));
  window.addEventListener('scroll',bounds,true);window.addEventListener('resize',bounds);
  let busy=false,accounts=[],poolKey='',poolRevision=-1;
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  function draw(rows){
    accounts=rows;list.replaceChildren();
    for(const a of rows){
      const current=poolKey==='guazi:'+a.id;
      const card=el('section',null,'account-item'+(current?' current':''));
      card.append(el('strong',a.label+(current?' · 当前使用':'')),el('span',states[a.status]||'待确认','account-item-status'+(a.status==='authenticated'?' verified':'')));
      if(a.errorMessage)card.append(el('small',a.errorMessage,'account-policy'));
      const actions=el('div',null,'guazi-account-actions');
      for(const [text,method,disabled] of [[a.status==='verification-required'?'验证':'登录','loginGuaziAccount',false],[current?'使用中':'切换使用','selectGuaziAccount',current||a.status!=='authenticated'],['刷新','refreshGuaziAccount',false],['删除','deleteGuaziAccount',false]]) {
        const b=el('button',text,'login-button');b.type='button';b.disabled=busy||disabled;
        b.onclick=()=>operate(()=>api[method](a.id));actions.append(b);
      }
      card.append(actions);list.append(card);
    }
    if(!rows.length)list.append(el('p','尚未添加瓜子账号','douyin-bridge-hint'));
  }
  async function operate(task){
    if(busy)return;busy=true;add.disabled=true;draw(accounts);message.textContent='处理中…';
    try{draw(await task());message.textContent='';}
    catch{message.textContent='账号操作失败，请稍后重试';}
    finally{busy=false;add.disabled=false;draw(accounts);}
  }
  add.onclick=()=>operate(()=>api.addGuaziAccount());
  api.onGuaziAccounts(draw);
  api.getGuaziAccounts().then(draw).catch(()=>{message.textContent='瓜子账号列表读取失败';});
  function pool(state){
    const revision=Number(state?.revision)||0;if(revision<poolRevision)return;
    poolRevision=revision;poolKey=state.current||'';draw(accounts);
    const a=state.accounts.find(a=>a.current);
    byId('quotePoolStatus').textContent=a?'当前报价：'+(a.provider==='guazi'?'瓜子':'车300')+' · '+a.label+'，本轮 '+Math.min(state.used,20)+'/20 次':'已登录账号每20次实际请求自动轮换';}
  api.onQuotePool(pool);api.getQuotePool().then(pool).catch(()=>{byId('quotePoolStatus').textContent='账号轮换状态读取失败';});
})();
