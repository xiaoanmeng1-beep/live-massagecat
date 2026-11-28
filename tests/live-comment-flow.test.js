'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeParser, QuoteBoard } = require('../live-board');
const { normalizeBridgeEvent } = require('../douyin-bridge');

test('直播入口：昵称格式不挡住报价正文，系统消息和非询价不报价', async () => {
  const { parseChatLine } = await import('../douyin-bridge-service.mjs');
  const db = new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  try {
    const parse = makeParser(db,{today:()=>new Date(2026,10,25)});
    const requests = [];
    const board = new QuoteBoard({
      quote: async input=>{
        requests.push(input);
        return {ok:true,prices:{good:{low:2,high:3}}};
      },
      pause: async()=>{}
    });
    const lines = [
      ['.*****：19年思域，六万公里', '1231154', 6],
      ['·＊＊＊：16年缤智1.8 15万公里', '29208', 15],
      ['12345：23年7月高尔夫Pro版6.9万公里', '1836779', 6.9],
      ['🚗：2016年昂克赛拉豪华版9.7万公里', '28693', 9.7],
      ['かな：理想L8Pro 6100公里', '1928053', 0.61],
      ['阿杰：16年缤智1.8 15万公里，新功能估个价', '29208', 15],
      ['阿元：上汽大通D90天狼星四17年12月多少', '1133895', 10],
      ['车友：途岳中配1.4t2019款，7万公里', '1169006', 7],
      ['小陈：17款天时尚逸 C5 1.6T 12万公里', '1134033', 12],
      ['老王：上汽大通D90、途岳 2019年', null],
      ['陈*****：21年上牌gl8，652t豪华.2户，11万公里，现在是个人自己开，7.9这个价格还能砍吗？','1535468',11],
      ['顺*****：14年朗逸手动风尚，14万公里','4157',14],
      ['顺*****：朗逸和陆风风尚',null],
      ['观众甲：2020奔驰C200L 时尚版 多少钱','1348790',10],
      ['观众乙：2013年雪铁龙尊驭C5，铝轮锅，1600kg，多少钱？','17601',10],
      ['观众丙：雷克萨斯nx260 23年，创驰，白色5万公里','1868315',5],
      ['观众丁：吉利帝豪GS2016款1.8L，十二万五千公里还值几千块','31563',12.5],
      ['观众戊：13年C5尊驭雪铁龙 16万公里','17601',16],
      ['观众己：22年宝马325Li M运动，8万公里','1772743',8],
      ['观众庚：23年雷克萨斯NX，260创驰，白色5万公里','1868315',5],
      ['观众辛：雪铁龙13年尊驭C5 瑞驰C5 16万公里',null],
      ['观众甲：22年帕萨特大概多少米？六万公里','1772660',6],
      ['观众乙：2000年宝马X 3，3万公里，白色，想出，什么价','1974215',3],
      ['观众丙：奔驰c20年左右的二手大概多少呀','1405317',10],
      ['观众丁：18年13万公里的君威4万多能买吗','1155654',13],
      ['观众戊：2016款蔚揽1.4T值多少，12万公里了','29969',12],
      ['观众己：2015赛欧amt8万多公里多少','28248',8],
      ['观众乙：23年特斯拉modol3,黑色，5.5公里','1867089',5.5],
      ['观众甲：2015年帕色特1.8t尊荣版，16.5万公里','27912',16.5],
      ['观众乙：13年丰田RAV4，2.0自动挡，两区14万公里，一手车','6449',14],
      ['观众丙：18年宝马525 12万公里','1146249',12],
      ['观众丁：22款12月上牌。6万多公里。ct5。 出险过。','1801495',6],
      ['观众甲：18年领克01 pro 2.0T 13万公里','1142617',13],
      ['观众乙：22年mg05天蝎座1.5t豪华5w公里多少米收','1819275',5],
      ['观众丙：22年十二月上牌，23款别克653，香槟色，八万公里，原版原漆，值多少钱','1831574',8],
      ['观众丁：奔驰e260 22-23款','1832619',10],
      ['观众己：24款甄享 银色 45000公里','1950650',4.5],
      ['观众庚：17年11月份 9万公里 奥迪Q5','1132933',9],
      ['观众辛：24款昂科威 Plus25,000公里，原版原漆。现在差不多多少钱','1900231',2.5],
      ['观众壬：25年2月份A5前脸追尾 大的换了一个','1950271',10],
      ['观众甲：2018款凌渡280豪华版，18万公里，维修记录7万，还能值多少','1139062',18],
      ['观众乙：18年君威13万公里还是4万公里','1155654',10],
      ['观众丙：丰田皇冠陆放23年8月份车，3万公里，次顶配，','1848384',3],
      ['观众丁：奥迪14年的，14万公里',null],
      ['观众戊：奥迪E7X 14万公里','1983962',14],
      ['观众甲：13 年的别克英朗两厢 XT 1.6L 白色 手自一体，公里数 2.9 万，白色','1000',2.9],
      ['观众乙：26年旅行者 1.5t 三万公里','1949156',3],
      ['观众丙：23年4月老款毛豆3六万公里','1778099',6],
      ['观众丁：24 年塞纳尊贵混动版，21500 公里，一手车','1893356',2.15],
      ['观众丁：22年MG6天蝎座1.5t豪华5w公里多少米收',null],
      ['观众戊：领克01和vala pro',null],
      ['系统：19年思域六万公里', null],
      ['在线观众：19年思域六万公里', null],
      ['----：19年思域六万公里', null],
      ['.*****：', null],
      ['.*****：回个话', null]
    ];
    for (const [i,[line,model,mileage]] of lines.entries()) {
      const event = parseChatLine(line);
      const result = event?.kind==='comment'
        ? parse({...normalizeBridgeEvent({...event,type:'comment',eventId:String(i)}),id:i})
        : null;
      assert.equal(result?.job?.input.modelId ?? null,model,line);
      if (model) {
        assert.equal(result.job.input.mileage,mileage,line);
        board.add(result.job);
      }
    }
    await new Promise(setImmediate);
    assert.deepEqual(requests.map(r=>r.modelId),lines.filter(l=>l[1]).map(l=>l[1]));
    assert.equal(requests.find(r=>r.modelId==='1831574').registration,'2022-12');
    assert.equal(requests.find(r=>r.modelId==='1832619').registration,'2023-01');
    assert.equal(requests.find(r=>r.modelId==='1950650').registration,'2025-01');
    assert.equal(requests.find(r=>r.modelId==='1132933').registration,'2017-11');
    assert.equal(requests.find(r=>r.modelId==='1950271').registration,'2025-02');
    assert.equal(requests.find(r=>r.modelId==='1848384').registration,'2023-08');
    assert.equal(requests.find(r=>r.modelId==='1778099').registration,'2023-04');
    assert.equal(board.snapshot().history.length,5);
  } finally { db.close(); }
});
