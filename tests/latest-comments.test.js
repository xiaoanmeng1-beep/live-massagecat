'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser,extractMileage}=require('../live-parser');
const {DataStore}=require('../data-store');
const {QuoteBoard}=require('../live-board');
const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const parse=makeParser(db,{today:()=>new Date('2026-11-26T12:00:00+08:00')});

// Catalog-verified expected IDs, not a copy of parser output. These are local
// parsing regressions; the quote callback below is a stub, not a real API.
const cases=[
  ['现代ix35-13年13万公里2.0','16915','2013-01',13],
  ['17年兰德酷路泽，4.0美规8座最高配，原版原漆，13万多公里，','1693645','2017-01',13],
  ['2025年奔驰GLB1.3T5坐跑了2W','1925067','2025-01',2],
  ['25年CRV风尚版 原版原漆 三万公里 黑色','1414996','2025-01',3],
  ['24年星瑞L混动天宫版 3万来公里','1878096','2024-01',3],
  ['现代ix35-13年13万公里','16915','2013-01',13],
  ['斯柯达柯洛克19款。35,000公里。','1205423','2019-01',3.5],
  ['18款福克斯RS2.3T赛道版7.5万公里还值多少','1149745','2018-01',7.5],
  ['13年1上牌，手动赛拉图，黑色，1块补漆，其他原漆，15万公里，费用马上到了，多少收','14069','2013-01',15],
  ['21年宝马X1四驱尊享。7万公里','1536068','2021-01',7],
  ['14年的皇冠 2.5的11万公里多少钱','25712','2014-01',11],
  ['22年奔驰GLB220，2.0T动感五座，4万多公里','1818411','2022-01',4],
  ['16年帕沙特330尊享版九万公里','29852','2016-01',9],
  ['23年12月上牌GS4，高配五万多公里，原版原漆，多少钱','1849279','2023-12',5],
  ['22年is300 6万公里带两地车牌卖得多少？','1132518','2022-01',6],
  ['22年530尊享3.5万公里','1772679','2022-01',3.5],
  ['15 年 9 月份 起亚 k4 18w 公里 一手车 年检马上到期了 强险明年 2 月份','28302','2015-09',18],
  ['19年2.3t黑色bj40，7.2万公里，有改装','1234458','2019-01',7.2],
  ['20年汉兰达10万零俩千公里','1610561','2020-01',10],
  ['19年斯柯达明锐1.4万公里','1210744','2019-01',1.4]
];

test('11月26日整批18条未入队评论及汉兰达/明锐：核对ID、年月、里程',()=>{
  for(const [text,id,registration,mileage] of cases){
    const r=parse({text});assert.equal(r.ok,true,text+': '+r.reason);
    assert.deepEqual(r.job.input,{modelId:id,registration,mileage,provinceId:'20',cityId:'20'},text);
  }
});

test('日期只取上牌上下文；保险年检不抢月份，真实冲突仍提示',()=>{
  for(const text of ['15年9月起亚K4，强险明年2月','15年9月起亚K4，年检明年3月保险2月到期',
    '保险到2027年2月，2015年9月上牌起亚K4','15年9月上牌起亚K4 保险明年2月到期',
    '15年9月份起亚K4 18万公里，2027年2月保险到期']){
    assert.equal(parse({text}).job?.input.registration,'2015-09',text);
  }
  assert.equal(parse({text:'13年1上牌赛拉图15万公里'}).job?.input.registration,'2013-01');
  assert.equal(parse({text:'奔驰e260 17上下吗'}).job?.input.registration,'2026-01');
  for(const text of ['15年9月起亚K4，16年2月上牌','15年9月起亚K4，10月上牌','15年15月起亚K4'])
    assert.equal(parse({text}).code,'DATE',text);
});

test('混写里程不能只截取尾数；口语余量按用户约定保留万位',()=>{
  for(const [text,expected] of [['10万零俩千公里',10],['20万零俩千公里',20],['10万零两千公里',10.2],
    ['8万4千公里',8.4],['7万五千公里',7.5],['一万六公里',1.6],['十二万五公里',12.5],
    ['8万3000多公里',8.3],['五万多公里',5],['3万来公里',3]])assert.equal(extractMileage(text).value,expected,text);
  assert.equal(extractMileage('18万公里，维修记录7万').value,18);
  assert.equal(extractMileage('里程11万85',{fallbackOnInvalid:true}).value,10);
});

test('简称和错字是目录驱动，不串车；国产/进口与车牌价格数字仍有边界',()=>{
  assert.match(parse({text:'19传奇GS8，8万公里，'}).job?.car,/2019款 传祺GS8/);
  assert.match(parse({text:'23年5月l9黑外橘内6万公里'}).job?.car,/理想L9/);
  for(const text of ['起亚K4和GS4 15年18万公里','22年300豪华6.3w公里'])
    assert.equal(parse({text}).code,'AMBIGUOUS_SERIES',text);
  for(const text of ['530元修车贵不贵','保险530，明年再买','22年530万元','只有四驱尊享'])assert.notEqual(parse({text}).ok,true,text);
  assert.equal(parse({text:'GS9 23年5万公里'}).ok,false); // do not change model digits
  assert.equal(parse({text:'2019款途岳1.5T 7万公里'}).ok,false); // known engine conflict
});

test('新建目录也适用厂商前缀、四驱别名、缺失座位/排量、邻年回退及同音判别',()=>{
  const s=new DataStore(':memory:');try{
    s.replaceBrands('passenger',[{id:'1',name:'试验',initial:'S'},{id:'2',name:'远航星际',initial:'Y'}]);
    s.replaceSeries('passenger','1',[{id:'11',name:'北方试验ZX8'},{id:'12',name:'星珞者'},{id:'13',name:'星米者'}]);
    s.replaceSeries('passenger','2',[{id:'21',name:'星际VX6'}]);
    const model=(id,name,year='2021',lo='2020',hi='2022')=>({id,name,year,minRegistrationYear:lo,maxRegistrationYear:hi});
    s.replaceModels('passenger','1','11',[
      model('111','2021款 北方试验ZX8 Z 260 xDrive 尊荣版'),
      model('112','2021款 北方试验ZX8 Z 260 sDrive 尊荣版'),
      model('113','2025款 北方试验ZX8 Z 260 xDrive 尊荣版','2025','2024','2026')]);
    s.replaceModels('passenger','1','12',[model('121','2021款 星珞者 1.5T 豪华版')]);
    s.replaceModels('passenger','1','13',[model('131','2021款 星米者 1.5T 豪华版')]);
    s.replaceModels('passenger','2','21',[model('211','2021款 星际VX6 1.5TD 油混 天宫版')]);
    s.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    const p=makeParser(s.db,{today:()=>new Date('2026-11-26T12:00:00+08:00')});
    for(const text of ['23年试验ZX8四驱尊荣五座2.0T 8万公里','23年ZX8四驱尊荣2.0T 8万公里']){
      const r=p({text});assert.equal(r.job?.input.modelId,'111',text+': '+r.reason);
      assert.equal(r.job.input.registration,'2023-01'); // not the impossible 2025 model
    }
    assert.equal(p({text:'21年VX6混动天宫版3万公里'}).job?.input.modelId,'211');
    assert.equal(p({text:'试验星洛者21款 1.5T 8万公里'}).job?.input.modelId,'121');
    assert.equal(p({text:'21年星珞者1.8T 8万公里'}).ok,false);
    assert.equal(p({text:'19年试验ZX8尊荣2.0T 8万公里'}).ok,false); // before existence
    assert.equal(p({text:'2030年试验ZX8四驱2.0T 8万公里'}).ok,false);
  }finally{s.db.close();}
});

test('评论爆发超80条不静默丢弃，溢出按FIFO继续；重新连接不补报历史',async()=>{
  const {diffNew}=await import('../douyin-bridge-service.mjs');
  const rows=Array.from({length:161},(_,i)=>({key:'id:'+i,line:'车友'+i+'：19年斯柯达明锐1.4万公里'}));
  const seen=new Set(),all=[];
  all.push(...diffNew(rows,seen));
  all.push(...diffNew([],seen)); // DOM already disappeared: backlog must survive
  all.push(...diffNew([],seen));
  assert.deepEqual(all,rows);assert.deepEqual(diffNew(rows,seen),[]);
  const reconnected=new Set();assert.equal(diffNew(rows,reconnected,Infinity).length,161);
  assert.deepEqual(diffNew(rows,reconnected),[]);
  const fresh={key:'id:new',line:'新车友：19年斯柯达明锐1.4万公里'};
  assert.deepEqual(diffNew([...rows,fresh],reconnected),[fresh]);
});

test('18条整批桥接->解析->队列->报价回调->最新报价与前四张卡片：有序、无重复、保留昵称',async()=>{
  const {diffNew,parseChatLine}=await import('../douyin-bridge-service.mjs');
  const calls=[],board=new QuoteBoard({holdMs:0,quote:async input=>{
    calls.push(input);return {ok:true,prices:{good:{low:2,high:3}}};
  },pause:async()=>{}}),seen=new Set();
  const rows=cases.slice(0,18).map(([text],i)=>({key:'latest:'+i,line:'车友'+i+'：'+text}));
  for(let tick=0;tick<2;tick++)for(const row of diffNew(rows,seen)){
    const event=parseChatLine(row.line),r=parse({...event,id:row.key,eventId:row.key});
    assert.equal(event.kind,'comment');assert.equal(r.ok,true,row.line);board.add(r.job);
  }
  while(board.busy)await new Promise(setImmediate);
  assert.deepEqual(calls.map(x=>x.modelId),cases.slice(0,18).map(x=>x[1]));
  assert.equal(board.snapshot().history.length,5);
  assert.equal(board.snapshot().history[0].name,'车友17');
});
