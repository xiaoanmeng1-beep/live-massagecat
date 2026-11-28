'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DataStore}=require('../data-store');
const {GuaziService,buildQuoteParams,normalizeQuote,matchingName,chooseTrim}=require('../guazi-service');
const {QuoteBoard}=require('../live-board');
const {RequestScope}=require('../latest-request');
const {pageCall}=require('../guazi-page-client');
const {QuoteAccountPool}=require('../quote-account-pool');
function fixture() {
  const store=new DataStore(':memory:');
  store.replaceBrands('passenger',[{id:'40',name:'本田',initial:'H'}]);
  store.replaceSeries('passenger','40',[{id:'388',name:'思域'}]);
  store.replaceModels('passenger','40','388',[{id:'1231162',name:'2019款 思域 220TURBO CVT劲动版 国V',year:'2019',minRegistrationYear:'2019',maxRegistrationYear:'2020',catalogPrice:'13.99万'}]);
  store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
  const data={brands:{filterValue:{common:{H:[{id:'1196',name:'本田'}]}}},
    series:{filterValue:{tagList:[{id:'0',name:'不限'},{id:'2711',name:'思域'}]}},
    cities:{common:{G:[{city_id:'81',name:'广州'}]}},
    models:{cheXingList:[{displayName:'全部',fieldValue:'-1'},{displayName:'2019款',fieldValue:'2019',filterValue:[
      {fieldValue:'190437',displayName:'2019款 220TURBO CVT劲擎版 国V'},
      {fieldValue:'190436',displayName:'2019款 220TURBO CVT劲动版 国V'}]}]},
    quote:{consignPriceBegin:80000,consignPriceEnd:90000,priceBegin:60000,priceEnd:70000}};
  const trace=[],learned=[];
  const service=new GuaziService({store,call:async(method,params)=>{trace.push({method,params});return {ok:true,data:data[method]};},
    learn:(...args)=>learned.push(args)});
  const input={provinceId:'20',cityId:'20',modelId:'1231162',registration:'2019-01',mileage:6};
  return {store,data,trace,learned,service,input};
}
test('瓜子使用独立ID和公里，固定车商价；报价缓存不串车300、不重复训练',async()=>{
  const f=fixture();try{
    f.store.saveQuote('20:20:1231162:2019-1:6',{fetchedAt:1,prices:{good:{low:3,high:4}}});
    const r=await f.service.quote(f.input);
    assert.equal(r.ok,true);assert.deepEqual(r.prices.good,{low:6,high:7});assert.equal(r.quoteBasis,'dealer');
    assert.deepEqual(f.trace.find(t=>t.method==='quote').params,{carId:190436,roadHaul:60000,cityId:81,tagId:2711});
    assert.equal(r.vehicle.imageUrl,'car-silhouette.svg');assert.match(r.providerModel.name,/思域/);
    const n=f.trace.length;
    const cached=await f.service.quote(f.input);assert.equal(cached.cached,true);assert.equal(f.trace.length,n);
    assert.equal(f.learned.length,1);
    assert.equal(f.store.getLatestQuoteForModel('1231162').quote.prices.good.low,3);
    await f.service.quote({...f.input,mileage:7});assert.equal(f.learned.length,2);
    assert.equal(f.trace.filter(t=>t.method==='brands').length,1);
  }finally{f.store.db.close();}
});
test('无车商价格不退用个人价；登录、限频、目录缺失各自返回',async()=>{
  for(const [change,code] of [[f=>{f.data.quote={consignPriceBegin:80000,consignPriceEnd:90000};},'NO_PRICE'],
    [f=>{f.service.call=async()=>({ok:false,code:10001,message:'用户未登录'});},'AUTH_REQUIRED'],
    [f=>{f.service.call=async()=>({ok:false,code:429,message:'请求频繁'});},'RATE_LIMITED'],
    [f=>{f.data.brands={filterValue:{common:{}}};},'NO_MODEL']]){
    const f=fixture();try{change(f);const r=await f.service.quote(f.input);assert.equal(r.code,code);assert.equal(f.learned.length,0);}finally{f.store.db.close();}
  }
});
test('错误报价不缓存，强制刷新实际发请求；取消后不保存、不训练',async()=>{
  const f=fixture();try{
    await f.service.quote(f.input);await f.service.quote({...f.input,forceRefresh:true});
    assert.equal(f.trace.filter(t=>t.method==='quote').length,2);
    const scope=new RequestScope('guazi');let finish;
    f.service.call=async()=>new Promise(r=>{finish=r;});
    const n=f.learned.length,p=f.service.quote({...f.input,mileage:8},scope);
    await new Promise(setImmediate);scope.cancel();finish({ok:true,data:f.data.quote});
    const r=await p;assert.equal(r.ok,false);assert.equal(f.learned.length,n);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM quotes').get().n,1);
  }finally{f.store.db.close();}
});
test('有效瓜子响应才进入卡片，最多四张；后台预测不作报价结果',async()=>{
  const f=fixture();try{
    const b=new QuoteBoard({quote:input=>f.service.quote(input),holdMs:0});
    b.add({id:1,name:'测试观众',car:'思域',input:f.input});
    for(let n=0;n<20&&b.busy;n++)await new Promise(setImmediate);
    assert.equal(b.history.length,1);assert.equal(b.history[0].low,6);
    assert.match(b.history[0].car,/劲动版/);assert.equal(b.history[0].photo,'car-silhouette.svg');
  }finally{f.store.db.close();}
});
test('品牌、车系标准化及同年配置字符命中，不复用原平台车型ID',()=>{
  assert.equal(matchingName([{name:'上汽大通MAXUS',id:'4'}],'上汽MAXUS').id,'4');
  assert.equal(matchingName([{name:'魏牌',value:'wey',id:'5'}],'WEY').id,'5');
  assert.equal(matchingName([{name:'雷克萨斯NX',id:'2'}],'雷克萨斯NX(进口)','雷克萨斯').id,'2');
  assert.equal(matchingName([{name:'Q5L',id:'2'},{name:'Q5',id:'1'}],'奥迪Q5','奥迪').id,'1');
  assert.equal(matchingName([{name:'起亚K3',id:'3'}],'思域','本田'),undefined);
  assert.equal(chooseTrim([{year:2020,name:'舒适',id:'a'},{year:2019,name:'豪华',id:'b'},{year:2019,name:'舒适',id:'c'}],{year:2019,name:'2019款舒适'}).id,'c');
  assert.throws(()=>buildQuoteParams({id:'1',seriesId:'2'},{mileage:0},'3'));
  assert.equal(normalizeQuote({priceBegin:8,priceEnd:9}).prices.good.low,0.0008);
  const s=pageCall('quote',{carId:1});assert.ok(!s.includes('buildClue'));assert.ok(!s.includes('che300'));assert.throws(()=>pageCall('sell-lead'));
});

test('纯数字尾标和数字字母组合累计计分，不被同名配置盖过，适用于不同品牌',()=>{
  for(const [name,right,wrong] of [
    ['2023款 雷克萨斯NX(进口) 260 前驱 创驰版','2023款 雷克萨斯NX 260 前驱 创驰版','2023款 雷克萨斯NX 350h 前驱 创驰版'],
    ['2020款 奔驰C级 C 200 L 时尚版','2020款 奔驰C级 C200L 时尚版','2020款 奔驰C级 C180L 时尚版'],
    ['2024款 奥迪A6L 40 TFSI 豪华动感','2024款 奥迪A6L 40 TFSI 豪华动感','2024款 奥迪A6L 45 TFSI 豪华动感']
  ]){
    assert.equal(chooseTrim([{id:'wrong',year:2023,name:wrong},{id:'right',year:2023,name:right}],{year:2023,name}).id,'right');
  }
});

test('映射规则升级后复核旧缓存，错车记录留审计并撤销错误学习样本',async()=>{
  const f=fixture();try{
    const key='guazi:dealer:20:20:1231162:2019-01:6',removed=[];
    f.store.saveQuote(key,{provider:'guazi',fetchedAt:1,providerModel:{id:'wrong',name:'错误款式'},prices:{good:{low:3,high:4}}});
    f.service.invalidateSamples=keys=>removed.push(...keys);
    const r=await f.service.quote(f.input);assert.equal(r.cached,false);assert.equal(r.providerModel.id,'190436');
    assert.deepEqual(removed,[key+':1']);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM provider_quote_audit').get().n,1);
    assert.equal(JSON.parse(f.store.db.prepare('SELECT payload FROM provider_quote_audit').get().payload).providerModel.id,'wrong');
  }finally{f.store.db.close();}
});

test('个人价保留但不作车商缓存，车商旧价不限时、年月格式归一，坏价格不命中',async()=>{
  const f=fixture();try{
    const oldKey='guazi:private:20:20:1231162:2019-01:6';
    f.store.saveQuote(oldKey,{provider:'guazi',modelRuleVersion:3,fetchedAt:1,quoteBasis:'private',prices:{good:{low:8,high:9}}});
    assert.equal(f.service.getCached(f.input),null);
    const online=await f.service.quote(f.input);assert.equal(online.cached,false);assert.equal(online.quoteBasis,'dealer');
    assert.equal(f.store.getQuote(oldKey).prices.good.low,8);
    const key='guazi:dealer:20:20:1231162:2019-01:6',saved=f.store.getQuote(key);saved.fetchedAt=1;f.store.saveQuote(key,saved);
    const n=f.trace.length;f.service.call=async()=>{throw Error('缓存命中不应联网');};
    for(const registration of ['2019-1','2019-01']){
      const cached=f.service.getCached({...f.input,registration});assert.equal(cached.cached,true);assert.equal(cached.fetchedAt,1);
      assert.equal((await f.service.quote({...f.input,registration})).prices.good.low,6);
    }
    assert.equal(f.trace.length,n);
    assert.equal(f.service.getCached({...f.input,mileage:7}),null);
    saved.prices.good.low=0;f.store.saveQuote(key,saved);assert.equal(f.service.getCached(f.input),null);
  }finally{f.store.db.close();}
});

test('统一池与实际瓜子服务联测：未命中请求并保存，切换车300或全部退出后仍复用同条件瓜子车商价',async()=>{
  const f=fixture();try{
    const accounts=[{provider:'guazi',id:'g',status:'authenticated'},{provider:'che300',id:'c',status:'authenticated'}];
    let networkQuotes=0,activations=0;
    const pool=new QuoteAccountPool({store:f.store,list:()=>accounts,activate:()=>activations++,count:()=>networkQuotes,
      cache:(provider,input)=>provider==='guazi'?f.service.getCached(input):null,
      request:async(a,input)=>{assert.equal(a.provider,'guazi');networkQuotes++;return f.service.quote(input);}});
    pool.select('guazi','g');
    const first=await pool.run(f.input);assert.equal(first.cached,false);assert.equal(first.prices.good.low,6);
    assert.equal(f.service.getCached(f.input).prices.good.low,6);assert.equal(f.learned.length,1);
    pool.select('che300','c');const before=activations,calls=f.trace.length;
    for(const a of accounts)a.status='expired';
    for(let i=0;i<3;i++){
      const again=await pool.run(f.input);assert.equal(again.cached,true);assert.equal(again.provider,'guazi');assert.equal(again.prices.good.low,6);
    }
    assert.equal(activations,before);assert.equal(networkQuotes,1);assert.equal(f.trace.length,calls);assert.equal(f.learned.length,1);
    assert.equal((await pool.run({...f.input,mileage:7})).code,'AUTH_REQUIRED');
  }finally{f.store.db.close();}
});

test('厂家前缀不把国产车挤成进口，级字和完整品牌别称统一规范化',()=>{
  assert.equal(matchingName([{id:'import',name:'大众CC(进口)'},{id:'domestic',name:'一汽-大众CC'}],'大众CC',['大众','大众']).id,'domestic');
  assert.equal(matchingName([{id:'import',name:'大众CC(进口)'},{id:'domestic',name:'一汽-大众CC'}],'大众CC(进口)',['大众','大众']).id,'import');
  assert.equal(matchingName([{id:'cls',name:'奔驰CLS'}],'奔驰CLS级(进口)',['奔驰','奔驰']).id,'cls');
  assert.equal(matchingName([{id:'d90',name:'上汽大通MAXUS D90'}],'大通D90',['上汽MAXUS','上汽大通MAXUS']).id,'d90');
  for(const [source,target,brands] of [
    ['幻速S3','北汽幻速S3',['北汽幻速']],['本田CR-V[思威]','本田CR-V',['本田']],
    ['逸动[致尚]','逸动',['长安']],['名爵6[MG6]','MG6',['名爵','MG']]
  ])assert.equal(matchingName([{id:'right',name:target}],source,brands,{partial:false}).id,'right');
  assert.equal(matchingName([{id:'wrong',name:'宝马X1新能源'}],'宝马X1',['宝马'],{partial:false}),undefined);
  assert.equal(matchingName([{id:'wrong',name:'北京'}],'长安'),undefined);
  for(const items of [[{id:'foreign',name:'Passat'},{id:'domestic',name:'帕萨特'}],[{id:'domestic',name:'帕萨特'},{id:'foreign',name:'Passat'}]]){
    assert.equal(matchingName(items,'帕萨特[Passat]','大众').id,'domestic');
    assert.equal(matchingName(items,'PASSAT(进口)[帕萨特]','大众').id,'foreign');
  }
});

test('v3车商缓存目录车系不变时纯本地升级，车系已改正时不复用原错配缓存',async()=>{
  const f=fixture();try{
    const first=await f.service.quote(f.input),key='guazi:dealer:20:20:1231162:2019-01:6';
    f.store.saveQuote(key,{...first,modelRuleVersion:3,fetchedAt:1});
    f.service.call=async()=>{throw Error('已验证同车系旧价不应重新联网');};
    const cached=f.service.getCached(f.input);assert.equal(cached.cached,true);assert.equal(cached.fetchedAt,1);assert.equal(cached.modelRuleVersion,4);
    f.store.saveQuote(key,{...first,modelRuleVersion:3,providerModel:{...first.providerModel,seriesId:'wrong'}});
    assert.equal(f.service.getCached(f.input),null);
  }finally{f.store.db.close();}
});

test('已下载瓜子目录图进入共同本地车系，缓存缺图可补用共享图而不重新请求价格',async()=>{
  const f=fixture();try{
    await f.service.resolve(f.input);
    const photo={imageUrl:'https://image-pub.guazistatic.com/shared.png',imageData:'data:image/png;base64,Zml4dHVyZQ=='};
    f.service.photos={get:id=>String(id)==='2711'?photo:null,ensure:async()=>{throw Error('已有共同车图不应再次下载');}};
    assert.equal(f.service.indexKnownPhotos(),1);
    const result=await f.service.quote(f.input);assert.equal(result.vehicle.imageData,photo.imageData);
    const before=f.trace.length,cached=f.service.getCached(f.input);
    assert.equal(cached.vehicle.imageData,photo.imageData);assert.equal(f.trace.length,before);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM vehicle_photos').get().n,1);
    assert.equal(f.store.getSharedVehiclePhoto({category:'passenger',brandId:'40',seriesId:'388'}).imageData,photo.imageData);
  }finally{f.store.db.close();}
});

test('同年同尾标同配置未说明改款限量时优先普通款，不因目录顺序拿特别版',()=>{
  const result=chooseTrim([
    {id:'special',year:2022,name:'2022款 奔驰GLC 改款 GLC 300 L 4MATIC 动感型臻藏版'},
    {id:'regular',year:2022,name:'2022款 奔驰GLC GLC 300 L 4MATIC 动感型'}
  ],{year:2022,name:'2022款 奔驰GLC级 GLC 300 L 4MATIC 动感型'});
  assert.equal(result.id,'regular');
});
