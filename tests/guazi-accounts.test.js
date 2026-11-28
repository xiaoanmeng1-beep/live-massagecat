'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DataStore}=require('../data-store');const {GuaziAccounts}=require('../guazi-electron');
const {EventEmitter}=require('node:events');
function fixture(){const store=new DataStore(':memory:');const manager=new GuaziAccounts({store});return {store,manager};}
test('独立瓜子分区与账号持久化，不迁用车300身份；单账号20次后继续用，不凭空冷却',async()=>{
  const {store,manager:m}=fixture();try{
    const id=m.add(),a=m.get(id);assert.match(m.partition(a),/^persist:guazi-account-/);
    a.status='authenticated';m.raw=async()=>({ok:true,data:{}});
    for(let i=0;i<21;i++)assert.equal((await m.call('quote',{})).ok,true);
    assert.equal(a.status,'authenticated');assert.equal(a.requests,21);assert.equal(a.cooldownUntil,undefined);
    const n=new GuaziAccounts({store});assert.equal(n.snapshot()[0].id,id);assert.equal(n.snapshot()[0].status,'unchecked');assert.equal(n.snapshot()[0].requests,21);
    assert.equal(store.getSetting('service_accounts',null),null);
  }finally{store.db.close();}
});
test('多账号健康轮换；失效可使用有效登录；限频返回原错误而非无休止换号',async()=>{
  const {store,manager:m}=fixture();try{
    const a=m.get(m.add()),b=m.get(m.add());a.status=b.status='authenticated';
    const calls=[];m.raw=async(account,method)=>{calls.push(account.id);return {ok:true,data:{}};};
    a.requests=19;await m.call('quote',{});assert.equal(b.active,true);
    m.select(a.id);m.raw=async account=>account===a?{ok:false,code:'10001',message:'未登录'}:{ok:true};
    assert.equal((await m.call('quote',{})).ok,true);assert.equal(b.active,true);
    a.status=b.status='authenticated';m.select(a.id);let count=0;
    m.raw=async()=>{count++;return {ok:false,code:'429',message:'请求频繁'};};
    assert.equal((await m.call('quote',{})).code,'429');assert.equal(count,1);assert.equal(a.active,true);
  }finally{store.db.close();}
});
test('目录未找到或无价格时不切换账号；没有账号时明确提示登录',async()=>{
  const {store,manager:m}=fixture();try{
    assert.equal((await m.call('quote',{})).code,'NO_ACCOUNT');
    const a=m.get(m.add());m.get(m.add()).status='authenticated';a.status='authenticated';let n=0;
    m.raw=async()=>{n++;return {ok:false,code:'NO_MODEL',message:'未找到'};};
    assert.equal((await m.call('quote',{})).code,'NO_MODEL');assert.equal(n,1);assert.equal(a.active,true);
  }finally{store.db.close();}
});

test('瓜子登录仅创建内嵌表单，保留分区；原始控件打开后验证登录，成功自动收起',async()=>{
  const store=new DataStore(':memory:'),panels=[],parent={isDestroyed:()=>false},calls=[];
  class Panel extends EventEmitter {
    constructor(p,partition,log,options){super();Object.assign(this,{p,partition,options,closed:false});
      this.webContents=new EventEmitter();this.webContents.executeJavaScript=async source=>{calls.push(source);return true;};panels.push(this);}
    loadURL(url){this.url=url;return Promise.resolve();}isDestroyed(){return this.closed;}
    close(){this.closed=true;this.emit('closed');}setPhase(){}
  }
  const m=new GuaziAccounts({store,EmbeddedLogin:Panel,parent:()=>parent,session:{fromPartition:()=>({cookies:{flushStore:async()=>calls.push('flush')}})}});
  try{
    const id=m.add();m.raw=async()=>({ok:false,code:'500010'});
    await m.login(id);assert.equal(panels.length,1);assert.equal(panels[0].p,parent);
    assert.equal(panels[0].options.channel,'guazi-login');assert.match(panels[0].options.preload,/guazi-auth-preload/);
    assert.equal(panels[0].partition,m.partition(m.get(id)));assert.equal(m.windows.size,0);
    assert.match(calls[0],/\.user-login/);assert.match(calls[0],/el\?\.click/);assert.equal(panels[0].closed,false);
    m.raw=async()=>({ok:true,data:{authenticated:true}});await m.refresh(id);
    assert.equal(m.get(id).status,'authenticated');assert.equal(panels[0].closed,true);assert.equal(m.loginPanel,null);assert.ok(calls.includes('flush'));
  }finally{m.close();store.db.close();}
});

test('嵌入登录IPC隔离：页面脚本只更新自己的状态，任意远程页不得移动或关闭面板',()=>{
  const {registerGuaziLoginIpc}=require('../guazi-electron');
  const listeners=new Map(),main={},frame={},remote={mainFrame:frame},trace=[];
  const manager={loginPanel:{webContents:remote,setBounds:b=>trace.push(['bounds',b]),updateFormState:s=>trace.push(['state',s])},closeLogin:()=>trace.push(['close'])};
  registerGuaziLoginIpc({on:(k,f)=>listeners.set(k,f)},()=>({webContents:main}),manager);
  listeners.get('guazi-login:bounds')({sender:remote},{width:3});assert.equal(trace.length,0);
  listeners.get('guazi-login:document-state')({sender:remote,senderFrame:{}},{ready:true});assert.equal(trace.length,0);
  listeners.get('guazi-login:document-state')({sender:remote,senderFrame:frame},{ready:true});assert.equal(trace.length,1);
  listeners.get('guazi-login:bounds')({sender:main},{width:300});assert.equal(trace.length,2);
  listeners.get('guazi-login:close')({sender:remote});assert.equal(trace.length,2);
  listeners.get('guazi-login:close')({sender:main});assert.equal(trace.length,3);
});

test('官网反爬滑块页按需验证处理，不当作退出登录，也不尝试报价',async()=>{
  const {isVerificationPage}=require('../guazi-electron');
  assert.equal(isVerificationPage('https://uc.guazi.com/guazi-mall-ucenter/captcha?source_uri=x'),true);
  assert.equal(isVerificationPage('https://uc.guazi.com.evil/guazi-mall-ucenter/captcha'),false);
  const {store,manager:m}=fixture();try{
    m.session={fromPartition:()=>({cookies:{flushStore:async()=>{}}})};const id=m.add();
    m.raw=async()=>({ok:false,code:'CAPTCHA_REQUIRED',message:'需要滑块'});
    await m.refresh(id);assert.equal(m.get(id).status,'verification-required');
    assert.equal((await m.call('quote',{})).code,'CAPTCHA_REQUIRED');assert.equal(m.get(id).requests,0);
  }finally{store.db.close();}
});
