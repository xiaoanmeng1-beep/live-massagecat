'use strict';
// Run with Electron, not node. Uses an isolated login/storage profile and an
// in-memory catalog copy. It never mutates the live database or sends leads.
// electron scripts/replay-guazi-quotes.cjs --ids 194,123,208 --login
const {app,BrowserWindow,session,dialog,ipcMain}=require('electron');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),path=require('node:path');
const {DataStore}=require('../data-store');
const {makeParser}=require('../live-parser');
const {GuaziAccounts,registerGuaziLoginIpc}=require('../guazi-electron');
const {EmbeddedLogin}=require('../embedded-login');
const {GuaziService}=require('../guazi-service');
const args=process.argv.slice(2),value=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const directory=fs.mkdtempSync('/tmp/lmc-guazi-replay-');
fs.mkdirSync(path.join(directory,'profile'),{recursive:true});
app.setPath('userData',path.join(directory,'profile'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const source=new DatabaseSync(path.resolve(value('--db',path.join(__dirname,'../data/valuation.sqlite'))),{readOnly:true});
  const store=new DataStore(':memory:');
  for(const table of ['brands','series','models','provinces','cities']) {
    const rows=source.prepare('SELECT * FROM '+table).all();
    if(!rows.length)continue;
    const keys=Object.keys(rows[0]),stmt=store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
    store.transaction(()=>{for(const row of rows)stmt.run(...keys.map(k=>row[k]));});
  }
  let loginHost;
  const manager=new GuaziAccounts({store,BrowserWindow,session,dialog,EmbeddedLogin,parent:()=>loginHost});
  registerGuaziLoginIpc(ipcMain,()=>loginHost,manager);
  const id=manager.add();
  if(args.includes('--login')) {
    loginHost=new BrowserWindow({width:460,height:650,title:'瓜子回归登录',webPreferences:{
      preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false}});
    await loginHost.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:16px;font:14px sans-serif"><h3>瓜子账号登录</h3><p id="notice">正在加载登录表单</p><div id="host" style="height:480px"></div></body></html>'));
    await loginHost.webContents.executeJavaScript(`(()=>{
      const host=document.getElementById('host');
      const bounds=()=>{const r=host.getBoundingClientRect();window.desktop.setGuaziLoginBounds({x:r.x,y:r.y,width:r.width,height:r.height});};
      window.desktop.onGuaziLoginState(s=>{document.getElementById('notice').textContent=s.phase==='closed'?'登录已确认':s.phase==='failed'?'加载失败，请重启回归':'等待登录';bounds();});
      window.desktop.onGuaziLoginFormState(s=>{document.getElementById('notice').textContent=s.challenge?'请完成下方滑块验证':s.errorMessage||'请填写手机号与验证码';bounds();});
      window.addEventListener('resize',bounds);bounds();
    })()`);
    await manager.login(id);
    console.log('请在内嵌瓜子表单完成登录；等待最多五分钟。');
    const started=Date.now();
    while(!manager.snapshot().some(a=>a.status==='authenticated')&&Date.now()-started<300000)
      await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const service=new GuaziService({store,call:(...a)=>manager.call(...a)}),parse=makeParser(store.db);
  const ids=value('--ids','').split(',').map(Number).filter(n=>Number.isInteger(n)&&n>0);
  const limit=Math.min(50,Math.max(1,Number(value('--limit','10'))||10));
  const rows=ids.length?source.prepare(`SELECT id,comment_text text FROM live_comments WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids):
    source.prepare('SELECT id,comment_text text FROM live_comments ORDER BY id DESC').all();
  const report={profile:directory,attempted:0,passed:0,blocked:null,rows:[]};
  for(const comment of rows) {
    const parsed=parse(comment);
    if(!parsed.ok)continue;
    const r=await service.quote({...parsed.job.input,forceRefresh:true});report.attempted++;
    report.rows.push({id:comment.id,text:comment.text,input:parsed.job.input,
      ok:r.ok,code:r.code,reason:r.message,provider:r.provider,model:r.providerModel,params:r.requestParams,prices:r.prices});
    if(r.ok)report.passed++;
    if(['AUTH_REQUIRED','NO_ACCOUNT','RATE_LIMITED'].includes(r.code)){report.blocked=r.code;break;}
    if(report.attempted>=limit)break;
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  const file=path.resolve(value('--report',path.join(directory,'report.json')));
  fs.writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({attempted:report.attempted,passed:report.passed,blocked:report.blocked,report:file}));
  manager.close();loginHost?.destroy();source.close();store.db.close();app.exit(report.blocked||report.passed!==report.attempted||!report.attempted?2:0);
}).catch(e=>{console.error(e.message);app.exit(1);});
