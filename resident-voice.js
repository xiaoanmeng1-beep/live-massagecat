'use strict';
const {spawn}=require('node:child_process'),path=require('node:path'),readline=require('node:readline');
const interrupted=()=>Object.assign(Error('已取消'),{cancelled:true});
class Lane{
  constructor(lib,notify){this.lib=lib;this.notify=notify;this.child=null;this.job=null;this.loaded=null}
  start(){
    if(this.child)return;
    const script=path.join(__dirname,'app','tts','resident.py').replace(/\.asar([/\\])/i,'.asar.unpacked$1');
    const c=spawn(this.lib.python(),['-B','-u',script,this.lib.engine],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=c;let errors='';
    c.stderr.on('data',d=>{errors=(errors+d).slice(-1200)});c.stdin.on('error',()=>{});
    const lost=()=>{if(this.child!==c)return;this.child=null;this.loaded=null;this.finish(Error(errors.trim().split('\n').pop()||'本地语音进程已退出'))};
    c.on('error',lost);c.on('exit',lost);
    readline.createInterface({input:c.stdout}).on('line',line=>{
      if(this.child!==c)return;let m;try{m=JSON.parse(line)}catch{return}
      const job=this.job;if(!job||job.req.id!==m.id)return;
      if(m.stage){if(!job.cancelled&&!job.yielded)job.progress?.(m.stage,m.tokens);return}
      if(m.cancelled||job.cancelled)this.finish(interrupted());
      else if(m.error)this.finish(Error(m.error));
      else{this.loaded=job.req.engine;this.finish(null,m.wav?Buffer.from(m.wav,'base64'):null)}
    });
  }
  begin(job){
    this.job=job;
    try{this.start();if(this.loaded!==job.req.engine)this.loaded=null;
      this.timer=setTimeout(()=>this.child?.kill('SIGKILL'),360000);this.timer.unref();
      this.child.stdin.write(JSON.stringify(job.req)+'\n');
    }catch(e){this.finish(e)}
  }
  finish(err,bytes){const job=this.job;if(!job)return;this.job=null;clearTimeout(this.timer);this.notify(job,err,bytes)}
  abort(){if(this.job)this.child?.stdin.write(JSON.stringify({cancel:this.job.req.id})+'\n')}
  close(){clearTimeout(this.timer);this.job=null;const c=this.child;this.child=null;this.loaded=null;c?.stdin.end();c?.kill('SIGTERM')}
}
class ResidentVoice{
  constructor(lib,{makeLane=notify=>new Lane(lib,notify),idleMs=30000}={}){
    this.makeLane=()=>makeLane((j,e,b)=>this.done(j,e,b));this.lanes=[this.makeLane()];this.queue=[];this.idleMs=idleMs;this.closed=false;
  }
  get child(){return this.lanes[0]?.child}
  get active(){return this.lanes.find(l=>l.job)?.job}
  run(req,priority,progress){
    if(this.closed)return Promise.reject(interrupted());
    if(req.warm&&this.lanes.some(l=>l.loaded===req.engine&&!l.job))return Promise.resolve(null);
    return new Promise((resolve,reject)=>{this.queue.push({req,priority,progress,resolve,reject});this.pump()});
  }
  pump(){
    if(this.closed)return;
    clearTimeout(this.idleTimer);this.queue.sort((a,b)=>a.priority-b.priority);
    while(this.queue.length){
      const first=this.queue[0];
      const warming=this.lanes.some(l=>l.job?.req.warm&&l.job.req.engine===first.req.engine);
      let lane=this.lanes.find(l=>!l.job&&l.loaded===first.req.engine)||this.lanes.find(l=>!l.job);
      // A warm-up followed by a single task isn't a backlog of independent clips.
      if(!lane&&this.lanes.length===1&&!first.req.warm&&!warming&&!this.lanes[0].job.cancelled){
        lane=this.makeLane();this.lanes.push(lane);
      }
      if(!lane){
        if(first.priority===0&&this.lanes.length===2&&!this.lanes.some(l=>l.job?.yielded||l.job?.cancelled)){
          const busy=this.lanes.filter(l=>l.job&&!l.job.req.warm&&l.job.priority>0).sort((a,b)=>b.job.priority-a.job.priority)[0];
          if(busy){busy.job.yielded=true;busy.job.progress?.('waiting',0);busy.abort()}
        }
        break;
      }
      lane.begin(this.queue.shift());
    }
    if(this.lanes.length>1&&!this.lanes[1].job&&!this.queue.length){
      this.idleTimer=setTimeout(()=>{if(this.lanes.length===2&&!this.lanes[1].job&&!this.queue.length)this.lanes.pop().close()},this.idleMs);
      this.idleTimer.unref();
    }
  }
  done(job,error,bytes){
    if(job.yielded&&!job.cancelled&&!this.closed&&error?.cancelled){job.yielded=false;this.queue.push(job)}
    else if(job.cancelled)job.reject(interrupted());else if(error)job.reject(error);else job.resolve(bytes);
    this.pump();
  }
  cancel(id){
    const i=this.queue.findIndex(j=>j.req.id===id);if(i>=0){this.queue.splice(i,1)[0].reject(interrupted());this.pump();return}
    const lane=this.lanes.find(l=>l.job?.req.id===id);if(lane&&!lane.job.cancelled){lane.job.cancelled=true;lane.abort()}
  }
  close(){if(this.closed)return;this.closed=true;clearTimeout(this.idleTimer);
    for(const job of this.queue.splice(0))job.reject(interrupted());
    for(const lane of this.lanes){lane.job?.reject(interrupted());lane.close()}
  }
}
module.exports=ResidentVoice;
