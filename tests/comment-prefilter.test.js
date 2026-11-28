'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser,QuoteBoard,attemptLiveMatch}=require('../live-board');

test('纯数字、泛问价、单独车况追问和超长文在查车型库前直接忽略',()=>{
  let reads=0;
  const parse=makeParser({prepare:()=>({get(){reads++;throw Error('不应读取目录');}})});
  for(const text of ['可以收吗','那要是换过气囊呢','如果换过变速箱还能收吗',
    '多少','主播，多少收？','５７',' 57.08？','？！','讲故事。'.repeat(132)+'宝马C200 多少钱']){
    assert.equal(parse({text}).ignored,true,text);
  }
  assert.equal(reads,0);
});

test('只有品牌、地区或无车型的聊天不进候选，真实车系或待排查线索保留',t=>{
  const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
  t.after(()=>db.close());
  const parse=makeParser(db,{today:()=>new Date(2026,10,25)});
  const board=new QuoteBoard({quote:async ()=>({ok:true,prices:{good:{low:1,high:2}}}),holdMs:0});
  for(const text of ['劳斯莱斯汽车 天津','天津市，劳斯莱斯汽车','广州市 别克汽车','本田汽车 上海',
    '这台开着舒服吗','11万公里多少钱','2019年毕业啦大家晚上好','我家换了wifi6路由器']){
    assert.equal(attemptLiveMatch(parse,board,{text},()=>assert.fail('无效评论不应入队')).ignored,true,text);
  }
  for(const text of ['思域多少钱','轩逸','理想L8Pro','14年朗逸手动风尚，14万公里',
    '19年思域6万公里，换过气囊还能收吗','22年23款速腾 1.4t 14万公里 小剐蹭']){
    assert.equal(parse({text}).ok,true,text);
  }
  for(const [text,code] of [
    ['2020奔驰C999L 时尚版 多少钱','NO_SERIES'],
    ['雷克萨斯nx999 23年，创驰，白色5万公里','NO_SERIES'],
    ['2017本田10代1.0T 十三万 公里 出多少钱？','NO_SERIES'],
    ['23年小鹏某款 5万公里','NO_SERIES'],
    ['2013年C5，1600kg，多少钱？','AMBIGUOUS_SERIES'],
    ['比亚迪17年混动19万公里多少钱','NO_SERIES'],
    ['朗逸和陆风风尚','AMBIGUOUS_SERIES']
  ]){
    const r=parse({text});
    assert.equal(r.code,code,text);assert.notEqual(r.ignored,true,text);
  }
});
