'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DataStore } = require('../data-store');
const { QuoteBoard } = require('../live-board');
const { readQuoteInterval, registerQuoteSettingsIpc } = require('../quote-settings');

test('报价间隔默认 7 秒，IPC 即改即生效、SQLite 重开后保留，非法值不污染设置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'lmc-settings-'));
  const file = path.join(dir,'test.sqlite');
  let store = new DataStore(file);
  try {
    assert.equal(readQuoteInterval(store),7);
    const board = new QuoteBoard({ quote:async()=>{} });
    const ipc = new Map();
    registerQuoteSettingsIpc({ handle:(key,fn) => ipc.set(key,fn) },store,board);
    const set = value => ipc.get('live:set-quote-interval')(null,value);
    assert.equal(set(10).ok,true); assert.equal(board.holdMs,10000);
    assert.deepEqual(ipc.get('live:quote-settings')(),{intervalSeconds:10});
    for (const value of ['',null,undefined,true,{},[],0,-1,1.5,'1e2',' 5 ',3601,NaN,Infinity]) {
      assert.equal(set(value).ok,false,String(value)); assert.equal(board.holdMs,10000);
    }
    store.db.close(); store = new DataStore(file);
    assert.equal(readQuoteInterval(store),10);
    store.setSetting('live.quoteIntervalSeconds','bad'); assert.equal(readQuoteInterval(store),7);
    store.db.prepare('UPDATE app_settings SET value=?').run('not json');
    assert.equal(readQuoteInterval(store),7);
  } finally { store.db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('保存失败给出原因，运行间隔不变', () => {
  const ipc = new Map(), board = new QuoteBoard({quote:async()=>{}});
  registerQuoteSettingsIpc({handle:(key,fn)=>ipc.set(key,fn)}, {setSetting:()=>{throw Error('disk full');}},board);
  const result = ipc.get('live:set-quote-interval')(null,15);
  assert.equal(result.ok,false); assert.match(result.message,/disk full/); assert.equal(board.holdMs,7000);
});

test('右侧输入校验和异步保存提示，旧回复不覆盖新输入状态', async () => {
  const input = {value:'5',disabled:true,events:{},addEventListener(key,fn){this.events[key]=fn;}};
  const message = {textContent:''}; let resolveSave; const values = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/quote-settings-view.js'),'utf8'),{
    document:{getElementById:id=>id==='quoteIntervalInput'?input:message},setTimeout,clearTimeout,
    window:{desktop:{getQuoteSettings:async()=>({intervalSeconds:8}),setQuoteInterval:value=>{
      values.push(value); return new Promise(resolve=>{resolveSave=resolve;});
    }}}
  });
  await new Promise(setImmediate);
  assert.equal(input.value,'8'); assert.equal(input.disabled,false);
  input.value='10'; const saving=input.events.change();
  input.value=''; input.events.input();
  resolveSave({ok:true,intervalSeconds:10}); await saving;
  assert.match(message.textContent,/请输入/);
  input.value='15'; const next=input.events.change();
  resolveSave({ok:true,intervalSeconds:15}); await next;
  assert.deepEqual(values,[10,15]); assert.match(message.textContent,/已保存.*15/);
});
