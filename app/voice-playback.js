// A single output channel shared by auditions and broadcasts; late file reads
// cannot resurrect a clip after stop, preview, disconnect or scene changes.
(function(root){
class VoicePlayer{
  constructor({load,play,report,now=Date.now,rng=Math.random}){
    Object.assign(this,{load,play,report,now,rng,auto:false,room:'',queue:[],last:{},rotation:{},token:0});
  }
  update(state){
    this.library=state;
    if(this.current?.scene && !state.scenes[this.current.scene]?.enabled)this.stop();
  }
  stop(clear=true){this.token++;this.cleanup?.();this.cleanup=null;this.current=null;if(clear)this.queue=[];this.report('')}
  setAuto(on){this.auto=on;this.stop();this.last={};this.introAt=this.now()+120000}
  live(room){if(this.room===room)return;this.room=room;if(!this.current?.preview)this.stop();this.queue=[];this.last={};this.introAt=this.now()+120000}
  pick(scene){
    const s=this.library.scenes[scene],ids=s.rows.map(r=>r.id);
    if(!ids.length)return;
    let r=this.rotation[scene],key=s.mode+ids.join('|');
    if(!r||r.key!==key)r=this.rotation[scene]={key,pos:0,bag:[],last:null};
    let id;
    if(s.mode==='random'){
      if(!r.bag.length){r.bag=ids.slice();
        for(let i=r.bag.length-1;i>0;i--){const j=Math.floor(this.rng()*(i+1));[r.bag[i],r.bag[j]]=[r.bag[j],r.bag[i]]}
        const end=r.bag.length-1;if(end>0 && r.bag[end]===r.last)[r.bag[0],r.bag[end]]=[r.bag[end],r.bag[0]];
      }
      id=r.bag.pop();
    }else id=ids[r.pos++%ids.length];
    r.last=id;return s.rows.find(x=>x.id===id);
  }
  cue(scene,room){
    const s=this.library?.scenes[scene],now=this.now();
    if(!this.auto||!this.room||room!==this.room||!s?.enabled||!s.rows.length)return;
    if(scene==='intro'&&(this.current||this.queue.length))return;
    const cooldown={welcome:30000,missing:15000,intro:120000,quote:0}[scene];
    if(now-(this.last[scene]??-Infinity)<cooldown)return;
    this.queue=this.queue.filter(x=>x.scene!==scene && x.until>now); // only newest outstanding cue of each kind
    this.queue.push({scene,until:now+({quote:20000,missing:10000,welcome:8000,intro:2000}[scene])});
    this.last[scene]=now;this.drain();
  }
  tick(){if(this.auto&&this.room&&this.now()>=this.introAt&&!this.current&&!this.queue.length){
    this.introAt=this.now()+120000;this.cue('intro',this.room)}}
  drain(){
    if(!this.auto||!this.room||this.current)return;
    const priority=['quote','missing','welcome','intro'];
    this.queue=this.queue.filter(x=>x.until>this.now()&&this.library?.scenes[x.scene]?.enabled)
      .sort((a,b)=>priority.indexOf(a.scene)-priority.indexOf(b.scene));
    while(this.queue.length){const {scene}=this.queue.shift(),item=this.pick(scene);
      if(item){void this.start(item,{scene});break}}
  }
  preview(item){this.stop();return this.start(item,{preview:true})}
  async start(item,tag){
    const t=++this.token;this.current={...tag,clip:item.clip};
    const done=(err)=>{if(t!==this.token)return;this.stop(false);if(err)this.report('播放失败：'+err);this.drain()};
    try{
      const bytes=await this.load(item.clip,item);if(t!==this.token)return;
      this.report((tag.preview?'试听：':'自动播报：')+item.text);
      this.cleanup=this.play(bytes,done,tag);
    }catch(err){done(err.message)}
  }
}
if(typeof module!=='undefined'&&module.exports)module.exports=VoicePlayer;else root.VoicePlayer=VoicePlayer;
})(globalThis);
