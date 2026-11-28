'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { makeParser, extractMileage } = require('../live-parser');
const { QuoteBoard } = require('../live-board');

const db = new DatabaseSync(require('node:path').resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const parse = makeParser(db,{ today:()=>new Date(2026,10,25) });
function match(text,id,date,mileage,city='20'){
  const r=parse({id:1,name:'测试观众',text});
  assert.ok(r.ok,r.reason||text);
  assert.deepEqual(r.job.input,{modelId:id,registration:date,mileage,provinceId:'20',cityId:city});
  assert.equal(r.job.name,'测试观众');
}
function ignored(text,code){ const r=parse({text});assert.equal(r.ok,false,text);assert.equal(r.code,code,r.reason); }

test('配置语义先锁定英朗 XT，再选目录写法的自动舒适型，不串到三厢 GT',()=>{
  match('主播， 13 年的别克英朗两厢 XT 1.6L 白色 手自一体，公里数 2.9 万，白色',
    '1000','2013-01',2.9);
  match('13年别克英朗XT 1.6L 自动 2.9万公里','1000','2013-01',2.9);
  match('13年别克英朗GT 1.6L 手自一体 2.9万公里','919','2013-01',2.9);
  assert.equal(parse({text:'13年别克英朗两厢GT 1.6L 2.9万公里'}).ok,false);
});

test('简称保留车系信息，动力不详的复判留在同车系和同年款',()=>{
  match('26年旅行者 1.5t 三万公里','1949156','2026-01',3);
  match('26年捷途旅行者 1.5t 三万公里','1949156','2026-01',3);
  match('26年广汽传祺ES9旅行者 三万公里','1870958','2026-01',3);
  ignored('26年广汽传祺ES9旅行者 1.5T 三万公里','NO_TRIM');
  ignored('宝马❌112年1月1号跑了157000公里','NO_SERIES');
  const retry=parse({text:'23年，速腾，1.2T，白色，3万公里'});
  assert.equal(retry.matchPath,'character-fallback');
  assert.match(retry.job.car,/2023款 速腾 200TSI/);
  ignored('2019款途岳1.5T 7万公里','NO_TRIM');
  const partial=parse({text:'25年的吉利银河探索家202 26年1月份上牌，跑了12,000公里。，现在还值多少钱？'});
  assert.match(partial.job?.car,/2025款 银河.*探索/);
  assert.equal(partial.job.input.registration,'2026-01');
  assert.equal(partial.job.input.mileage,1.2);
  assert.match(partial.job.reason,/多个车系.*近似/);
});

test('毛豆3关联 Model 3 并保留明确的新旧款与上牌月',()=>{
  assert.equal(parse({text:'23年4月老款毛豆3六万公里'}).job?.seriesName,'Model 3');
  match('23年4月老款毛豆3六万公里','1778099','2023-04',6);
  match('23年4月Model3六万公里','1778099','2023-04',6);
  match('23年11月焕新毛豆3六万公里','1867089','2023-11',6);
  match('23年11月旧款毛豆三6万公里','1778099','2023-11',6);
  ignored('23年4月焕新毛豆3六万公里','NO_YEAR_MATCH');
});

test('重名按款式和动力语义一起比字符，默认既不猜进口也不猜另一品牌',()=>{
  const text='24 年塞纳尊贵混动版，21500 公里，一手车';
  match(text,'1893356','2024-01',2.15);
  assert.deepEqual(parse({text}).matchEvidence,{brand:0,series:2,model:6,relevantChars:6});
  match('24年丰田赛那尊贵混动版，21500公里','1893356','2024-01',2.15);
  match('24年塞纳四驱尊贵混动2.15万公里','1893353','2024-01',2.15);
  match('24年进口塞纳尊贵混动版，21500公里','1891271','2024-01',2.15);
  ignored('塞纳','AMBIGUOUS_SERIES');
  ignored('丰田赛那和迈凯伦塞纳','AMBIGUOUS_SERIES');
  assert.match(parse({text:'迈凯伦塞纳'}).job?.car,/迈凯伦塞纳/);
});

test('目录生成别名时不把品牌直接映射到某个车系',()=>{
  ignored('奥迪14年的，14万公里','NO_SERIES');
  ignored('奥迪AUDI14年的，14万公里','NO_SERIES');
  match('奥迪E7X 14万公里','1983962','2026-01',14);
  match('17年11月份 9万公里 奥迪Q5','1132933','2017-11',9);
  match('17款天逸时尚版1.8 T，12万公里','1134031','2017-01',12);
  match('22年别克陆尊8万公里','1773874','2022-01',8);

  const local=new DatabaseSync(':memory:');
  try {
    local.exec(`
      CREATE TABLE metadata(updated_at);
      CREATE TABLE provinces(id,name);
      CREATE TABLE cities(province_id,id,name);
      CREATE TABLE brands(category,id,name);
      CREATE TABLE series(category,brand_id,id,name);
      CREATE TABLE models(category,brand_id,series_id,id,year,name,min_registration_year,max_registration_year,catalog_price);
      INSERT INTO provinces VALUES ('20','广东');
      INSERT INTO cities VALUES ('20','20','广州');
      INSERT INTO brands VALUES ('passenger','b1','北湖AUTO');
      INSERT INTO series VALUES ('passenger','b1','s1','北湖E8X');
      INSERT INTO models VALUES ('passenger','b1','s1','9001',2026,'2026款 北湖E8X 标准版',2026,2026,'16万');`);
    const p=makeParser(local,{today:()=>new Date(2026,10,26)});
    assert.equal(p({text:'北湖14年，14万公里'}).code,'NO_SERIES');
    assert.equal(p({text:'北湖E8X，14万公里'}).job?.input.modelId,'9001');
  } finally {local.close();}
});

test('同年同车系内按指导价选择顶配和次档，明确写出的配置优先',()=>{
  const prefix='丰田皇冠陆放23年8月份车，3万公里，';
  for(const [tail,id] of [
    ['次顶配','1848384'],['次高配','1848384'],['顶配','1848385'],['最高配','1848385'],
    ['次低配','1848382'],['最低配','1848381'],['四驱次顶配','1848384'],
    ['两驱次顶配','1848381'],['进取版次顶配','1848381'],['不是次顶配','1848381'],['','1848381']
  ])match(prefix+tail,id,'2023-08',3);
  assert.doesNotMatch(parse({text:prefix+'两驱次顶配'}).job.reason,/按目录指导价选次顶配/);
});

test('相同指导价只占一档，缺少指导价时恢复原有选款顺序',()=>{
  const local=new DatabaseSync(':memory:');
  try {
    local.exec(`
      CREATE TABLE metadata(updated_at);
      CREATE TABLE provinces(id,name);
      CREATE TABLE cities(province_id,id,name);
      CREATE TABLE brands(category,id,name);
      CREATE TABLE series(category,brand_id,id,name);
      CREATE TABLE models(category,brand_id,series_id,id,year,name,min_registration_year,max_registration_year,catalog_price);
      INSERT INTO provinces VALUES ('20','广东');
      INSERT INTO cities VALUES ('20','20','广州');
      INSERT INTO brands VALUES ('passenger','b1','北湖');
      INSERT INTO series VALUES ('passenger','b1','s1','北湖星程');
      INSERT INTO models VALUES
        ('passenger','b1','s1','9001',2024,'2024款 北湖星程 入门版',2024,2025,'16万'),
        ('passenger','b1','s1','9002',2024,'2024款 北湖星程 舒适版',2024,2025,'18万'),
        ('passenger','b1','s1','9003',2024,'2024款 北湖星程 豪华版',2024,2025,'20万'),
        ('passenger','b1','s1','9004',2024,'2024款 北湖星程 豪华五座版',2024,2025,'20.00万'),
        ('passenger','b1','s1','9005',2025,'2025款 北湖星程 旗舰版',2025,2026,'25万');`);
    const p=makeParser(local,{today:()=>new Date(2026,10,26)});
    const text='24款北湖星程次顶配6万公里';
    assert.equal(p({text}).job?.input.modelId,'9002');
    local.exec("UPDATE models SET catalog_price=NULL WHERE id='9004'");
    const fallback=p({text});
    assert.equal(fallback.job?.input.modelId,'9001');
    assert.doesNotMatch(fallback.job.reason,/按目录指导价选次顶配/);
  } finally {local.close();}
});

test('同一个代号：裸码优先奥迪，完整车系优先生成的省略后缀，明确品牌优先',()=>{
  match('17年11月份 9万公里 奥迪Q5','1132933','2017-11',9);
  match('18年11月份 9万公里 奥迪Q5L','1151055','2018-11',9);
  match('17年11月份 9万公里 进口奥迪Q5','1150964','2017-11',9);
  ignored('25年奥迪Q5 6万公里','NO_YEAR_MATCH');
  match('25年2月份A5前脸追尾 大的换了一个','1950271','2025-02',10);
  match('25年2月份奥迪A5L前脸追尾 大的换了一个','1944309','2025-02',10);
  match('25年2月份东南A5翼舞前脸追尾 大的换了一个','1817846','2025-02',10);
  match('25年2月份思皓A5','1833477','2025-02',10);
  ignored('东南A5翼舞和奥迪A5','AMBIGUOUS_SERIES');
  assert.equal(parse({text:'A5纸多少钱'}).ok,false);
});

test('只规范明确里程的千位分隔符，车型粘连、价格和坏分组分别处理',()=>{
  for(const text of [
    '24款昂科威 Plus25,000公里，原版原漆。现在差不多多少钱',
    '24款昂科威 Plus，尊享两驱。25,000公里，原版原漆',
    '24款昂科威 Plus25，000公里，原版原漆',
    '24款昂科威 Plus 25000公里，原版原漆'
  ])match(text,'1900231','2024-01',2.5);
  match('24款昂科威Plus，预算25,000元，6万公里','1900231','2024-01',6);
  assert.equal(extractMileage('120,000km').value,12);
  assert.equal(extractMileage('25,12公里'),null);
  assert.equal(extractMileage('25,000公里，6万公里'),null);
  match('24款昂科威Plus 25,12公里','1900231','2024-01',10);
});

test('明确里程优先于维修费或裸金额；无法确认才采用 10 万公里',()=>{
  match('2018款凌渡280豪华版，18万公里，前面两个安全气囊爆过，维修记录7万，还能值多少',
    '1139062','2018-01',18);
  for(const [line,n] of [
    ['18W公里，维修记录7万',18],
    ['维修记录七万，18万公里',18],
    ['18万公里，另外看了个7万',18],
    ['维修费7万，跑了18w',18],
    ['维修记录7万公里',7],
    ['维修记录7万',10],
  ])assert.equal(extractMileage(line.toLowerCase()).value,n,line);
  match('18年君威13万公里，里程4万','1155654','2018-01',10);
  match('18年君威13万-14万公里','1155654','2018-01',10);
  assert.equal(parse({text:'13万公里还是4万公里'}).ignored,true);
});

test('明确配置先按年款匹配，匹配不到则在全年份找同配置',()=>{
  match('24款甄享 银色 45000公里','1950650','2025-01',4.5);
  match('24款甄享银色45000公里','1950650','2025-01',4.5);
  match('2024甄享','1950650','2025-01',10);
  match('26款甄享 银色 45000公里','1979135','2026-01',4.5);
  match('甄享','1979135','2026-01',10);
  match('2021款创驰 白色5万公里','1777805','2022-01',5);
  match('2021款雷克萨斯NX260创驰5万公里','1777805','2022-01',5);
  match('23款创驰 白色5万公里','1868315','2023-01',5);
  ignored('24款臻享 银色 45000公里','NO_SERIES');
  ignored('24年上牌甄享 银色 45000公里','NO_YEAR_MATCH');
  ignored('2030款甄享 45000公里','NO_YEAR_MATCH');
});

test('明确写了年款范围时取右端，不把范围前缀粘到车型尾标',()=>{
  match('奔驰e260 22-23款','1832619','2023-01',10);
  match('奔驰E260 2022—2023年款','1832619','2023-01',10);
  match('宝马X3 20～21款 6万公里','1766272','2021-01',6);
  match('雷克萨斯NX260 2022至2023款 创驰 5万公里','1868315','2023-01',5);
  match('奔驰E260 2022年上牌 22-23款','1832619','2022-01',10);
  ignored('奔驰E260 22-23款 24款','DATE');
  // A separated odometer range no longer becomes part of the model badge.
  // It is not a year range; unclear mileage uses the existing 10万 default.
  const unclear=parse({text:'奔驰E260 22-23万'}),latest=parse({text:'奔驰E260'});
  assert.equal(unclear.ok,true);assert.equal(unclear.job.input.modelId,latest.job.input.modelId);
  assert.equal(unclear.job.input.registration,latest.job.input.registration);assert.equal(unclear.job.input.mileage,10);
});

test('尾标贯穿车系反查和款式筛选，区分上牌月份、里程与价格',()=>{
  match('22年十二月上牌，23款别克653，香槟色，八万公里，原版原漆，值多少钱','1831574','2022-12',8);
  match('22年23款，香槟色，12月份上牌，GL8，653豪华，八万公里，卖多少钱','1831574','2022-12',8);
  match('23款GL8 652豪华 8万公里','1831579','2023-01',8);
  match('24年大众CC380夺目 8万公里','1886512','2024-01',8);
  match('11年的奔驰cls300脱保脱审四月到了，14.6万公里，多少能收','22392','2011-01',14.6);
  ignored('22年十五月上牌，23款别克653，八万公里','DATE');
  assert.equal(parse({text:'别克653元的配件'}).ignored,true);
});

test('字符二次匹配：重比分已有候选，也重新从目录召回空结果',()=>{
  const blocked=parse({text:'18年领克01 pro 2.0T 13万公里'});
  assert.equal(blocked.matchPath,'character-fallback');
  assert.match(blocked.job.car,/领克01.*2\.0T.*Pro/);
  match('18年领克01型pro2.0T，13万公里，追尾底盘保险杠总成，排气全换件，没有切割有钣金大概多少',
    '1142619','2018-01',13);
  for(const [text,id] of [
    ['22年mg05天蝎座1.5t豪华5w公里多少米收','1819275'],
    ['23年modol3 5.5万公里','1867089'],
  ]){
    const r=parse({text});
    assert.equal(r.matchPath,'character-fallback',text);
    assert.equal(r.job.input.modelId,id,text);
  }
  const passat=parse({text:'帕色特多少钱'});
  assert.equal(passat.matchPath,'character-fallback');
  assert.match(passat.job.car,/帕萨特/);
  ignored('22年MG6天蝎座1.5t豪华5w公里多少米收','MODEL_CONFLICT');
  ignored('18年领克01和vala pro','AMBIGUOUS_SERIES');
  ignored('22年卡罗拉 凯美瑞 8万公里','AMBIGUOUS_SERIES');
  for(const text of ['可以收吗','那要是换过气囊呢','劳斯莱斯汽车 天津','帮我换电池多少钱','57','讲故事。'.repeat(132)])
    assert.equal(parse({text}).ignored,true,text);
});

test('真实评论：选对车型 ID、上牌年月、里程和城市',()=>{
  match('16年缤智1.8 15万公里多少收','29208','2016-01',15);
  match('17年别克威朗十万公里1.5自吸的','32747','2017-01',10);
  match('20款雷克萨斯es200，白色8.9公里精品过三方，还要多少米？','1348541','2020-01',8.9);
  match('0款雷克萨斯es200，白色8.9公里精品过三方，还要多少米？','1348541','2020-01',8.9);
  match('23年7月高尔夫pro版6.9万公里，出手值多少','1836779','2023-07',6.9);
  match('理想l9max24年1月上牌的黑外橙内全车原版原漆，6.6万公里','1825277','2024-01',6.6);
  match('雅阁幻夜尊贵7w还值多少','1775211','2022-01',7);
  ignored('2017本田10代1.0T 十三万 公里 出多少钱？','NO_SERIES');
  ignored('12年赛欧，手动挡。值多少钱？','AMBIGUOUS_SERIES');
  match('本田雅阁十代18年公里数11万85','1148869','2018-01',10);
});
test('可推广规则：年款和上牌分开、同年带配置、缺项、别名、换序',()=>{
  match('16年缤智 1.8 四驱','23323','2016-01',10);
  match('2015款缤智1.8四驱 16年上牌 汕头 86000公里','23323','2016-01',8.6,'106');
  match('24款L9U，25年4月上牌，汕头，3.6万公里','1885695','2025-04',3.6,'106');
  match('6年黑色l8李维斯 8月上牌6100公里','1988935','2026-08',0.61);
  match('理想 L８ Pｒｏ','1928053','2025-01',10);
  match('别克威朗 1.5 自吸的，17年 十万公里','32747','2017-01',10);
  match('雅阁幻夜尊贵 预算7w','1775211','2022-01',10);
  match('16款缤智1.8四驱','23323','2015-01',10);
  ignored('轩逸真省油','CHAT');
});
test('车型前缀与配置尾号：GLC260L、天逸C5及跨车系反例',()=>{
  match('20年Glc260l豪华11万公里','1347888','2020-01',11);
  match('20年 奔驰 GLC 260 L 豪华 11万公里','1347888','2020-01',11);
  match('19年GLC260豪华 11万公里','1160300','2019-01',11);
  ignored('20年GLC999L豪华 11万公里','NO_TRIM');
  match('17款天逸c5时尚版1.6 T，12万公里','1134033','2017-01',12);
  match('17款雪铁龙天逸 C5 AIRCROSS 350THP 时尚 12万公里','1134033','2017-01',12);
  match('17年天逸 C5时尚1.6T10万公里','1134033','2017-01',10);
  match('17款天逸时尚版1.8 T，12万公里','1134031','2017-01',12);
  ignored('17年 C5 12万公里','AMBIGUOUS_SERIES');
  ignored('17年天逸、别克威朗 12万公里','AMBIGUOUS_SERIES');
});
test('从目录识别括号别名；保留车系、车身和变速箱边界',()=>{
  match('2016年昂克赛拉豪华版9.7万公里值多少钱','28693','2016-01',9.7);
  match('2016年马自达3昂克赛拉豪华版9.7万公里值多少钱','28693','2016-01',9.7);
  match('2016年马自达3昂克塞拉豪华9.7万公里','28693','2016-01',9.7);
  match('2016年昂克塞拉两厢自动豪华9.7万公里','28698','2016-01',9.7);
  match('2016年昂克赛拉自动三厢豪华9.7万公里','28694','2016-01',9.7);
  // A uniquely identified old family may register after its catalog's stale
  // upper bound; retain the viewer's date and use its nearest compatible trim.
  match('2016年马自达3豪华9.7万公里','13439','2016-01',9.7);
  match('22年凡尔赛C5 6万公里','1805182','2022-01',6);
  ignored('17年 C5 12万公里','AMBIGUOUS_SERIES');
});
test('按车系设默认配置；明确配置在车名中间也优先',()=>{
  match('24年卡罗拉锐放2.0两万三千公里','1901026','2024-01',2.3);
  match('24年卡罗拉锐精英放2.0两万三千公里','1901028','2024-01',2.3);
  match('24年卡罗拉锐放2.0精英两万三千公里','1901028','2024-01',2.3);
  match('24年丰田卡罗拉锐豪华放2.0两万三千公里','1901027','2024-01',2.3);
  match('24年卡罗拉锐放双擎精英 2.0两万三千公里','1901031','2024-01',2.3);
  match('16年昂克豪华赛拉9.7万公里','28693','2016-01',9.7);
  match('24年卡罗拉锐精英放 先锋 两万三千公里','1901026','2024-01',2.3);
  ignored('24年卡罗拉锐精英放、威朗 两万三千公里','AMBIGUOUS_SERIES');
});
test('里程口语、价格、续航和冲突',()=>{
  for(const [text,expected] of [['八万六千公里',8.6],['2.0两万三千公里',2.3],['十三万 公里',13],['8.9公里',8.9],['实际才跑8.9公里',0.00089],['续航610公里',10],['想卖8万',10],['6100公里',0.61],['15.5w公里',15.5]]) {
    assert.equal(extractMileage(text).value,expected,text);
  }
  assert.equal(extractMileage('1万公里 2万公里'),null);
  assert.equal(extractMileage('公里数11万85'),null);
});

test('重叠字符只属于证据更完整的车系；独立出现的两辆车不互相覆盖',()=>{
  match('上汽大通D90天狼星四17年12月多少','1133895','2017-12',10);
  match('上汽大通Ｄ９０北极星6座17年12月','1820526','2017-12',10);
  match('上汽大通D90水星17年12月','1133898','2017-12',10);
  match('上汽大通D60 20年7万公里','1526419','2020-01',7);
  match('18年途观L8万公里','1155647','2018-01',8);
  match('2019款名爵6超能互联 7万公里','1209936','2019-01',7);
  match('17款天时尚逸 C5 1.6T 12万公里','1134033','2017-01',12);
  match('17款天逸时尚版C5 1.6T 12万公里','1134033','2017-01',12);
  match('上汽大通D90天狼星两驱17年12月','1133895','2017-12',10);
  ignored('上汽大通D90、途岳 2019年','AMBIGUOUS_SERIES');
  ignored('2017年天逸C5、瑞驰C5 哪台值钱','AMBIGUOUS_SERIES');
  ignored('17年 C5 12万公里','AMBIGUOUS_SERIES');
});

test('目录反查连写尾标、品牌车系重叠和简称配置，不串成另一辆车',()=>{
  match('2020奔驰C200L 时尚版 多少钱','1348790','2020-01',10);
  match('2020款 奔驰C级 C-200 L 时尚版，8万公里','1348790','2020-01',8);
  match('19年奔驰E-300L豪华6万公里','1157914','2019-01',6);
  match('2013年雪铁龙尊驭C5，铝轮锅，1600kg，多少钱？','17601','2013-01',10);
  match('13年雪铁龙 尊驭型 C5 16万公里','17601','2013-01',16);
  match('雷克萨斯nx260 23年，创驰，白色5万公里','1868315','2023-01',5);
  match('23款 雷克萨斯NX（进口） 350h 创驰版 5万公里','1868318','2023-01',5);
  match('吉利帝豪GS2016款1.8L，十二万五千公里还值几千块','31563','2016-01',12.5);
  ignored('2020款大众C200L 时尚版','NO_SERIES');
  ignored('2013年雪铁龙尊驭C5和瑞驰C5','AMBIGUOUS_SERIES');
  ignored('朗逸和陆风风尚','AMBIGUOUS_SERIES');
  match('创驰版多少钱','1890765','2024-01',10);
  match('创驰版','1890765','2024-01',10);
});

test('所有片段联合覆盖，不依赖品牌、年款、型号和配置的顺序',()=>{
  for(const text of [
    '雪铁龙13年尊驭C5 16万公里','13年雪铁龙，尊驭C5 16万公里',
    '13年雪铁龙的尊驭型C5 16万公里','13年尊驭C5雪铁龙，16万公里',
    '13年C5尊驭雪铁龙 16万公里'
  ])match(text,'17601','2013-01',16);
  assert.match(parse({text:'雪铁龙13年尊驭C5 16万公里'}).job.reason,/车型字符覆盖 7\/7/);
  match('22年宝马325Li M运动，8万公里','1772743','2022-01',8);
  match('325Li M运动22年宝马8万公里','1772743','2022-01',8);
  match('22年宝马325LiM运动曜夜8万公里','1772744','2022-01',8);
  match('22年宝马320LiM运动 8万公里','1772742','2022-01',8);
  match('23年雷克萨斯NX，260创驰，白色5万公里','1868315','2023-01',5);
  match('雷克萨斯NX260 23年 创驰 白色5万公里','1868315','2023-01',5);
  match('23年260创驰NX雷克萨斯5万公里','1868315','2023-01',5);
  match('23年雷克萨斯260创驰NX，5万公里','1868315','2023-01',5);
  ignored('雷克萨斯2023年，260元的配件，创驰NX','NO_SERIES');
  ignored('奔驰22年325Li M运动 8万公里','NO_SERIES');
  ignored('瑞驰13年尊驭C5','NO_YEAR_MATCH'); // 配置词不拦截，但该品牌的目录没有可用于 2013 年上牌的车。
  ignored('13年C5尊驭雪铁龙、瑞驰C5 16万公里','AMBIGUOUS_SERIES');
  ignored('雪铁龙13年尊驭C5 瑞驰C5 16万公里','AMBIGUOUS_SERIES');
  ignored('23年宝马325Li和奔驰E300L','AMBIGUOUS_SERIES');
});

test('型号高字符覆盖能产生候选：同品牌且数字不变，唯一近似候选即可入队',()=>{
  const original='23年特斯拉modol3,黑色，5.5公里';
  match(original,'1867089','2023-01',5.5);
  assert.match(parse({text:original}).job.reason,/modol3 → model3.*5\/6/);
  match('23年特斯拉 MODOL 3，5.5公里','1867089','2023-01',5.5);
  match('23年modeel3特斯拉,5.5公里','1867089','2023-01',5.5);
  match('23年特斯拉modol Y，5万公里','1870950','2023-01',5);
  match('2017年大众Pasat 6万公里','1127997','2017-01',6);
  match('2017年进口大众Passet 6万公里','1205514','2017-01',6);
  match('18款福特mustng 7万公里','1242457','2018-01',7);
  ignored('23年特斯拉modol7，5.5万公里','NO_SERIES');
  ignored('23年特斯拉modol 3万公里','NO_SERIES');
  ignored('23年福特modol3，5.5万公里','NO_SERIES');
  ignored('23年特斯拉，黑色，5.5公里','NO_SERIES');
  ignored('23年特斯拉modelz 5.5万公里','AMBIGUOUS_SERIES');
  ignored('23年特斯拉modol3和宝马X3，5万公里','AMBIGUOUS_SERIES');
});

test('中文候选、简称和配置词在多种车系复用，数字、配置与年款仍校验',()=>{
  match('2015年帕色特1.8t尊荣版，16.5万公里','27912','2015-01',16.5);
  match('13年丰田RAV4，2.0自动挡，两区14万公里，一手车','6449','2013-01',14);
  match('22年丰田荣放风尚puls黑色6万公里什么价格','1823454','2022-01',6);
  match('16年迈瑞宝x L，1.5 T自动，11万公里','30094','2016-01',11);
  match('18年奥迪a3时间型自动档8.5公里','1134327','2018-01',8.5);
  match('18年奥迪A4 11万公里 时尚','1134286','2018-01',11);
  match('2018款2019上牌唐燃油十万公里保险还有一年不需要投资','1169335','2019-01',10);
  match('17年捷达1.6排量自动挡，80789公里，高配带定速巡航，带天窗多少钱','23408','2017-01',8.0789);
  match('19款21年大众朗逸启航自动挡原版原漆7万公里','1367339','2021-01',7);
  match('这个“奔腾X80，2015高配2.0，6万公里”多少钱收来着？','23882','2015-01',6);
  match('19年君威1.5T10万公里','1181331','2019-01',10);
  match('18年宝马525 12万公里','1146249','2018-01',12);
  match('15款奔驰GLK2605万公里，中配，多少钱收','23642','2015-01',5);
  match('22款12月上牌。6万多公里。ct5。 出险过。','1801495','2022-12',6);
  match('14A6 15万公里','20336','2014-01',15);
  ignored('行 那你明天来看看车吧','CHAT');
  ignored('18年1.5t，五万公里，多少钱合适','NO_SERIES');
  assert.equal(extractMileage('行驶8万 3000多公里').value,8.3);
  assert.equal(extractMileage('10万公里，，4.6可以买吗').value,10);
});

test('动力、年款、里程各归其位；中配仅在符合明确条件的款式内选',()=>{
  for (const text of ['途岳中配1.4t2019款，7万公里','2019款大众途岳 1.4 T 中配 7万公里','途岳２０１９款 中配１.４Ｔ七万公里']) {
    match(text,'1169006','2019-01',7);
  }
  match('途岳中配1.4t豪华2019款，7万公里','1169008','2019-01',7);
  match('2019款途岳中配2.0T 7万公里','1169012','2019-01',7);
  match('2019款途岳低配1.4T','1169004','2019-01',10);
  match('2019款途岳高配1.4T','1169010','2019-01',10);
  ignored('2019款途岳1.5T 7万公里','NO_TRIM');
  ignored('2019款途岳、金杯T20 7万公里','AMBIGUOUS_SERIES');
});

test('同名车系验证到具体款；国内版默认、明确进口分别选款',()=>{
  match('22年帕萨特大概多少米？六万公里','1772660','2022-01',6);
  match('2017年帕萨特 6万公里','1127997','2017-01',6);
  match('2017年进口帕萨特 6万公里','1205514','2017-01',6);
  match('2017年帕萨特进口 6万公里','1205514','2017-01',6);
  ignored('2022款进口帕萨特 6万公里','NO_YEAR_MATCH');
  match('2015赛欧amt8万多公里多少','28248','2015-01',8);
  match('15年雪佛兰赛欧 AMT 八万多公里多少钱','28248','2015-01',8);
  ignored('15年别克赛欧AMT 8万公里','NO_TRIM');
  ignored('赛欧手动挡','AMBIGUOUS_SERIES');
});

test('同厂同车系跨目录默认乘用车，明确进口、用途或型号时保留约束',()=>{
  match('15年11月上牌兰德酷路泽11万公里多少钱你收','30644','2015-11',11);
  match('15年11月上牌丰田汽车兰德酷路泽11万公里','30644','2015-11',11);
  match('15年11月上牌进口兰德酷路泽11万公里','25717','2015-11',11);
  match('18年九龙A6 6万公里','1150676','2018-01',6);
  match('24年大通G50救险车','1905324','2024-01',10);
  match('20年兰德酷路泽LC79 4.0手动','1911780','2020-01',10);
  ignored('15年兰德酷路泽和普拉多','AMBIGUOUS_SERIES');
});

test('目录自动生成口语数字和漏字母简称，保留实际数字与年款',()=>{
  match('24年大通50多少钱','1914449','2024-01',10);
  match('24年大通G50多少钱','1914449','2024-01',10);
  match('大通50 24年 5万公里','1914449','2024-01',5);
  match('24年大通50！五万左右','1914449','2024-01',5);
  match('24年大通10多少钱','1834948','2024-01',10);
  ignored('24年大通70多少钱','AMBIGUOUS_SERIES');
  ignored('24年大通V50多少钱','NO_SERIES');
  assert.equal(parse({text:'24年大通50元多少钱'}).ok,false);
  assert.equal(parse({text:'24年大通50万公里'}).ok,false);
  match('方程豹五，25ultra，2万公里，小补漆。落地差不多26，现在车商出17亏这么多吗？25年6月上牌','1921404','2025-06',2);
  match('豹五 25款ultra 2万公里','1921404','2025-01',2);
  match('25年方程豹钛三 6万公里','1924951','2025-01',6);
  match('23年宝马X三 6万公里','1901529','2023-01',6);
});

test('通用配置后缀不生成第二车系，完整名称和真实两车仍独立处理',()=>{
  match('主播2017卡罗拉1.2T经典版现在多少米','32968','2017-01',10);
  match('2017年卡罗拉1.2T经典版现在多少米','32968','2017-01',10);
  match('主播2017卡罗拉1.2T手动经典版现在多少米','32969','2017-01',10);
  match('19年速腾1.4T经典版7万公里','1205456','2019-01',7);
  match('哈弗H5经典 2018款10万公里','1133250','2018-01',10);
  ignored('经典版多少钱','CHAT');
  ignored('17年卡罗拉和哈弗H5经典','AMBIGUOUS_SERIES');
});

test('完整配置占用连续字符，不把内部两字或动力徽标拆给其他车系',()=>{
  for(const text of [
    '24年4月上牌A6L，豪华动感40，23000公里，全车车衣，原版原漆',
    '24年4月上牌奥迪A6L，40TFSI 豪华动感型，23000公里',
    '24年4月上牌A6L 40豪华动感 23000公里',
    '24年4月上牌A6L 豪华动感 40万元 23000公里'
  ])match(text,'1872425','2024-04',2.3);
  match('24年4月上牌A6L，豪华动感45，23000公里','1872427','2024-04',2.3);
  ignored('24年4月上牌A6L，豪华动感40，23000公里，和华动','AMBIGUOUS_SERIES');
  const two=parse({text:'24年4月上牌A6L 40TFSI 豪华动感 23000公里和名爵TF'});
  assert.equal(two.code,'AMBIGUOUS_SERIES');
  assert.match(two.reason,/奥迪.*名爵/);
  assert.doesNotMatch(two.reason,/华动/);
});

test('无独立第二车线索时进行分层竞争；完整车系加配置的字符胜过短词',()=>{
  const audi=parse({text:'24年4月上牌A6L，豪华动感40，23000公里，全车车衣，原版原漆'});
  assert.deepEqual(audi.matchEvidence,{brand:0,series:3,model:9,relevantChars:9});
  match('24年4月奥迪A6L，豪华动感40，23000公里华动','1872425','2024-04',2.3);
  match('2017卡罗拉1.2T 华动','32968','2017-01',10);
  const corolla=parse({text:'主播2017卡罗拉1.2T经典版现在多少米'});
  assert.equal(corolla.matchEvidence.model,6); // 卡罗拉 + 1, 2, T；标点不计
  ignored('2017卡罗拉1.2T和华动','AMBIGUOUS_SERIES');
  ignored('2017卡罗拉1.2T 江苏华东华动','AMBIGUOUS_SERIES');
});

test('只写省、省市冲突或多城市时用广州，能确认的外省城市照常使用',()=>{
  for(const text of [
    '反正我们青海汉兰达价格高，今天看了个15的19w公里，有换件叶子板，要我6个中最低',
    '15年汉兰达青海西宁成都19万公里','15年汉兰达青海成都19万公里',
  ]) match(text,'25679','2015-01',19);
  for(const text of ['青海西宁15年汉兰达19万公里','15年汉兰达，西宁19万公里']){
    const result=parse({text});
    assert.deepEqual(result.job?.input,{modelId:'25679',registration:'2015-01',mileage:19,provinceId:'27',cityId:'26'});
  }
});

test('车标和动力先定款；无同年配置时保留上牌日期并查相邻年款',()=>{
  match('2022款glc 300动感10公里','1776222','2022-01',0.001);
  match('9款奔驰C180八万公里','1168884','2019-01',8);
  match('19款奔驰C180进口旅行八万公里','1182806','2019-01',8);
  match('起亚K314年款','24322','2013-01',10);
  match('19年豪华版白色自动1.5t思域要喷5，6副油漆！8万 3000多公里 ！收多少钱','30635','2019-01',8.3);
  match('20年雷凌1.2t豪华版7万公里，全车原版原漆就是换过前挡玻璃','1231344','2020-01',7);
  match('22年23款速腾 1.4t 14万公里 小剐蹭','1823752','2022-01',14);
  match('18款19年上牌的G65AMG最终收官版，6.0T，V12双涡轮。白色3.5万公里','30241','2019-01',3.5);
  match('19年上牌 奔驰AMG G65，6.0T，3.5万公里','30241','2019-01',3.5);
  ignored('18款19年上牌的G65AMG 4.0T，3.5万公里','NO_TRIM');
  ignored('2022款GLC300D动感10万公里','NO_TRIM');
});

test('同码简称有默认品牌；命名配置能从目录反查车系，明确车型信息优先',()=>{
  match('出一台25年10月上牌，3.0旗舰动感A6，6万公里多少能谈','1915824','2025-10',6);
  match('21年昌河A6 6万公里','1349222','2021-01',6);
  match('25款奥迪A6 allroad 6万公里','1914015','2025-01',6);
  assert.match(parse({text:'2004年A6 8万公里'}).job?.car,/2004款 奥迪A6 /);
  assert.equal(parse({text:'A6纸多少钱'}).ok,false);
  ignored('21年昌河A6和25年A6L','AMBIGUOUS_SERIES');
  for (const text of [
    '22年陆尊8万公里换水箱和大灯多少现在还能',
    '22年别克陆尊8万公里','22年别克GL8陆尊8万公里','22年 ES陆尊8万公里'
  ]) match(text,'1773874','2022-01',8);
  assert.match(parse({text:'25年陆尊PHEV 8万公里'}).job?.car,/别克GL8新能源/);
  assert.match(parse({text:'GL8陆尊PHEV 25年8万公里'}).job?.car,/别克GL8新能源/);
  ignored('22年陆尊PHEV8万公里','NO_YEAR_MATCH');
  match('22年荣威陆尊8万公里','1610566','2022-01',8);
  ignored('22年陆尊和朗逸8万公里','AMBIGUOUS_SERIES');
  match('23年创驰8万公里','1868315','2023-01',8);
  match('23年创驰版8万公里','1868315','2023-01',8);
});

test('禁用专用别名也能反查目录；字符跨层加分，入队后用确认的车型请求报价',async()=>{
  const catalogOnly=makeParser(db,{today:()=>new Date(2026,10,25),familyAliases:[]});
  const r=catalogOnly({text:'22年陆尊8万公里换水箱和大灯多少现在还能'});
  assert.deepEqual(r.job?.input,{modelId:'1773874',registration:'2022-01',mileage:8,provinceId:'20',cityId:'20'});
  assert.deepEqual(r.matchEvidence,{brand:0,series:0,model:2,relevantChars:2});
  assert.match(r.job.reason,/由配置名反查车系：别克GL8/);
  assert.equal(catalogOnly({text:'22年荣威陆尊8万公里'}).job?.input.modelId,'1610566');
  assert.equal(catalogOnly({text:'22年陆尊和朗逸8万公里'}).code,'AMBIGUOUS_SERIES');
  const audi=catalogOnly({text:'25年10月上牌，奥迪 A6 旗舰动感，6万公里'});
  assert.equal(audi.job?.input.modelId,'1915824');
  assert.deepEqual(audi.matchEvidence,{brand:2,series:2,model:8,relevantChars:8});
  const called=[];
  const board=new QuoteBoard({holdMs:0,pause:()=>Promise.resolve(),quote:async input=>{
    called.push(input);
    return {ok:true,prices:{good:{low:5,high:6}}};
  }});
  board.add(r.job);
  board.add(audi.job);
  await new Promise(setImmediate);
  assert.deepEqual(called,[r.job.input,audi.job.input]);
  assert.deepEqual(board.snapshot().history.map(x=>x.input.modelId),['1915824','1773874']);
});

test('车系简称、目录首款、无年款选最新、缺失年份和买价里程隔离',()=>{
  match('奔驰c20年左右的二手大概多少呀','1405317','2020-01',10);
  match('宝马X 3','1974215','2026-01',10);
  match('2020款宝马X 3，3万公里','1352217','2020-01',3);
  match('2000年宝马X 3，3万公里，白色，想出，什么价','1974215','2026-01',3);
  assert.match(parse({text:'2000年宝马X 3，3万公里，白色，想出，什么价'}).job.reason,/2000.*无年份.*最新/);
  match('18年13万公里的君威4万多能买吗','1155654','2018-01',13);
  match('18年君威 4w多能买吗，13万公里','1155654','2018-01',13);
  match('18年君威13万公里还是4万公里','1155654','2018-01',10);
  match('2016款蔚揽1.4T值多少，12万公里了','29969','2016-01',12);
  ignored('2016款蔚揽3.0T 12万公里','NO_TRIM');
});

test('确认车系后明显过早的单一年份和没写年份同样选款，保留其它已确认字段',()=>{
  for(const [series,old] of [['宝马X3','2000年'],['本田缤智','1990款'],['帕萨特','1990年']]){
    const ordinary=parse({text:series+'，汕头，8万公里'});
    const fallback=parse({text:old+series+'，汕头，8万公里'});
    assert.ok(ordinary.ok);
    assert.deepEqual(fallback.job?.input,ordinary.job.input);
  }
  ignored('1990款缤智1.8四驱 8万公里','NO_YEAR_MATCH');
  ignored('宝马X3 2015年 3万公里','NO_YEAR_MATCH'); // could be an import
  ignored('2030年宝马X3 3万公里','NO_YEAR_MATCH');
  ignored('2000年宝马X3 2020款 3万公里','NO_YEAR_MATCH');
  ignored('2000年宝马X3和帕萨特 3万公里','AMBIGUOUS_SERIES');
});

test('只在临时目录数据里新增的车系和配置，不加别名也能解析',()=>{
  const fresh=new DatabaseSync(':memory:');
  try {
    fresh.exec(`
      CREATE TABLE metadata(updated_at);
      CREATE TABLE provinces(id,name);
      CREATE TABLE cities(province_id,id,name);
      CREATE TABLE brands(category,id,name);
      CREATE TABLE series(category,brand_id,id,name);
      CREATE TABLE models(category,brand_id,series_id,id,year,name,min_registration_year,max_registration_year,catalog_price);
      INSERT INTO provinces VALUES ('20','广东');
      INSERT INTO cities VALUES ('20','20','广州');
      INSERT INTO brands VALUES ('car','b1','云岭'),('car','b2','云岭乘用车'),('car','b3','湖川');
      INSERT INTO series VALUES ('car','b1','s1','云岭云驰'),('car','b2','s2','云驰Z71'),('car','b3','s3','湖川Z71'),('car','b3','s4','湖川望舒'),('car','b1','s5','光智');
      INSERT INTO models VALUES
        ('car','b3','s4','9003',2019,'2019款 湖川望舒 1.5T 手动晨光版',2019,2022,'11万'),
        ('car','b3','s4','9004',2021,'2021款 湖川望舒 1.5T 自动晨光版',2020,2024,'12万'),
        ('car','b3','s4','9005',2018,'2018款 湖川望舒 1.5T 自动晨光版',2018,2022,'12万'),
        ('car','b3','s4','9006',2021,'2021款 湖川望舒 1.5T 自动晨光智享版',2020,2024,'12万'),
        ('car','b2','s2','9001',2021,'2021款 云驰Z71 自动晨光版',2021,2024,'12万'),
        ('car','b2','s2','9002',2021,'2021款 云驰Z71 自动望舒版',2021,2024,'14万');`);
    const local=makeParser(fresh,{today:()=>new Date(2026,10,25)});
    const job=local({text:'云岭云驰Z71望舒21年3月4万公里'}).job;
    assert.deepEqual(job?.input,{modelId:'9002',registration:'2021-03',mileage:4,provinceId:'20',cityId:'20'});
    const nearby=local({text:'湖川望舒20年1.5T自动 3万公里'}).job;
    assert.deepEqual(nearby?.input,{modelId:'9004',registration:'2020-01',mileage:3,provinceId:'20',cityId:'20'});
    assert.equal(local({text:'湖川望舒20年1.5T手动 3万公里'}).job?.input.modelId,'9003');
    assert.equal(local({text:'湖川望舒20年3.0T自动 3万公里'}).code,'NO_TRIM');
    assert.equal(local({text:'2021年晨光版4万公里'}).code,'AMBIGUOUS_SERIES');
    assert.equal(local({text:'2021年湖川晨光版4万公里'}).job?.input.modelId,'9004');
    assert.equal(local({text:'2021年湖川望舒晨光智享版4万公里'}).job?.input.modelId,'9006');
    assert.equal(local({text:'2021年湖川望舒和光智'}).code,'AMBIGUOUS_SERIES');
    assert.equal(local({text:'21年云岭云驰Z71和湖川Z71'}).code,'AMBIGUOUS_SERIES');
    assert.equal(local({text:'21年云岭云驰Z71和湖川望舒'}).code,'AMBIGUOUS_SERIES');
  } finally {fresh.close();}
});
test('FIFO、失败跳过、头像可选、照片跟任务、保留最新一张和前四张',async()=>{
  const requested=[]; const renders=[];
  let finish;
  const done=new Promise(r=>{finish=r;});
  const board=new QuoteBoard({
    quote:async ({modelId})=>{
      requested.push(modelId);
      return modelId==='3'?{ok:false,code:'TIMEOUT'}:{ok:true,cached:true,prices:{good:{low:1,high:2}},vehicle:{imageUrl:'photo-'+modelId}};
    },
    change:s=>{renders.push(s);if(!s.pending.length&&!s.current&&s.history[0]?.id===6)finish(s);},
    pause:async()=>{}
  });
  for(let i=1;i<=6;i++)board.add({id:i,eventId:'msg-'+i,name:'观众'+i,input:{modelId:String(i)}});
  board.add({id:100,eventId:'msg-5',name:'重复',input:{modelId:'100'}});
  const out=await done;
  assert.deepEqual(requested,['1','2','3','4','5','6']);
  assert.deepEqual(out.history.map(x=>x.id),[6,5,4,2,1]);
  assert.deepEqual(out.history.map(x=>x.photo),['photo-6','photo-5','photo-4','photo-2','photo-1']);
  assert.ok(renders.some(s=>s.current?.id===1&&s.pending.length>=2));
});
test('服务暂缓时不丢队首；恢复后按顺序处理',async()=>{
  const order=[];let allow=false;
  const board=new QuoteBoard({quote:async input=>{order.push(input.n);return allow?{ok:true,prices:{good:{low:1,high:2}}}:{ok:false,code:'AUTH_REQUIRED'};},pause:async()=>{}});
  board.add({id:1,input:{n:1}});board.add({id:2,input:{n:2}});
  await new Promise(setImmediate);assert.equal(board.snapshot().blocked,'AUTH_REQUIRED');
  assert.deepEqual(board.snapshot().pending.map(x=>x.id),[1,2]);
  allow=true;board.resume();await new Promise(setImmediate);
  assert.deepEqual(order,[1,1,2]);
  assert.deepEqual(board.snapshot().history.map(x=>x.id),[2,1]);
});
