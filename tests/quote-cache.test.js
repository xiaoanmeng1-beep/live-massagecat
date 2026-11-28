'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DataStore } = require('../data-store');
const { LatestRequest, RequestScope } = require('../latest-request');
const {localVehiclePhoto}=require('../vehicle-photos');
const {sourceVehicle}=require('../guazi-service');
const source = fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
function mainFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function '+name+'\\(', 'm'));
  assert.notEqual(start,-1,name);
  const rest = source.slice(start);
  const end = rest.indexOf('\n}\n') + 2;
  return rest.slice(0,end);
}
const input = {provinceId:'20',cityId:'20',modelId:'1000',registration:'2013-01',mileage:2.9};

function fixture() {
  const store = new DataStore(':memory:');
  const old = {fetchedAt:1,prices:{good:{low:1,high:2}},priceRuleVersion:6,vehicle:{name:'英朗XT',imageUrl:''}};
  store.saveQuote('20:20:1000:2013-1:2.9',old);
  let online = 0;
  const context = vm.createContext({
    dataStore:store,localVehiclePhoto,sourceVehicle,console,setTimeout,clearTimeout,Date,RequestScope,quoteRequests:new LatestRequest(),
    emitLog:()=>{}, originalVehiclePhotoUrl:url=>url, accounts:[], currentAccountId:'none',
    session:{fromPartition:()=>{online++;throw Error('Unexpected session access');}},
    scheduleAccountMaintenance:()=>{online++;},
    serializeBrowserWork:task=>Promise.resolve().then(task),
    validNumericId:(id)=>String(id),
    getQuoteWindow:()=>{online++;throw Error('Unexpected browser request');}
  });
  for (const name of ['normalizeCachedQuote','cachedQuoteForInput','requestLiveQuote','estimateVehicle','estimateWithLogin','submitEstimate'])
    vm.runInContext(mainFunction(name),context);
  return {store,context,old,online:()=>online};
}

test('2000 年之前的旧报价依然精确命中，直播/试算/手动/底层全都不碰登录和网络', async () => {
  const f = fixture();
  try {
    for (const name of ['requestLiveQuote','estimateVehicle','estimateWithLogin','submitEstimate']) {
      const scope = new RequestScope('cache-test');
      try {
        const result = await f.context[name](input,scope);
        assert.equal(result.ok,true,name); assert.equal(result.cached,true,name);
        assert.equal(result.fetchedAt,1,name); assert.equal(result.prices.good.low,1,name);
        assert.notEqual(result.refreshing,true,name);
      } finally {scope.dispose();}
    }
    await new Promise(setImmediate); assert.equal(f.online(),0);
    assert.equal(f.store.getQuote('20:20:1000:2013-1:2.9').fetchedAt,1);
  } finally {f.store.db.close();}
});

test('地区、车型、年月、里程不同不当作精确命中，直播也不拿同款不同条件旧价冒充', async () => {
  const f = fixture();
  try {
    for (const patch of [{provinceId:'1'},{cityId:'1'},{modelId:'2'},{registration:'2014-01'},{mileage:3}]) {
      const changed = {...input,...patch};
      assert.equal(f.context.cachedQuoteForInput(changed,false),null);
      const result = await f.context.requestLiveQuote(changed);
      assert.equal(result.code,'AUTH_REQUIRED');
    }
    f.store.db.prepare('UPDATE quotes SET payload=?').run('broken JSON');
    assert.equal(f.context.cachedQuoteForInput(input,false),null);
    assert.equal(f.online(),0);
  } finally {f.store.db.close();}
});

test('显式强制更新仍会走在线分支，但普通缓存命中不隐式强制更新', async () => {
  const f = fixture();
  try {
    let requests = 0;
    f.context.estimateWithLogin = async()=>{requests++;return {ok:true,cached:false};};
    assert.equal((await f.context.submitEstimate(input)).cached,true);
    assert.equal(requests,0);
    assert.equal((await f.context.submitEstimate({...input,forceRefresh:true})).cached,false);
    assert.equal(requests,1);
  } finally {f.store.db.close();}
});

test('瓜子测试不拿车300缓存冒充：严格平台、强制请求，目录缺失也不换平台', async () => {
  const f=fixture();
  try {
    f.store.setSetting('quote.provider','guazi');
    f.context.accounts=[{id:'a',status:'authenticated'}];f.context.currentAccountId='a';
    const calls=[];
    f.context.guaziService={quote:async input=>{calls.push(input);return {ok:false,code:'AUTH_REQUIRED'};}};
    const strict=await f.context.requestLiveQuote(input,{strictProvider:true});
    assert.equal(strict.code,'AUTH_REQUIRED');assert.equal(strict.cached,undefined);
    // Regular live processing may use an authenticated alternate login, unlike
    // strict integration validation. A model miss never uses that fallback.
    assert.equal((await f.context.requestLiveQuote(input)).cached,true);
    f.context.guaziService.quote=async()=>({ok:false,code:'NO_MODEL'});
    assert.equal((await f.context.requestLiveQuote(input)).code,'NO_MODEL');
    f.context.guaziService.quote=async actual=>{assert.notEqual(actual.forceRefresh,true);return {ok:false,code:'AUTH_REQUIRED'};};
    f.context.lastTestMatch={ticket:'ticket',input};f.context.board={current:null,pending:[]};
    vm.runInContext(mainFunction('testCommentQuote'),f.context);
    assert.equal((await f.context.testCommentQuote('ticket')).code,'AUTH_REQUIRED');
  }finally{f.store.db.close();}
});
