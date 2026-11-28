'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {DatabaseSync}=require('node:sqlite');
const {DataStore}=require('./data-store');

function field(value) {
  let s=String(value??'');
  // CSV quoting alone doesn't stop Excel interpreting viewer text as a formula.
  if (/^[\s\uFEFF]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}

async function exportMatchFailures(source,destination) {
  const db=new DatabaseSync(source,{readOnly:true});
  const temp=path.join(path.dirname(destination),'.match-failures-'+randomUUID()+'.tmp');
  let count=0,started=false;
  try {
    db.exec('BEGIN');
    if(!db.prepare('SELECT 1 FROM live_match_failures LIMIT 1').get())return {count:0};
    const stmt=db.prepare(DataStore.failureSelect+' ORDER BY f.comment_id DESC');
    async function* content() {
      yield '\uFEFF时间,直播间,观众昵称,评论内容,失败原因,原因代码\r\n';
      let chunk='';
      for(const r of stmt.iterate()) {
        chunk += [new Date(r.receivedAt).toLocaleString('sv-SE',{hour12:false}),r.room,r.name,r.text,r.reason,r.code].map(field).join(',')+'\r\n';
        if(++count%256===0) {yield chunk;chunk='';await new Promise(setImmediate);}
      }
      if(chunk)yield chunk;
    }
    started=true;
    await pipeline(Readable.from(content()),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
    await fs.promises.rename(temp,destination);
    return {count};
  } finally {
    db.close();
    if(started)await fs.promises.rm(temp,{force:true});
  }
}
module.exports={exportMatchFailures};
