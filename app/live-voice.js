'use strict';
(function(root){
const Base=typeof module!=='undefined'&&module.exports?require('./voice-playback'):root.VoicePlayer;
const segmenter=new Intl.Segmenter('zh',{granularity:'grapheme'});
function salutation(raw){
  const name=String(raw??'').trim();
  if(!name)return '老板';
  let first='',n=0;for(const {segment} of segmenter.segment(name)){first+=segment;if(++n===5)break}
  return first+'老板';
}
function under(n){
  const chars='零一二三四五六七八九',units=['','十','百','千'];let out='',zero=false;
  for(let i=3;i>=0;i--){const d=Math.floor(n/10**i)%10;if(!d){if(out)zero=true;continue}
    if(zero)out+='零';zero=false;out+=(d===1&&i===1&&!out?'':chars[d])+units[i]}
  return out;
}
function price(wan){
  const n=Math.round(wan*10000);
  if(!Number.isFinite(wan)||wan<=0||!Number.isSafeInteger(n)||n<1||n>=1e8)return '';
  const w=Math.floor(n/10000),low=n%10000;
  return w?((w===2?'两':under(w))+'万'+(low&&low<1000?'零':'')+under(low)):under(low);
}
const reasonLabels=Object.freeze({MULTIPLE_CARS:'不止一辆车',DATE:'年份不清',AMBIGUOUS_SERIES:'多个可能车型',MODEL_CONFLICT:'车名与型号矛盾',NO_SERIES:'车系未识别',NO_TRIM:'配置不匹配',NO_YEAR_MATCH:'年份无对应车款'});
function rowsForReason(rows,code){return Object.hasOwn(reasonLabels,code)?rows.filter(row=>row.reason===code):[]}
const templates=['{车系}，{价格}。','这台{车系}，参考价{价格}。','{车系}这台，大概{价格}。','这辆{车系}，收车大概{价格}。','{车系}，我这边看到的是{价格}。'];
class LivePlayer extends Base{
  constructor(opts){
    super(opts);this.synth=opts.synth;this.abort=opts.abort;this.ident=opts.ident||(()=>crypto.randomUUID());
    this.settings=opts.settings||(()=>({}));this.slots=[];this.lastId=null;this.joiners=[];this.idle=this.now();this.lastMissing=-Infinity;
    const play=this.play;this.play=(bytes,done,tag)=>{const token=this.token;return play(bytes,err=>{if(token!==this.token)return;if(!err)this.onEnd(tag);done(err)},tag)};
  }
  onEnd(tag){
    if(tag.slot&&tag.scene==='quote'&&!tag.slot.noTail&&this.slots.at(-1)===tag.slot && this.rng()<1/3){
      const tails=this.library.scenes.quote.rows.filter(r=>r.role==='tail');
      if(tails.length)this.tail={row:this.choose('tail',tails),slot:tag.slot};
    }
    if(tag.scene==='missing'&&this.miss===tag.miss){
      if(tag.nameOnly)tag.miss.follow=true;else this.miss=null;
    }
  }
  choose(key,rows){
    if(!rows.length)return null;
    const ids=rows.map(r=>r.id),signature=JSON.stringify(ids);
    const state=this.rotation[key]??={};
    if(state.signature!==signature||!state.bag?.length){
      state.signature=signature;state.bag=ids.slice();
      for(let i=ids.length-1;i>0;i--){const j=Math.floor(this.rng()*(i+1));[state.bag[i],state.bag[j]]=[state.bag[j],state.bag[i]]}
      const n=ids.length-1;if(n&&state.bag[n]===state.last)[state.bag[0],state.bag[n]]=[state.bag[n],state.bag[0]];
    }
    state.last=state.bag.pop();return rows.find(r=>r.id===state.last);
  }
  kill(r){if(!r)return;r.dead=true;r.bytes=null;if(r.pending)this.abort(r.key)}
  stop(clear=true){
    if(clear){for(const s of this.slots)this.kill(s);this.slots=[];this.kill(this.miss);this.miss=null;this.tail=null;this.joiners=[];this.lastId=null}
    this.idle=this.now();super.stop(clear);
  }
  live(room){if(this.room===room)return;this.stop();super.live(room);this.lastWelcome=this.lastMissing=-Infinity}
  update(state){
    this.library=state;
    const r=this.miss;
    if(r&&!rowsForReason(state.scenes.missing.rows,r.code).some(x=>x.id===r.custom.id&&x.clip===r.custom.clip)){
      if(this.current?.miss===r)this.stop(false);
      this.kill(r);this.miss=null;
    }
  }
  async prepare(entry,scene){
    entry.pending=true;
    try{const b=await this.synth(entry.text,entry.key,scene);if(!entry.dead&&b?.length)entry.bytes=b}
    catch(e){if(!entry.dead)this.report('已跳过本条播报：'+e.message)}
    finally{entry.pending=false;if(!entry.dead)this.drain()}
  }
  cue(scene,room,event={}){
    if(!this.auto||!room||room!==this.room)return;
    const now=this.now();
    if(scene==='comment'){if(this.joiners.length){this.welcomeComments=(this.welcomeComments||0)+1;this.drain()}return}
    if(scene==='admitted'){if(event.viewer&&this.miss?.viewer===event.viewer){if(this.current?.miss===this.miss)this.stop(false);this.kill(this.miss);this.miss=null}return}
    if(!this.library?.scenes[scene])return;
    if(scene==='welcome'){if(now-(this.lastWelcome??-Infinity)>=60000 && this.joiners.length<3){if(!this.joiners.length)this.welcomeComments=0;this.joiners.push(now)}this.drain();return}
    if(scene==='missing'){
      if(now-this.lastMissing<60000||this.current||this.slots.some(s=>s.pending||s.bytes))return;
      const clips=rowsForReason(this.library.scenes.missing.rows,event.code);
      if(!clips.length)return;
      this.kill(this.miss);
      const entry=this.miss={key:this.ident(),viewer:event.viewer,code:event.code,until:now+10000,
        custom:this.choose('missing-'+event.code,clips),text:salutation(event.name)+'，'};
      void this.prepare(entry,scene);return;
    }
    if(scene!=='quote'||event.id==null||event.id===this.lastId)return;
    const lo=price(event.low),hi=price(event.high);
    if(!lo||!hi||event.high<event.low||!String(event.series||'').trim())return;
    this.lastId=event.id;this.tail=null;this.kill(this.miss);this.miss=null;
    // Only the immediately preceding quote may remain. An unfinished older synth never queues in front.
    const prev=this.slots.at(-1);
    const overlap=!!prev&&(!!prev.bytes||this.current?.slot===prev);
    for(const s of this.slots){if(s!==prev||!overlap)this.kill(s)}
    if(this.current?.slot&&this.current.slot!==prev || this.current?.scene==='tail')this.stop(false);
    this.slots=overlap?[prev]:[];if(overlap)prev.noTail=true;
    const options=this.settings().templates?.length?this.settings().templates:templates;
    const at=this.choose('q-tpl',options.map((text,i)=>({text,id:i})));
    const entry={key:this.ident(),noTail:overlap,text:at.text.replaceAll('{车系}',()=>String(event.series)).replaceAll('{价格}',()=>lo===hi?lo:lo+'到'+hi)};
    this.slots.push(entry);void this.prepare(entry,scene);
  }
  speak(row,tag){void this.start(row,{...tag,words:row.text})}
  drain(){
    if(!this.room||!this.auto||!this.library)return;
    const now=this.now(),ready=this.slots.find(r=>r.bytes&&!r.dead);
    if(ready && ['intro','welcome','missing','tail'].includes(this.current?.scene))this.stop(false);
    if(this.miss&&!this.miss.started&&this.miss.until<=now){this.kill(this.miss);this.miss=null}
    if(this.current)return;
    if(ready){
      const bytes=ready.bytes;ready.bytes=null;
      this.speak({clip:ready.key,bytes,text:ready.text},{scene:'quote',slot:ready});return
    }
    if(this.tail){const t=this.tail;this.tail=null;this.speak(t.row,{scene:'tail',slot:t.slot});return}
    if(this.miss?.follow){const r=this.miss;r.follow=false;this.speak(r.custom,{scene:'missing',miss:r});return}
    this.joiners=this.joiners.filter(t=>now-t<=38000);
    if(this.joiners.length>=3 || this.joiners.length&&(this.welcomeComments>=3||now-this.joiners[0]>=30000)){
      this.joiners=[];const row=this.choose('welcome-stock',this.library.scenes.welcome.rows);
      if(row){this.lastWelcome=now;this.speak(row,{scene:'welcome'});return}
    }
    if(now-this.idle<3000)return;
    if(this.miss?.bytes){const r=this.miss;r.started=true;this.lastMissing=now;const b=r.bytes;r.bytes=null;
      this.speak({clip:r.key,text:r.text,bytes:b},{scene:'missing',miss:r,nameOnly:true});return}
    if(this.miss?.pending)return;
    {
      const row=this.choose('intro-stock',this.library.scenes.intro.rows);
      if(row)this.speak(row,{scene:'intro'});
    }
  }
  tick(){this.drain()}
}
const out={LivePlayer,salutation,price,reasonLabels,rowsForReason,templates};
if(typeof module!=='undefined'&&module.exports)module.exports=out;else root.LiveVoices=out;
})(globalThis);
