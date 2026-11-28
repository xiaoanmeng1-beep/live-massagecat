'use strict';
const {DatabaseSync}=require('node:sqlite');
class VoiceStore{
  constructor(file){
    this.file=file;this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS voice_source(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,seconds REAL NOT NULL,ref_text TEXT NOT NULL DEFAULT '',wav BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_scene_audio(clip TEXT PRIMARY KEY,wav BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_catalog(slot INTEGER PRIMARY KEY CHECK(slot=1),json TEXT NOT NULL);`);
  }
  read(){const r=this.db.prepare('SELECT json FROM voice_catalog WHERE slot=1').get();return r?JSON.parse(r.json):null}
  source(){return this.db.prepare('SELECT id,name,seconds,ref_text AS refText FROM voice_source WHERE slot=1').get()||null}
  replaceSource(id,name,seconds,wav){this.db.prepare("INSERT INTO voice_source VALUES(1,?,?,?,'',?) ON CONFLICT(slot) DO UPDATE SET id=excluded.id,name=excluded.name,seconds=excluded.seconds,ref_text='',wav=excluded.wav").run(id,name,seconds,wav)}
  sourceText(id,text){return this.db.prepare('UPDATE voice_source SET ref_text=? WHERE slot=1 AND id=?').run(text,id).changes===1}
  sourceAudio(id){const r=this.db.prepare('SELECT wav FROM voice_source WHERE slot=1 AND id=?').get(id);if(!r)throw Error('参考录音已更换');return Buffer.from(r.wav)}
  audio(id){const r=this.db.prepare('SELECT wav FROM voice_scene_audio WHERE clip=?').get(id);if(!r)throw Error('这条语音已失效');return Buffer.from(r.wav)}
  save(state,lookup,guard){
    const ids=new Set(Object.values(state.scenes).flatMap(s=>s.rows.map(r=>r.clip)));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      guard?.();
      const stored=new Set(this.db.prepare('SELECT clip FROM voice_scene_audio').all().map(r=>r.clip));
      const put=this.db.prepare('INSERT INTO voice_scene_audio(clip,wav) VALUES(?,?)'),drop=this.db.prepare('DELETE FROM voice_scene_audio WHERE clip=?');
      for(const id of ids)if(!stored.has(id))put.run(id,lookup(id));
      for(const id of stored)if(!ids.has(id))drop.run(id);
      this.db.prepare('INSERT INTO voice_catalog VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET json=excluded.json').run(JSON.stringify({...state,draft:null}));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  close(){this.db.close()}
}
module.exports=VoiceStore;
