'use strict';
const patch = require('./catalog-additions.json');

function applyCatalogAdditions(db) {
  const levels = [
    ['brands','category,id,name,initial','category,id',2],
    ['series','category,brand_id,id,name','category,brand_id,id',3],
    ['models','category,brand_id,series_id,id,year,name,min_registration_year,max_registration_year,catalog_price','category,brand_id,series_id,id',4]
  ];
  const counts = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table,fields,key,n] of levels) {
      const insert = db.prepare(`INSERT INTO ${table}(${fields}) VALUES(${fields.split(',').map(()=>'?').join(',')}) ON CONFLICT(${key}) DO NOTHING`);
      const select = db.prepare(`SELECT name FROM ${table} WHERE ${key.split(',').map(c=>c+'=?').join(' AND ')}`);
      counts[table] = 0;
      for (const row of patch[table]) {
        if (table !== 'brands') {
          const parentTable = table === 'series' ? 'brands' : 'series';
          const columns = table === 'series' ? ['category','id'] : ['category','brand_id','id'];
          if (!db.prepare(`SELECT 1 FROM ${parentTable} WHERE ${columns.map(c=>c+'=?').join(' AND ')}`).get(...row.slice(0,n-1))) {
            throw Error('车型目录父级缺失：'+row.slice(0,n).join('/'));
          }
        }
        counts[table] += Number(insert.run(...row).changes);
        if (!select.get(...row.slice(0,n))) throw Error('车型目录写入复查失败：'+table);
      }
    }
    if(Object.values(counts).some(Boolean)) db.prepare("INSERT INTO metadata(key,updated_at) VALUES('verified-catalog-additions',?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at").run(Date.now());
    db.exec('COMMIT');
    return counts;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { applyCatalogAdditions };
