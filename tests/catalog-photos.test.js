'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DataStore}=require('../data-store');const {CatalogPhotos,allowedPhotoUrl,localVehiclePhoto,quoteModelId}=require('../vehicle-photos');
const url='https://image-pub.guazistatic.com/car.png';
test('同一车图跨平台、多次报价只存一份图片，不改变返回对象，不重复塞入报价JSON',()=>{
  const store=new DataStore(':memory:');try{
    const quote={fetchedAt:1,vehicle:{imageUrl:url,imageData:'data:image/png;base64,Zml4dHVyZQ=='},prices:{good:{low:1,high:2}}};
    for(const key of ['20:20:100:2020-1:6','20:20:100:2020-1:7','guazi:dealer:20:20:100:2020-01:6']){
      store.saveQuote(key,quote);assert.equal(store.getQuote(key).vehicle.imageData,'');
      assert.equal(store.getQuote(key).vehicle.imageUrl,url);
    }
    assert.notEqual(quote.vehicle.imageData,'');assert.equal(store.db.prepare('SELECT count(*) n FROM vehicle_photos').get().n,1);
  }finally{store.db.close();}
});
test('共享车图按完整本地品牌车系身份复用，不区分渠道，不被最新缺图记录盖住',()=>{
  const store=new DataStore(':memory:');try{
    const a={category:'passenger',brandId:'1',seriesId:'10',id:'100'},b={...a,id:'101'};
    const image={imageUrl:url,imageData:'data:image/png;base64,Zml4dHVyZQ=='};
    store.linkSharedVehiclePhoto(a,image,1);
    store.linkSharedVehiclePhoto(b,{imageUrl:'car-silhouette.svg',imageData:''},2);
    assert.deepEqual(localVehiclePhoto(store,b),image);
    assert.deepEqual(localVehiclePhoto(store,a,{imageUrl:'car-silhouette.svg'}),image);
    for(const other of [{...b,brandId:'2'},{...b,seriesId:'11'},{...b,category:'energy'}])
      assert.equal(localVehiclePhoto(store,other).imageUrl,'car-silhouette.svg');
    assert.equal(store.db.prepare('SELECT count(*) n FROM vehicle_photos').get().n,1);
  }finally{store.db.close();}
});
test('旧报价回填只读严格的车型槽位，平台ID相同不代表同车型；只有实际图数据才命中',()=>{
  const store=new DataStore(':memory:');try{
    store.replaceBrands('passenger',[{id:'1',name:'品牌甲',initial:'A'}]);store.replaceSeries('passenger','1',[{id:'10',name:'车系甲'}]);
    store.replaceModels('passenger','1','10',[{id:'100',name:'2020款 车系甲',year:'2020',minRegistrationYear:'2020',maxRegistrationYear:'2026'}]);
    const image={imageUrl:url,imageData:'data:image/png;base64,Zml4dHVyZQ=='};store.saveVehiclePhoto(image);
    store.saveQuote('20:20:100:2020-1:6',{fetchedAt:1,vehicle:image});
    store.saveQuote('20:20:100:2020-1:7',{fetchedAt:2,vehicle:{imageUrl:'car-silhouette.svg'}});
    assert.deepEqual(localVehiclePhoto(store,{category:'passenger',brandId:'1',seriesId:'10',id:'100'}),image);
    assert.equal(quoteModelId('20:20:100:2020-1:6'),'100');
    assert.equal(quoteModelId('guazi:dealer:20:100:777:2020-01:6'),'777');
    assert.equal(quoteModelId('other:100:20:20:777:2020-01:6'),'');
    const pending={...image,imageUrl:'https://image-pub.guazistatic.com/pending.png',imageData:''};
    store.linkSharedVehiclePhoto({category:'passenger',brandId:'1',seriesId:'11',id:'101'},pending,3);
    assert.equal(store.getSharedVehiclePhoto({category:'passenger',brandId:'1',seriesId:'11',id:'101'}),null);
  }finally{store.db.close();}
});
test('官方车系图本地存一次，读取不再联网，同URL并发合并',async()=>{
  const store=new DataStore(':memory:');let fetched=0;
  const photos=new CatalogPhotos({store,fetch:async()=>{fetched++;return {ok:true,headers:new Map([['content-type','image/png']]),body:[Buffer.from('fixture')]};},decode:b=>b});
  try{
    const [a,b]=await Promise.all([photos.ensure('1',url),photos.ensure('1',url)]);
    assert.equal(fetched,1);assert.equal(a.imageData,b.imageData);assert.equal(photos.get('1').imageData,a.imageData);
    await photos.ensure('1',url);assert.equal(fetched,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM vehicle_photos').get().n,1);
  }finally{store.db.close();}
});
test('图片失败不影响报价，不访问任意主机，不接受空内容和假图片',async()=>{
  const store=new DataStore(':memory:');let fetched=0;
  const photos=new CatalogPhotos({store,fetch:async()=>{fetched++;return {ok:true,headers:new Map([['content-type','text/html']]),body:[Buffer.from('not image')]};},decode:b=>b});
  try{
    for(const u of ['http://image-pub.guazistatic.com/x','https://localhost/x','https://image-pub.guazistatic.com.evil/x','https://user:pass@image-pub.guazistatic.com/x'])assert.equal(allowedPhotoUrl(u),false);
    assert.equal(await photos.ensure('1','https://localhost/x'),null);assert.equal(fetched,0);
    assert.equal(await photos.ensure('1',url),null);assert.equal(photos.get('1'),null);
  }finally{store.db.close();}
});
