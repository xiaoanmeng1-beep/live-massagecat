// An isolated real renderer, using an in-memory image response; no live-room connection.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'messagecat-avatar-ui-'));
app.setPath('userData',temp);app.disableHardwareAcceleration();
const root=path.resolve(__dirname,'..');
const avatar='https://p3-pc-sign.douyinpic.com/avatar/ui-fixture.png';
app.whenReady().then(async()=>{
  const ses=session.fromPartition('avatar-ui');
  ses.protocol.handle('https',req=>req.url===avatar
    ?new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}})
    :new Response('',{status:404}));
  const empty={rev:0,pending:[],history:[],current:null};
  for(const [,name] of fs.readFileSync(path.join(root,'preload.js'),'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)){
    if(name==='live:board')ipcMain.handle(name,()=>empty);
    else ipcMain.handle(name,()=>[]);
  }
  const w=new BrowserWindow({show:false,webPreferences:{session:ses,preload:path.join(root,'preload.js')}});
  const wc=w.webContents,run=s=>wc.executeJavaScript(s), delay=ms=>new Promise(r=>setTimeout(r,ms));
  async function check(expr){for(let j=0;j<80;j++){if(await run(expr))return;await delay(25);}assert.fail(expr);}
  await w.loadFile(path.join(root,'app/index.html'));
  const job={id:3,eventId:'ui:3',room:'123456',name:'测试观众',car:'思域',input:{registration:'2019-01',mileage:6},low:4,high:5};
  wc.send('live:comment',{...job,text:'19年思域6万公里'});
  wc.send('live:board',{...empty,rev:1,history:[job]});
  await check("boardCurrent.textContent.includes('测试观众') && douyinLastComment.textContent.includes('思域')");
  await run('window.originalVehicle=boardCurrent.querySelector(".board-vehicle-photo");true');
  const withAvatar={...job,avatar};
  wc.send('live:board',{...empty,rev:2,history:[withAvatar]});
  await check("['#boardCurrent .board-avatar img','#douyinLastComment img'].every(s=>document.querySelector(s)?.naturalWidth===1)");
  assert.ok(await run('originalVehicle===boardCurrent.querySelector(".board-vehicle-photo")'));
  const next={...job,id:4,eventId:'ui:4',avatar:'',car:'朗逸'};
  wc.send('live:comment',{...next,text:'同名新留言'});
  wc.send('live:board',{...empty,rev:3,history:[next,withAvatar]});
  await check("boardHistory.querySelector('.board-avatar img')?.naturalWidth===1 && !douyinLastComment.querySelector('img') && douyinLastComment.textContent.includes('同名新留言')");
  console.log('PASS: real image decoded in featured quote, quote history and latest comment; matching by event, car preserved.');
  w.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
