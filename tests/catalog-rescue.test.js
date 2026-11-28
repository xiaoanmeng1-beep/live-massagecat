'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser}=require('../live-parser');
const {DataStore}=require('../data-store');
const today=()=>new Date('2026-11-26T12:00:00+08:00');
test('中文厂牌+完整数字：省去整个字母段仍送入车型评分，保留真实年月和里程',()=>{
  const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  try{
    const parse=makeParser(db,{today}), read=text=>parse({text});
    const literal=read('15年北京现代ix25');
    for(const text of ['15年北京现代25','15年现代 25','10万公里，北京现代25-15年的']){
      const r=read(text);
      assert.ok(r.ok,text+': '+r.reason);
      assert.equal(r.job.seriesName,'北京现代ix25');
      assert.deepEqual(r.job.input,literal.job.input);
      assert.match(r.job.car,/2015款/);
      assert.ok(r.matchEvidence.model>=4);
      assert.equal(r.job.city,'广州'); // 北京是厂牌的一部分，不是上牌地。
    }
    const configured=read('15年北京现代25 2.0L 四驱 11万公里');
    assert.match(configured.job.car,/北京现代ix25 2\.0L .*四驱/);
    assert.equal(configured.job.input.mileage,11);
    for(const [a,b] of [['18年现代35 6万公里','18年北京现代ix35 6万公里'],
      ['19年长安75 8万公里','19年长安CS75 8万公里']]){
      const r=read(a);assert.ok(r.ok);assert.deepEqual(r.job.input,read(b).job.input);
    }
    for(const text of ['15年北京现代25万公里','15年北京现代25万元','北京现代25年上牌',
      '15年北京现代25-28万','15年北京现代2 5',
      '15年北京现代zz25','15年北京现代25和本田思域']){
      assert.ok(!read(text).ok,text);
    }
    // 250 is itself an existing catalog badge. Never truncate it to 25.
    assert.match(read('15年北京现代250').job.car,/XG 250/);
  }finally{db.close();}
});
test('同品牌两个字母段省略后重名：以款式证据区分，不按目录先后猜',()=>{
  const store=new DataStore(':memory:');
  try{
    store.replaceBrands('passenger',[{id:'1',name:'岚川',initial:'L'}]);
    const families=[['1','江城岚川AB28','手动舒适型'],['2','江城岚川XY28','自动旗舰型']];
    store.replaceSeries('passenger','1',families.map(([id,name])=>({id,name})));
    for(const [id,family,trim] of families)store.replaceModels('passenger','1',id,[{
      id:'9'+id,year:'2020',name:'2020款 '+family+' '+trim,minRegistrationYear:'2020',maxRegistrationYear:'2026'}]);
    store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    const p=makeParser(store.db,{today});
    assert.equal(p({text:'20年江城岚川28 8万公里'}).code,'AMBIGUOUS_SERIES');
    assert.equal(p({text:'20年江城岚川28 自动旗舰型 8万公里'}).job?.input.modelId,'92');
    assert.equal(p({text:'20年江城岚川28 手动舒适型 8万公里'}).job?.input.modelId,'91');
  }finally{store.db.close();}
});
test('历史漏单：验证车系、可以核实的配置、上牌年月与里程，而非只看 ok',()=>{
  const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  try{
    const p=makeParser(db,{today});
    for(const [text,vehicle,date,distance] of [
      ['17年3.0T奥迪A7白色前嘴一套到水箱框架。',/2017款 奥迪A7\(进口\) 50 TFSI/,'2017-01',10],
      ['20款ES300，6万公里',/2020款 雷克萨斯ES\(进口\) 300h/,'2020-01',6],
      ['19年长安35puls自动高配三万公里，能给我多少',/2019款 长安CS35 PLUS.*(?:DCT|自动)/,'2019-01',3],
      ['19年长安75puls自动，9万公里',/长安CS75 PLUS.*自动/,'2019-01',9],
      ['18年宝马X5。140000km。',/2018款 宝马X5\(进口\)/,'2018-01',14],
      ['18年宝马叉5。140000km。',/2018款 宝马X5\(进口\)/,'2018-01',14],
      ['18款吉利薄越公里数8万公厘，多少饯',/2018款 博越 /,'2018-01',8],
      ['2018款凌度280豪华版，18万公里，维修记录7万',/2018款 凌渡 280TSI .*豪华/,'2018-01',18],
      ['16年名图1.8，前嘴一套，出险9000，13万公里。',/2016款 MISTRA名图 1\.8L/,'2016-01',13],
      ['20年的黑色迈锐宝2.0T，5万公里，过三方，多少钱入手比较合适？',/2020款 迈锐宝XL .*550T/,'2020-01',5],
      ['23年5万公里糯玉米210慢充',/长安Lumin 210km/,'2023-01',5],
      ['23年5万公里长安Lumin续航210公里',/长安Lumin 210km/,'2023-01',5]
    ]){
      const r=p({text});assert.ok(r.ok,text+': '+r.reason);
      assert.match(r.job.car,vehicle);assert.equal(r.job.input.registration,date,text);assert.equal(r.job.input.mileage,distance,text);
    }
    for(const text of ['糯玉米多少钱一斤','长安35万公里','ES301 20款6万公里','20款ES300d 6万公里',
      '凌度多少钱','18年宝马叉5和宝马叉3 6万公里','20年奔驰和雷克萨斯各多少钱','25年吉利银河8万公里'])
      assert.notEqual(p({text}).ok,true,text);
  }finally{db.close();}
});

test('用临时目录验证同音字、系列省写、大小写和同品牌多个配置片段的累计打分',()=>{
  const store=new DataStore(':memory:');
  try{
    store.replaceBrands('passenger',[{id:'1',name:'极川',initial:'J'}]);
    store.replaceSeries('passenger','1',[['11','明渡'],['12','极川AX86 PLUS'],['13','晴川'],['14','山河']].map(([id,name])=>({id,name})));
    for(const [id,name] of [['11','明渡 280TSI 豪华版'],['12','极川AX86 PLUS 自动舒适型'],
      ['13','晴川 1250km 探索版'],['14','山河 250km 探索版']]){
      store.replaceModels('passenger','1',id,[{id:'9'+id,year:'2025',name:'2025款 '+name,minRegistrationYear:'2025',maxRegistrationYear:'2026',catalogPrice:'15万'}]);
    }
    store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    const p=makeParser(store.db,{today}),match=(text,id)=>{
      const r=p({text});assert.equal(r.job?.input.modelId,id,text+': '+r.reason);return r;
    };
    match('25款明度280豪华版7万公里','911');
    match('25年极川86puls自动3万公里','912');
    const more=match('25年的极川探索家250，26年1月上牌4万公里','914');
    assert.equal(more.job.input.registration,'2026-01');
    assert.doesNotMatch(more.job.reason,/按年款和目录顺序近似/);
    assert.equal(more.matchEvidence.model,5); // 探索 + 250, never 1250 or the title year.
    assert.equal(p({text:'25年极川86万元'}).ok,false);
    assert.equal(p({text:'25年明兔280豪华版7万公里'}).ok,false);
  } finally {store.db.close();}
});
