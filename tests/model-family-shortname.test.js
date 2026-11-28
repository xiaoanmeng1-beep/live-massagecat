'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('node:path');
const {makeParser}=require('../live-parser');
const {DataStore}=require('../data-store');

const today=()=>new Date('2026-11-26T12:00:00+08:00');
const db=new DatabaseSync(resolve(__dirname,'../app/catalog-seed.sqlite'),{readOnly:true});
const parse=makeParser(db,{today});

test('品牌加单字母车系和全轮驱动：2023 Model Y，不落入 Model Y L',()=>{
  for(const text of [
    '23年特斯拉y四驱16万公里 一个门子更换',
    '23年特斯拉Y四驱16万公里',
    '23年特斯拉Model Y四驱16万公里',
    '23年特斯拉MODEL Y全轮驱动16万公里',
    '23年特斯拉ModelY四驱16万公里'
  ]){
    const result=parse({text});
    assert.ok(result.ok,text+': '+result.reason);
    assert.equal(result.job.input.modelId,'1870951',text);
    assert.equal(result.job.input.registration,'2023-01',text);
    assert.equal(result.job.input.mileage,16,text);
    assert.match(result.job.car,/2023款 Model Y 长续航全轮驱动版/);
  }
  const withoutDrive=parse({text:'23年特斯拉Model Y 16万公里'});
  assert.ok(withoutDrive.ok,withoutDrive.reason);
  assert.match(withoutDrive.job.car,/2023款 Model Y (?!L)/);
  assert.equal(withoutDrive.job.input.registration,'2023-01');
});

test('明确的后驱和 Model Y L 保持区别；单字母不得跨品牌或吞掉另一个字母',()=>{
  const rear=parse({text:'23年特斯拉Y后驱16万公里'});
  assert.match(rear.job?.car,/2023款 Model Y 后轮驱动版/);
  const long=parse({text:'25年特斯拉Model Y L四驱2万公里'});
  assert.match(long.job?.car,/2025款 Model Y L 长续航全轮驱动版/);
  for(const text of ['23年Y四驱16万公里','23年特斯拉YL四驱16万公里','23年特斯拉Yellow四驱16万公里'])
    assert.notEqual(parse({text}).job?.input.modelId,'1870951',text);
});

test('目录驱动：其它品牌的多词单字母车系和长后缀也按完整写法区分',()=>{
  const store=new DataStore(':memory:');
  try{
    store.replaceBrands('passenger',[{id:'b',name:'极川',initial:'J'}]);
    store.replaceSeries('passenger','b',[
      {id:'z',name:'Atlas Z'},{id:'zl',name:'Atlas Z L'}]);
    store.replaceModels('passenger','b','z',[
      {id:'z1',year:'2023',name:'2023款 Atlas Z 长续航全轮驱动版',minRegistrationYear:'2023',maxRegistrationYear:'2026'},
      {id:'z2',year:'2023',name:'2023款 Atlas Z 后轮驱动版',minRegistrationYear:'2023',maxRegistrationYear:'2026'}]);
    store.replaceModels('passenger','b','zl',[
      {id:'zl1',year:'2025',name:'2025款 Atlas Z L 长续航全轮驱动版',minRegistrationYear:'2025',maxRegistrationYear:'2026'}]);
    store.replaceRegions([{id:'20',name:'广东',cities:[{id:'20',name:'广州'}]}]);
    const local=makeParser(store.db,{today});
    for(const text of ['23年极川Z四驱16万公里','23年极川Atlas Z四驱16万公里'])
      assert.equal(local({text}).job?.input.modelId,'z1',text);
    assert.equal(local({text:'25年极川Atlas Z L四驱2万公里'}).job?.input.modelId,'zl1');
    assert.notEqual(local({text:'极川ZL四驱16万公里'}).job?.input.modelId,'z1');
  }finally{store.db.close();}
});
