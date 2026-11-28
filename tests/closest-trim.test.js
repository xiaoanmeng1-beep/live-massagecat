'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {makeParser,QuoteBoard,attemptLiveMatch}=require('../live-board');
const {DataStore}=require('../data-store');
const today=()=>new Date(2026,10,28,12);
const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const parse=makeParser(db,{today});
after(()=>db.close());
for(const [text,id,registration,mileage] of [
  ['23帕萨特混动精英版10.5公里前嘴半套气囊没弹两手户能收多少老板','1833322','2023-01',10.5],
  ['23年帕萨特混动精英版，10.5万公里','1833322','2023-01',10.5],
  ['23年帕萨特混动精英旗舰版，10.5万公里','1833322','2023-01',10.5],
  ['22年迈腾混动豪华旗舰 8万公里','1801727','2022-01',8],
  ['21年途观L混动旗舰精英 8万公里','1610634','2021-01',8],
  ['24年4月上牌A6L，豪华动感45，23000公里','1872427','2024-04',2.3],
  ['23年宝马X1旗舰七座 9万公里','1850539','2023-01',9],
  ['领克03劲pro2.0的大概多钱','1833916','2023-01',10],
  ['22年，迈腾330豪华，30周年，6.5万公里，全车原版原漆。','1773275','2022-01',6.5],
  ['25年朗逸五百万黑色 铁件原版原漆 更换大灯一个保险杠 7000公里','1869098','2025-01',0.7],
  ['16年k4舒适版1.8，10万公里，还能值多少','28300','2016-01',10],
  ['19年混动crv，9.3万公里，换过副驾门，车身有两处喷漆。全程4s店保养','1160468','2019-01',9.3],
  ['23年帕萨特混动精英或宝马X1 5万公里',null],
  ['2022款GLC300D动感10万公里',null],
  ['2.0T精英豪华旗舰 6万公里',null],
]){
  test('按配置匹配后验证实际入队参数：'+text,async()=>{
    const sent=[],board=new QuoteBoard({holdMs:0,quote:async input=>{sent.push(input);return {ok:true,prices:{good:{low:1,high:2}}}}});
    const result=attemptLiveMatch(parse,board,{text,id:777,room:'room',name:'测试'});
    await new Promise(setImmediate);
    assert.equal(result.ok,!!id,result.reason);
    assert.equal(sent.length,id?1:0);
    if(id){assert.deepEqual(sent[0],{modelId:id,registration,mileage,provinceId:'20',cityId:'20'});assert.equal(board.snapshot().history[0].input.modelId,id);}
  });
}
test('陌生车系：配置冲突时按每个目录款式的字符数，不靠品牌白名单或目录第一条',()=>{
  const s=new DataStore(':memory:');
  try{
    s.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    s.replaceBrands('passenger',[{id:'b',name:'极川',initial:'J'}]);
    s.replaceSeries('passenger','b',[{id:'s',name:'云航'}]);
    s.replaceModels('passenger','b','s',[
      ['101','自动 豪华型'],['102','自动 星河尊享版'],['103','手动 星河扬帆版']
    ].map(([id,trim])=>({id,year:'2023',name:'2023款 云航 '+trim,minRegistrationYear:'2023',maxRegistrationYear:'2026'})));
    const p=makeParser(s.db,{today});
    const r=p({text:'23年极川云航 自动 星河尊享 旗舰 七万公里'});
    assert.equal(r.job?.input.modelId,'102',JSON.stringify(r));assert.equal(r.matchPath,'character-primary');
    const partial=p({text:'23年极川云航 手动 星河扬 旗舰 七万公里'});
    assert.equal(partial.job?.input.modelId,'103',JSON.stringify(partial));
  }finally{s.db.close();}
});

test('已有能满足识别出的配置词的款式，也必须与命中更多字符的款式和同名车系比较',async()=>{
  const s=new DataStore(':memory:');
  try{
    s.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    const setup=(b,series,list)=>s.replaceModels('passenger',b,series,list.map(([id,trim])=>({
      id,name:'2023款 云海 '+trim,year:'2023',minRegistrationYear:'2023',maxRegistrationYear:'2026'
    })));
    s.replaceBrands('passenger',[{id:'a',name:'极川',initial:'J'},{id:'b',name:'飞岳',initial:'F'}]);
    s.replaceSeries('passenger','a',[{id:'s1',name:'云海'}]);
    s.replaceSeries('passenger','b',[{id:'s2',name:'云海'}]);
    setup('a','s1',[['101','旗舰型'],['102','星河扬帆版']]);
    setup('b','s2',[['201','星河扬名远航版']]);
    const p=makeParser(s.db,{today});
    for(const [text,id] of [
      ['23年极川云海 旗舰 星河扬 5万公里','102'],
      ['23年云海 旗舰 星河扬名 5万公里','201'],
      ['23年极川云海 星河扬名 旗舰 5万公里','102'],
      ['23年极川云海 旗舰 5万公里','101'],
    ]){
      const calls=[],board=new QuoteBoard({holdMs:0,quote:async input=>{calls.push(input);return {ok:true,prices:{good:{low:1,high:2}}};}});
      const r=attemptLiveMatch(p,board,{text,id:1,name:'样例'});
      await new Promise(setImmediate);
      assert.equal(r.ok,true,r.reason);assert.deepEqual(calls.map(c=>c.modelId),[id],text);
      assert.equal(board.snapshot().history[0].input.modelId,id);
    }
  }finally{s.db.close();}
});
