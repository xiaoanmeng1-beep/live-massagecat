'use strict';
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {pageCall}=require('./guazi-page-client');
const ACCOUNT_KEY='guazi.accounts.v1';
const AUTH_CODES=new Set(['10001','500010','401','403']);
function isVerificationPage(value){try{const u=new URL(value);return u.hostname==='uc.guazi.com'&&u.pathname==='/guazi-mall-ucenter/captcha';}catch{return false;}}

class GuaziAccounts {
  constructor({store,BrowserWindow,session,dialog,parent,EmbeddedLogin,managed=false,change=()=>{},log=()=>{}}) {
    Object.assign(this,{store,BrowserWindow,session,dialog,parent,EmbeddedLogin,managed,change,log});
    this.loginPanel=null;this.loginAccountId='';
    this.windows=new Map();this.queues=new Map();this.loading=new Map();
    this.accounts=store.getSetting(ACCOUNT_KEY,[]).filter(a=>/^[a-f0-9-]{36}$/.test(a.id))
      .map(a=>({id:a.id,label:a.label,active:!!a.active,status:'unchecked',requests:Number(a.requests)||0}));
  }
  snapshot(){return this.accounts.map(({id,label,active,status,requests,errorMessage})=>({id,label,active,status,requests,errorMessage}));}
  publish(){this.change(this.snapshot());}
  save(){this.store.setSetting(ACCOUNT_KEY,this.accounts.map(({id,label,active,requests})=>({id,label,active,requests})));this.publish();}
  async restore(){
    for(const a of this.accounts){
      try{
        const cookies=await this.session.fromPartition(this.partition(a)).cookies.get({url:'https://www.guazi.com/'});
        if(cookies.some(c=>c.name==='CHDSSO'))await this.refresh(a.id);
        else{a.status='signed-out';this.publish();}
      }catch{a.status='unchecked';this.publish();}
    }
  }
  get(id){const a=this.accounts.find(a=>a.id===id);if(!a)throw Error('瓜子账号不存在');return a;}
  partition(a){return 'persist:guazi-account-'+a.id;}
  add(){const a={id:randomUUID(),label:'瓜子账号 '+(Math.max(0,...this.accounts.map(a=>+a.label.match(/\d+$/)?.[0]||0))+1),
    active:!this.accounts.length,status:'signed-out',requests:0};this.accounts.push(a);this.save();return a.id;}
  select(id){this.get(id);for(const a of this.accounts)a.active=a.id===id;this.save();return this.snapshot();}
  async window(a) {
    if(this.loading.has(a.id))return this.loading.get(a.id);
    let w=this.windows.get(a.id);
    if(w&&!w.isDestroyed())return w;
    w=new this.BrowserWindow({width:1120,height:800,show:false,title:a.label+' · 瓜子后台',
      webPreferences:{partition:this.partition(a),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    this.windows.set(a.id,w);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    w.webContents.on('will-navigate',(e,url)=>{try{if(!/(^|\.)guazi\.com$/.test(new URL(url).hostname))e.preventDefault();}catch{e.preventDefault();}});
    const cookies=this.session.fromPartition(this.partition(a)).cookies;
    let timer;
    const changed=(_e,cookie)=>{if(cookie.name!=='CHDSSO'||!/(^|\.)guazi\.com$/.test(cookie.domain))return;
      clearTimeout(timer);timer=setTimeout(()=>this.refresh(a.id).catch(()=>{}),800);};
    cookies.on('changed',changed);
    w.on('closed',()=>{clearTimeout(timer);cookies.removeListener('changed',changed);this.windows.delete(a.id);});
    let loadTimer;
    const task=Promise.race([w.loadURL('https://www.guazi.com/gujia/'),new Promise((_,reject)=>{
      loadTimer=setTimeout(()=>reject(Error('瓜子登录页加载超时')),30000);
    })]).then(()=>w)
      .catch(e=>{if(!w.isDestroyed())w.destroy();throw e;}).finally(()=>{clearTimeout(loadTimer);this.loading.delete(a.id);});
    this.loading.set(a.id,task);return task;
  }
  raw(a,method,params={}) {
    const previous=this.queues.get(a.id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      let timer;
      const timeout=new Promise(resolve=>{timer=setTimeout(()=>{
        const w=this.windows.get(a.id);if(w&&!w.isDestroyed())w.destroy();
        resolve({ok:false,code:'TIMEOUT',message:'瓜子页面请求超时，请稍后重试'});
      },25000);});
      try{return await Promise.race([(async()=>{
        const w=await this.window(a);
        if(isVerificationPage(w.webContents.getURL()))return {ok:false,code:'CAPTCHA_REQUIRED',message:'瓜子要求滑块验证，请在右侧点击验证'};
        let r;
        for(let i=0;i<20;i++) {
          r=await w.webContents.executeJavaScript(pageCall(method,params));
          if(r.code!=='PAGE_NOT_READY')return r;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        return r;
      })(),timeout]);}catch{return {ok:false,code:'GUAZI_CONNECTION_FAILED',message:'瓜子页面连接失败，请重新打开登录页'};}
      finally{clearTimeout(timer);}
    });
    this.queues.set(a.id,task);return task;
  }
  async login(id) {
    const a=this.get(id);a.status='opening';this.publish();
    try {
      const parent=this.parent?.();
      if(!parent||parent.isDestroyed()||!this.EmbeddedLogin)throw Error('登录面板未就绪');
      this.closeLogin();
      const panel=new this.EmbeddedLogin(parent,this.partition(a),this.log,{
        channel:'guazi-login',preload:path.join(__dirname,'guazi-auth-preload.js'),referenceWidth:320,challengeWidth:380
      });
      this.loginPanel=panel;this.loginAccountId=id;
      panel.webContents.on('will-navigate',(event,url)=>{
        try{if(!/(^|\.)guazi\.com$/.test(new URL(url).hostname))event.preventDefault();}catch{event.preventDefault();}
      });
      panel.webContents.on('did-navigate',(_event,url)=>{
        try{
          if(new URL(url).hostname==='www.guazi.com'&&a.status==='verification-required'){
            const worker=this.windows.get(id);if(worker&&!worker.isDestroyed())worker.destroy();
            void this.refresh(id).catch(()=>{});
          }
        }catch{}
      });
      panel.once('closed',()=>{if(this.loginPanel===panel){this.loginPanel=null;this.loginAccountId='';}});
      await panel.loadURL('https://www.guazi.com/gujia/');
      if(panel.isDestroyed()||this.loginPanel!==panel)return this.snapshot();
      await this.refresh(id);
      if(panel.isDestroyed()||this.loginPanel!==panel)return this.snapshot();
      if(a.status==='verification-required')return this.snapshot();
      // The official login control only opens its login form; SMS, CAPTCHA and
      // submitting credentials remain entirely user-operated on the real page.
      let ready=false;
      for(let attempt=0;attempt<40;attempt++) {
        if(panel.isDestroyed()||this.loginPanel!==panel)return this.snapshot();
        ready=await panel.webContents.executeJavaScript(`(()=>{
          const form=document.querySelector('.login-box-popup .login-box');
          if(form?.getBoundingClientRect().width>0)return true;
          // Hydration can finish after did-finish-load. Only retry the login
          // opener, never the SMS or login/registration submit controls.
          const el=document.querySelector('.user-login');el?.click();
          return false;
        })()`);
        if(ready)break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!ready)throw Error('瓜子原始登录表单尚未就绪');
    }catch{a.status='error';this.loginPanel?.setPhase('failed');this.publish();}
    return this.snapshot();
  }
  async refresh(id) {
    const a=this.get(id),r=await this.raw(a,'user');
    a.errorMessage=r.ok?'':String(r.message||'登录检查尚未完成').slice(0,180);
    if(!r.ok)this.log('瓜子登录验证未完成',{code:r.code,message:a.errorMessage});
    a.status=r.ok && r.data?.authenticated?'authenticated':r.code==='CAPTCHA_REQUIRED'?'verification-required':AUTH_CODES.has(String(r.code))?'signed-out':'unchecked';
    if(a.status==='authenticated'){
      await this.session.fromPartition(this.partition(a)).cookies.flushStore();
      if(this.loginAccountId===id)this.closeLogin();
    }
    this.publish();return this.snapshot();
  }
  async call(method,params) {
    let a=this.accounts.find(a=>a.active);
    if(!a)return {ok:false,code:'NO_ACCOUNT',message:'请在右侧添加并登录瓜子账号'};
    // An expired session may use another already-valid login. Explicit service
    // throttling is returned to the paced queue, never retried across accounts.
    const candidates=this.managed?[a]:[a,...this.accounts.filter(x=>x!==a&&x.status==='authenticated')];
    for(const candidate of candidates) {
      if(method==='quote' && candidate.status!=='authenticated')await this.refresh(candidate.id);
      if(candidate.status==='verification-required')return {ok:false,code:'CAPTCHA_REQUIRED',message:'请在右侧完成瓜子滑块验证'};
      if(method==='quote' && candidate.status!=='authenticated')continue;
      const r=await this.raw(candidate,method,params);
      if(r.code==='CAPTCHA_REQUIRED'){candidate.status='verification-required';candidate.errorMessage=r.message;this.publish();return r;}
      if(AUTH_CODES.has(String(r.code))) {candidate.status='signed-out';this.publish();continue;}
      if(candidate!==a && a.active){this.select(candidate.id);this.log('瓜子原登录失效，已切换有效登录');}
      if(method==='quote'){
        candidate.requests++;this.save();
        if(!this.managed&&r.ok&&candidate.active&&candidate.requests>=20){
          const next=this.accounts.find(x=>x!==candidate&&x.status==='authenticated');
          if(next){next.requests=0;this.select(next.id);this.log('下一次估价使用备用瓜子账号');}
        }
      }
      return r;
    }
    return {ok:false,code:'AUTH_REQUIRED',message:'请先完成瓜子账号登录'};
  }
  async remove(id) {
    const a=this.get(id);
    const {response}=await this.dialog.showMessageBox(this.parent(),{type:'question',buttons:['取消','删除'],defaultId:0,cancelId:0,
      message:'删除'+a.label+'？',detail:'仅清除此瓜子账号的本地登录状态，车300账号和车辆数据保留。'});
    if(response!==1)return this.snapshot();
    if(this.loginAccountId===id)this.closeLogin();
    const w=this.windows.get(id);if(w&&!w.isDestroyed())w.destroy();
    await this.queues.get(id)?.catch(()=>{});
    const s=this.session.fromPartition(this.partition(a));await s.clearStorageData();await s.clearCache();
    this.accounts=this.accounts.filter(x=>x!==a);
    if(a.active&&this.accounts.length)this.accounts[0].active=true;
    this.save();return this.snapshot();
  }
  closeLogin(){this.loginPanel?.close();this.loginPanel=null;this.loginAccountId='';}
  close(){this.closeLogin();for(const w of this.windows.values())if(!w.isDestroyed())w.destroy();}
}

function registerGuaziLoginIpc(ipcMain,getParent,manager) {
  const trusted=event=>event.sender===getParent()?.webContents;
  ipcMain.on('guazi-login:bounds',(event,bounds)=>{if(trusted(event))manager.loginPanel?.setBounds(bounds);});
  ipcMain.on('guazi-login:close',event=>{if(trusted(event))manager.closeLogin();});
  ipcMain.on('guazi-login:retry',event=>{
    if(trusted(event)&&manager.loginAccountId)void manager.login(manager.loginAccountId);
  });
  ipcMain.on('guazi-login:document-state',(event,state)=>{
    const panel=manager.loginPanel;
    if(panel && event.sender===panel.webContents && event.senderFrame===event.sender.mainFrame)
      panel.updateFormState(state);
  });
}
module.exports={GuaziAccounts,registerGuaziLoginIpc,isVerificationPage};
