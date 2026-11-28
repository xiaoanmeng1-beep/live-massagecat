'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser,QuoteBoard}=require('../live-board');
const {DataStore}=require('../data-store');
const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const parse=makeParser(db);

test('购车议价前置、后置、带万元；保留尾标、真正排量与里程',()=>{
  const vehicle='21年上牌gl8，652t豪华.2户，11万公里';
  for(const text of [vehicle+'，7.9这个价格还能砍吗？','开价7.9万，'+vehicle,
    '7.9万能买吗，'+vehicle,vehicle+'，7.9万元贵吗']) {
    const result=parse({text});
    assert.deepEqual(result.job?.input,{modelId:'1535468',registration:'2021-01',mileage:11,provinceId:'20',cityId:'20'},text);
  }
  assert.equal(parse({text:vehicle.replace('652t','999t')+'，7.9这个价'}).code,'NO_TRIM');
  assert.equal(parse({text:'开价7.9万，16年缤智1.8 15万公里'}).job?.input.modelId,'29208');
  assert.equal(parse({text:'雅阁幻夜尊贵7w还值多少'}).job?.input.mileage,7);
});

test('动力与里程保留词边界，不把T加后面的十万公里拼成另一车系；真正车型和双车仍保留',()=>{
  for(const suffix of ['2.t 10万公里','2. T 10万公里','2.0T 10万公里','T 10万公里','t 10 w公里']){
    const text='18年上牌 18款宝马x1 '+suffix,result=parse({text});
    assert.equal(result.ok,true,text+': '+result.reason);
    assert.match(result.job.car,/2018款 宝马X1 /,text);assert.doesNotMatch(result.job.car,/进口|T10/);
    assert.equal(result.job.input.registration,'2018-01');assert.equal(result.job.input.mileage,10);
  }
  assert.equal(parse({text:'19年途岳2.t 10万公里'}).job?.input.modelId,parse({text:'19年途岳2.0t 10万公里'}).job?.input.modelId);
  assert.match(parse({text:'宝马X 3 2020年3万公里'}).job?.car,/2020款 宝马X3/);
  assert.match(parse({text:'金杯T10 2018年10万公里'}).job?.car,/金杯T10/);
  assert.match(parse({text:'宝马X1进口 10万公里'}).job?.car,/宝马X1\(进口\)/);
  assert.notEqual(parse({text:'T 10万公里'}).ok,true);
  for(const text of ['宝马X1和金杯T10 18年10万公里','宝马X1 金杯T10 18年10万公里'])
    assert.equal(parse({text}).code,'AMBIGUOUS_SERIES',text);
});

test('临时新增品牌车系同样适用词边界和动力规范化，没有宝马或单条评论特判',()=>{
  const store=new DataStore(':memory:');try{
    store.replaceBrands('passenger',[{id:'801',name:'试验品牌',initial:'S'},{id:'802',name:'货运品牌',initial:'H'}]);
    store.replaceSeries('passenger','801',[{id:'811',name:'星际Z8'}]);store.replaceSeries('passenger','802',[{id:'812',name:'T10'}]);
    store.replaceModels('passenger','801','811',[
      {id:'821',name:'2018款 星际Z8 1.5T 豪华版',year:'2018',minRegistrationYear:'2018',maxRegistrationYear:'2026'},
      {id:'822',name:'2018款 星际Z8 2.0T 豪华版',year:'2018',minRegistrationYear:'2018',maxRegistrationYear:'2026'}]);
    store.replaceModels('passenger','802','812',[{id:'823',name:'2018款 T10 舒适版',year:'2018',minRegistrationYear:'2018',maxRegistrationYear:'2026'}]);
    store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);const p=makeParser(store.db);
    for(const text of ['18年试验品牌 星际Z8 2.t 10万公里','18年星际Z8 2.0T 10万公里']){
      const r=p({text});assert.equal(r.job?.input.modelId,'822',r.reason);assert.equal(r.job.input.mileage,10);
    }
    assert.equal(p({text:'T 10万公里'}).ok,false);
    assert.equal(p({text:'18年货运品牌T10 10万公里'}).job?.input.modelId,'823');
    assert.equal(p({text:'18年试验品牌星际Z8和货运品牌T10 10万公里'}).code,'AMBIGUOUS_SERIES');
  }finally{store.db.close();}
});

test('细分款与同名车系按上下文区分；明确第二个品牌、并列或无主车系时均不入队',()=>{
  for(const text of ['14年朗逸手动风尚，14万公里','14年大众朗逸 手动 风尚版 14万公里']){
    assert.deepEqual(parse({text}).job?.input,{modelId:'4157',registration:'2014-01',mileage:14,provinceId:'20',cityId:'20'},text);
  }
  for(const text of ['朗逸和陆风风尚','朗逸 陆风风尚','朗逸和风尚','朗逸/风尚','14年手动风尚，14万公里','12年赛欧，手动挡']) {
    assert.equal(parse({text}).code,'AMBIGUOUS_SERIES',text);
  }
});

// Minimal replay DOM. Line breaks reflect adjacent block elements; identities
// are deliberately rebuilt at every tick to simulate a rerendered chat panel.
function el(...children){
  const e={nodeType:1,getAttribute(k){return this.attrs?.[k]||null;},
    get innerText(){return this.childNodes.map(ch=>ch.nodeValue??ch.innerText).join(' ');}};
  e.childNodes=children.map(v=>typeof v==='string'?{nodeType:3,nodeValue:v}:v);
  for(const c of e.childNodes)c.parentElement=e;
  return e;
}
test('进场+评论+滚动进场的 DOM 连续回放：一条询价只请求一次，不吞他人同文',async()=>{
  const {collectChatRows,diffNew,parseChatLine}=await import('../douyin-bridge-service.mjs');
  const body='17别克威朗 1.5自吸 8.6万公里', seen=new Set(),req=[],people=[];
  const board=new QuoteBoard({quote:async input=>{req.push(input);return {ok:true,prices:{good:{low:1,high:2}}};},pause:async()=>{}});
  const join=n=>el(el(n),el('来了'));
  const comment=n=>el(el(n+'：'),el(body));
  function tick(...children) {
    for(const {key,line} of diffNew(collectChatRows(el(...children)),seen)){
      const ev=parseChatLine(line);
      if(ev?.kind!=='comment')continue;
      const r=parse({id:people.length+1,eventId:key,name:ev.name,text:ev.text});
      assert.equal(ev.text,body);assert.equal(r.ok,true);people.push(ev.name);board.add(r.job);
    }
  }
  tick(join('食咪个'));
  for(const who of ['超*****','诚*****','Y*****','富*****'])
    tick(el(join('食咪个'),comment('可*****')),join(who));
  assert.deepEqual(people,['可*****']);
  tick(comment('可*****'),comment('张*****'),join('富*****')); // last notice is already seen
  await new Promise(setImmediate);
  assert.deepEqual(people,['可*****','张*****']);
  assert.deepEqual(req.map(r=>[r.modelId,r.mileage]),[['32747',8.6],['32747',8.6]]);
  assert.equal(board.snapshot().history.length,2);
});

test('独立消息 ID、落单的昵称、正文里的来了和冒号',async()=>{
  const {collectChatRows,diffNew}=await import('../douyin-bridge-service.mjs');
  const mk=id=>{const row=el(el('可*****：'),el('我来了'));row.attrs={'data-message-id':id};return row;};
  const list=el(el(mk('m1')),el(mk('m2')),el('张*****：'),el('李*****：公里数：11万'));
  const rows=collectChatRows(list);
  assert.deepEqual(rows.map(r=>r.line),['可*****：我来了','可*****：我来了','李*****：公里数：11万']);
  const seen=new Set();
  assert.deepEqual(diffNew(rows,seen).map(r=>r.key),['id:m1','id:m2','text:李*****：公里数：11万']);
  assert.deepEqual(diffNew(rows,seen),[]);
});
