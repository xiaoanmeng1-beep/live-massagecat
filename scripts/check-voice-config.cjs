// Optional --generate exercises the actually installed local model. No account or live connection.
'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
const wav=require('../tests/voice-fixture.cjs');
const {VoiceLibrary,registerVoiceIpc}=require('../voice-library');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'voice-config-'));
app.setPath('userData',tmp);
app.whenReady().then(async()=>{
  const lib=new VoiceLibrary(tmp);lib.engine=path.join(root,'data/qwen3-tts');
  const manual=process.argv.includes('--base')||process.argv.includes('--generate');
  const fixture=wav(tmp,'独立测试录音'),source=process.env.TEST_REFERENCE_WAV||fixture;
  if(process.argv.includes('--base')&&!process.env.TEST_REFERENCE_WAV)throw Error('--base 请用 TEST_REFERENCE_WAV 指定本次测试的参考录音');
  if(!manual){lib.installed=()=>true;lib.warm=async()=>{};lib.ephemeral=async()=>fs.readFileSync(fixture)}
  lib.import(wav(tmp,'多车提醒'),'missing','MULTIPLE_CARS');
  lib.import(wav(tmp,'年份提醒'),'missing','DATE');
  const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{preload:path.join(root,'preload.js'),backgroundThrottling:false}});
  w.webContents.setAudioMuted(true);
  const exported=path.join(tmp,'试听稿.wav');let cancelExport=true;
  registerVoiceIpc(ipcMain,lib,()=>w,{
    showOpenDialog:(_w,opts)=>({canceled:false,filePaths:[opts.title.includes('参考')?source:fixture]}),
    showSaveDialog:()=>({canceled:cancelExport,filePath:exported})
  });
  for(const [,key] of fs.readFileSync(path.join(root,'preload.js'),'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)){
    if(!key.startsWith('voice:'))ipcMain.handle(key,()=>key==='live:board'?{rev:0,history:[],pending:[]}:[]);
  }
  const wc=w.webContents,run=s=>wc.executeJavaScript(s,true);
  await w.loadFile(path.join(root,'app/index.html'));
  async function wait(expr,ms=10000){
    for(const end=Date.now()+ms;Date.now()<end;){if(await run(expr))return;await new Promise(r=>setTimeout(r,40))}
    throw Error('timeout: '+expr+' / '+await run('voiceNote.textContent'));
  }
  const rows=k=>"document.querySelector('[data-bank="+k+"] ol')";
  await wait('!voiceAuto.disabled');
  assert.equal(await run('voiceBanks.children.length'),4);
  assert.ok(await run("voiceAuto.matches('input[type=checkbox][role=switch]') && !document.querySelector('#voiceStop,#voicePolicy')"));
  await run("voicePanel.open=voiceStudio.open=true;window.confirm=()=>true;window.__progress=[];desktop.onVoiceProgress(p=>__progress.push(p));true");
  await run("voiceText.value='欢迎来估车，车型和年份发在评论区。';voiceText.dispatchEvent(new Event('input'));true");
  assert.ok(await run('voiceExport.disabled && voiceImport.nextElementSibling===voiceExport'));
  if(process.argv.includes('--base')){
    await run("voiceModel.value='base';voiceModel.dispatchEvent(new Event('change'));true");
    assert.ok(await run('voiceGenerate.disabled && voiceDesignFields.hidden && !voiceBaseFields.hidden'));
    await run('voicePickReference.click();true');await wait("voiceRefSlot.querySelector('audio')!==null");
    assert.ok(await run("!voiceGenerate.disabled && voiceRefText.value===''"));
    const transcript=process.env.TEST_REFERENCE_TEXT; if(process.argv.includes('--transcript')&&!transcript)throw Error('请设置准确的 TEST_REFERENCE_TEXT');
    if(process.argv.includes('--transcript'))await run("voiceRefText.value="+JSON.stringify(transcript)+";voiceRefText.dispatchEvent(new Event('input'));true");
    assert.ok(await run('!voiceGenerate.disabled'));await run('voiceGenerate.click();true');
  }else if(process.argv.includes('--generate')){
    assert.ok(await run('!voiceGenerate.disabled'));await run('voiceGenerate.click();true');
  }else await run('voiceImport.click();true');
  await wait("!voiceDraft.hidden && !document.querySelector('[data-target=welcome]').disabled",360000);
  if(process.argv.includes('--base')){
    assert.equal(lib.state.draft.mode,process.argv.includes('--transcript')?'transcript':'audio-only');
    assert.ok(await run("__progress.some(p=>p.tokens>0)&&__progress.some(p=>p.stage==='complete')&&voiceJob.hidden"));
    const pid=lib.pool.child.pid,saved=lib.state.draft.clip,filesBefore=fs.readdirSync(lib.clips).sort();assert.deepEqual(filesBefore,[]);
    await run('voiceGenerate.click();true');await wait("!voiceJob.hidden && __progress.at(-1).stage==='generating'",120000);
    await run('voiceCancel.click();true');await wait("voiceJob.hidden&&!voiceGenerate.disabled&&voiceNote.textContent.includes('已取消')");
    assert.equal(lib.pool.child.pid,pid);assert.equal(lib.state.draft.clip,saved);assert.deepEqual(fs.readdirSync(lib.clips).sort(),filesBefore);
  }
  assert.equal(lib.state.scenes.welcome.rows.length,0);
  await run('voiceExport.click();true');await wait('!voiceExport.disabled');assert.ok(!fs.existsSync(exported));
  cancelExport=false;await run('voiceExport.click();true');await wait("voiceNote.textContent.includes('已导出')");
  assert.deepEqual(fs.readFileSync(exported),lib.audio(lib.state.draft.clip));
  await run("voiceDraftSlot.scrollIntoView();window.aud=voiceDraftSlot.querySelector('audio');true");
  await wait('aud.readyState>=2');await run('aud.play()');await wait('!aud.paused && aud.currentTime>.1');
  await run('aud.pause();window.pos=aud.currentTime;true');await wait('aud.paused');
  await run('aud.play()');await wait('!aud.paused && aud.currentTime>pos');
  await run("aud.currentTime=1;voiceDraftSlot.querySelector('button').click();true");await wait('!aud.paused && aud.currentTime<.7');
  await run("aud.pause();document.querySelector('[data-target=welcome]').click();true");
  await wait(rows('welcome')+".querySelector('audio')!==null");
  await run("window.b=document.querySelector('[data-bank=missing]');b.querySelector('details').open=true;window.filter=b.querySelector('select');window.select=k=>{filter.value=k;filter.dispatchEvent(new Event('change'))};true");
  const contents=()=>run("Array.from(b.querySelectorAll('li p'),x=>x.textContent)");
  assert.deepEqual(await contents(),['1. 多车提醒']);await run("select('DATE');true");assert.deepEqual(await contents(),['1. 年份提醒']);
  await run("window.rowAudio=b.querySelector('audio');rowAudio.scrollIntoView();true");await wait('rowAudio.readyState>=2');
  await run('rowAudio.play()');await wait('rowAudio.currentTime>.1');await run('rowAudio.pause();window.t=rowAudio.currentTime;true');
  await run('rowAudio.play()');await wait('!rowAudio.paused && rowAudio.currentTime>t');
  await run("select('NO_TRIM');true");assert.ok(await run("rowAudio.paused && !b.querySelector('audio') && b.querySelector('ol').textContent.includes('配置不匹配')"));
  const originalDraft=lib.state.draft.clip;
  await run("b.querySelector('[data-append]').click();true");await wait("b.querySelector('li audio')!==null");
  assert.equal(lib.state.scenes.missing.rows.at(-1).reason,'NO_TRIM');
  await run("b.querySelector('[data-import]').click();true");await wait("b.querySelectorAll('li audio').length===2");
  assert.equal(lib.state.scenes.missing.rows.at(-1).reason,'NO_TRIM');assert.equal(lib.state.draft.clip,originalDraft);
  await run("b.querySelector('li:last-child .voice-actions button').click();true");
  await wait("voiceNote.textContent.includes('已替换')");assert.equal(lib.state.scenes.missing.rows.at(-1).clip,originalDraft);
  await run("b.querySelector('li:last-child .voice-actions button:last-child').click();true");await wait("b.querySelectorAll('li audio').length===1");
  assert.equal(lib.state.scenes.missing.rows.filter(r=>r.reason==='DATE').length,1);
  const ed="document.querySelector('[data-bank=quote] textarea')";
  await run(ed+".value='{车系}，{价格}。';"+ed+".dispatchEvent(new Event('change'));true");
  await wc.reload();await wait("!voiceAuto.disabled && document.querySelector('[data-bank=missing] ol audio')!==null");
  assert.equal(await run(ed+".value"),'{车系}，{价格}。');
  // Leave the visible category on MULTIPLE_CARS; a DATE cue must still play the DATE recording.
  await run("voiceAuto.click();true");assert.ok(await run('voiceAuto.checked'));
  wc.send('live:status',{state:'connected',room:'test',process:{capture:{room:'test',phase:'listening'}}});
  const cue=(scene,data)=>wc.send('voice:cue',{scene,room:'test',...data});
  cue('missing',{viewer:'one',name:'春天里的小汽车',code:'DATE'});
  await wait("voicePlaying.textContent.includes('春天里的小老板')",30000);
  await wait("voicePlaying.textContent.includes('年份提醒')",12000);
  cue('admitted',{viewer:'one'});await wait("voicePlaying.textContent===''");
  cue('quote',{id:123,series:'朗逸',low:1.77,high:2.3});
  await wait("voicePlaying.textContent.includes('朗逸')&&voicePlaying.textContent.includes('一万七千七百到两万三千')",120000);
  await run("voiceAuto.click();true");await wait("!voiceAuto.checked && voicePlaying.textContent===''");
  assert.deepEqual(fs.readdirSync(lib.clips),[]);
  assert.deepEqual(new Set(lib.store.db.prepare('SELECT clip FROM voice_scene_audio').all().map(r=>r.clip)),
    new Set(Object.values(lib.state.scenes).flatMap(s=>s.rows.map(r=>r.clip))));
  console.log('PASS: switch, native row/draft pause-resume-seek-replay, filter/import/replace/delete, correct runtime reason independent of filter, nickname, quote, WAV export and database inventory.');
  lib.close();w.destroy();app.quit();
}).catch(err=>{console.error(err);app.exit(1)});
