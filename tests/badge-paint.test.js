'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {DataStore}=require('../data-store');
const {makeParser,QuoteBoard,attemptLiveMatch}=require('../live-board');
const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const today=()=>new Date(2026,10,27),parse=makeParser(db,{today});
const model=db.prepare('select distinct b.name make,m.name from models m join brands b on b.id=m.brand_id and b.category=m.category where m.id=?');
after(()=>db.close());
const g63=/^2024款 奔驰G级AMG.*\bG\s*63\b/i;
const cases=[
 ['24年AMG，G63，熊猫白，二万七千公里','奔驰',g63,2.7],
 ['24年G 63、AMG，冰川白，27000公里','奔驰',g63,2.7],
 ['24年 AMG G63，2.7万公里','奔驰',g63,2.7],
 ['24年amg,g63，颜色：熊猫白，2万公里','奔驰',g63,2],
 ['24年奔驰 G63 ，3万公里','奔驰',g63,3],
 ['21年C63，AMG，冰川白，6万公里','奔驰',/^2021款 奔驰C级AMG.*\bC\s*63\b/i,6],
 ['19年AMG，GT63，4万公里','奔驰',/AMG GT.*GT\s*63/i,4],
 ['24年宝马X3，熊猫白，2万公里','宝马',/宝马X3/,2],
 ['24年吉利熊猫mini，白色，2万公里','吉利',/熊猫mini/i,2],
 ['24年吉利熊猫 白色两万公里','吉利',/熊猫/i,2],
 ['24年熊猫白，2万公里',null],
 ['24年AMG，G630，熊猫白，二万七千公里',null],
 ['24年宝马 AMG，G63，4万公里',null],
 ['24年AMG G63 和吉利熊猫，2万公里',null],
 ['24年G63和吉利熊猫mini，两万公里',null],
 ['23年特斯拉Model Y 16万公里','特斯拉',/^2023款 Model Y /,16],
 // Historical wrong-brand admissions. Check the actual quoted ID's owner, not just ok.
 ['吉利ev350,,2018年的车，26万公里，目前营运，正准备过几天转非，几钱？','吉利帝豪',/^2018款 帝豪新能源 EV350/,26],
 ['吉利，EV350，2018年3万公里','吉利帝豪',/^2018款 帝豪新能源 EV350/,3],
 ['18年吉利EV 350，26万公里','吉利帝豪',/^2018款 帝豪新能源 EV350/,26],
 ['2010年宝马GT535i，25万公里','宝马',/^2010款 宝马5系GT.*535i/,25],
 ['2010年宝马 GT 535i，25万公里','宝马',/^2010款 宝马5系GT.*535i/,25],
 ['2010年宝马，GT535i，25万公里','宝马',/^2010款 宝马5系GT.*535i/,25],
 ['吉利EV350和北汽EV300，2018年',null],
 ['18年吉利EV399，26万公里',null],
 ['2010年宝马GT536i，25万公里',null],
 ['17年捷达1.6排量自动挡，80789公里，高配带定速巡航，带天窗多少钱','大众',/捷达.*1\.6L.*自动/,8.0789],
 ['24年AMG。G63，熊猫白，2万公里','奔驰',g63,2],
 ['24年AMG：G63，熊猫白，2万公里','奔驰',g63,2],
 ['24年AMG/G63，熊猫白，2万公里','奔驰',g63,2],
 ['24年G63 AMG，熊猫白内饰，2万公里','奔驰',g63,2],
 ['24年熊猫白的 AMG G63，二万七千公里','奔驰',g63,2.7],
 ['24年G63，车身是熊猫白，2万公里','奔驰',g63,2],
 ['24年AMG，G6300，熊猫白，2万公里',null],
 ['24年熊猫白内饰，2万公里',null],
 ['24年G63跟吉利熊猫mini，2万公里',null],
 ['24年G63或者吉利熊猫mini，2万公里',null],
 ['24年G63比吉利熊猫mini贵多少',null],
 ['20年有一台北京现代25 4万公里','现代',/北京现代ix25/,4],
 ['24年首付25万，宝马X3多少钱','宝马',/宝马X3/,10],
 ['24年路虎极光，白色，3万公里','路虎',/^2024款 揽胜极光 /,3],
 ['24年路虎极光插混 3万公里','路虎',/^2024款 揽胜极光新能源 .*P300e/,3],
 ['24年MINI COOPER，纯电，2万公里','MINI',/^2024款 电动MINI COOPER /,2],
 ['24年宝马X3，熊猫白不是熊猫mini，3万公里','宝马',/宝马X3/,3],
];
for(const [text,make,title,distance] of cases)test(text,async()=>{
 const calls=[];
 const board=new QuoteBoard({holdMs:0,quote:async i=>{calls.push(i);return {ok:true,prices:{good:{low:1,high:2}}};}});
 const r=attemptLiveMatch(parse,board,{text,id:1,room:'r',userId:'u',name:'观众'});
 await new Promise(setImmediate);
 assert.equal(r.ok,!!make,JSON.stringify(r));assert.equal(calls.length,make?1:0);
 const card=board.snapshot().history[0];
 if(!make)return assert.equal(card,undefined);
 const [entry]=model.all(calls[0].modelId);
 assert.equal(entry.make,make);assert.match(entry.name,title);assert.equal(card.car,entry.name);assert.equal(calls[0].mileage,distance);
});
test('其它品牌：目录中的独有系列标识 + 型号，不需写品牌名或添加白名单',()=>{
 const store=new DataStore(':memory:');
 try{
   store.replaceBrands('passenger',[{id:'b',name:'栖岚',initial:'Q'},{id:'c',name:'极川',initial:'J'}]);
   store.replaceSeries('passenger','b',[{id:'s',name:'云海VXR'}]);
   store.replaceSeries('passenger','c',[{id:'t',name:'熊猫'}]);
   for(const [brand,id,name] of [['b','s','云海VXR H 52 性能版'],['c','t','熊猫 H52 舒适版']])
     store.replaceModels('passenger',brand,id,[{id:brand==='b'?'100':'200',name:'2024款 '+name,year:'2024',minRegistrationYear:'2024',maxRegistrationYear:'2026'}]);
   store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
   const p=makeParser(store.db,{today});
   for(const text of ['24年VXR，H52，熊猫白，三万公里','24年H52，VXR，三万公里','24年VXRH52，三万公里','24年H52VXR，三万公里','24年VXR/H52，三万公里'])
     assert.equal(p({text}).job?.input.modelId,'100',text);
   assert.equal(p({text:'24年VXR，H53，熊猫白，三万公里'}).ok,false);
 }finally{store.db.close();}
});
