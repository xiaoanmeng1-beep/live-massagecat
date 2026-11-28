// Validate durable audio without opening the application or invoking TTS.
'use strict';
const {DatabaseSync}=require('node:sqlite'),p=require('node:path'),a=require('node:assert/strict');
const db=new DatabaseSync(p.resolve(__dirname,'../data/valuation.sqlite'),{readOnly:true});
const state=JSON.parse(db.prepare('SELECT json FROM voice_catalog WHERE slot=1').get().json);
const ids=new Set(Object.values(state.scenes).flatMap(s=>s.rows.map(r=>r.clip)));
const rows=db.prepare('SELECT clip,length(wav) AS bytes,hex(substr(wav,9,4)) AS kind FROM voice_scene_audio').all();
a.deepEqual(new Set(rows.map(r=>r.clip)),ids);a.ok(rows.every(r=>r.bytes>44&&r.kind==='57415645'));
console.log('fixed WAVs:',rows.length,'source:',db.prepare('SELECT name,length(wav) AS bytes FROM voice_source WHERE slot=1').get()||'尚未上传');db.close();
