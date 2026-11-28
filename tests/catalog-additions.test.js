'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyCatalogAdditions } = require('../catalog-additions');
const patch = require('../catalog-additions.json');

test('目录补丁父级完整、可重复导入，不覆盖已有配置',()=>{
  const db=new DatabaseSync(':memory:');
  const filename=require('node:path').resolve(__dirname,'../app/catalog-seed.sqlite');
  db.prepare("ATTACH DATABASE ? AS seed").run('file:'+filename+'?mode=ro');
  for(const name of ['brands','series','models','metadata']){
    db.exec(db.prepare('SELECT sql FROM seed.sqlite_master WHERE type=? AND name=?').get('table',name).sql);
    if(name!=='metadata')db.exec('INSERT INTO main.'+name+' SELECT * FROM seed.'+name);
  }
  const row=patch.models[0];
  applyCatalogAdditions(db);
  db.prepare('UPDATE models SET name=? WHERE (category,brand_id,series_id,id)=(?,?,?,?)').run('已有配置',...row.slice(0,4));
  assert.deepEqual(applyCatalogAdditions(db),{brands:0,series:0,models:0});
  assert.equal(db.prepare('SELECT name FROM models WHERE (category,brand_id,series_id,id)=(?,?,?,?)').get(...row.slice(0,4)).name,'已有配置');
  for(const entry of patch.empty.filter(r=>r[2])){
    assert.equal(entry[4],'empty');
  }
  db.close();
});
