'use strict';
const KEY='quote.pool.v1',ROUND=20;
const key=a=>a.provider+':'+a.id;
function interleave(accounts){
  const groups=['che300','guazi'].map(p=>accounts.filter(a=>a.provider===p)),out=[];
  for(let i=0;i<Math.max(...groups.map(g=>g.length),0);i++)for(const group of groups)if(group[i])out.push(group[i]);
  return out;
}
class QuoteAccountPool {
  constructor({store,list,activate,request,cache,count,change=()=>{},log=()=>{}}){
    Object.assign(this,{store,list,activate,request,cache,count,change,log});
    this.state=store.getSetting(KEY,{current:'',used:0});
    this.revision=Number(this.state.revision)||0;
  }
  ready(provider){return interleave(this.list().filter(a=>(!provider||a.provider===provider)&&a.status==='authenticated'&&!a.deleting&&!(a.cooldownUntil>Date.now())));}
  snapshot(){return {...this.state,revision:this.revision,roundSize:ROUND,accounts:interleave(this.list()).map(a=>({provider:a.provider,id:a.id,label:a.label,status:a.status,current:key(a)===this.state.current}))};}
  save(){this.state.revision=++this.revision;this.store.setSetting(KEY,this.state);this.change(this.snapshot());}
  choose(a){if(!a)return;this.activate(a);if(this.state.current!==key(a)){this.state={current:key(a),used:0};this.save();}}
  select(provider,id){
    const account=this.ready(provider).find(a=>a.id===id);
    if(!account)throw Error('该账号尚未登录或待验证，请先完成登录验证');
    this.choose(account);return this.snapshot();
  }
  advance(current,provider){
    const all=this.ready(provider),i=all.findIndex(a=>key(a)===key(current));
    const next=all[(i+1+all.length)%all.length];
    if(next&&key(next)!==key(current)){this.choose(next);this.log('报价账号轮换',{from:current.provider,to:next.provider});return true;}
    return false;
  }
  async run(input,scope,{provider}={}){
    scope?.check();
    let all=this.ready(provider),selected=all.find(a=>key(a)===this.state.current)||all[0];
    const selectedProvider=provider||selected?.provider||this.state.current.split(':')[0]||'che300';
    // Quote identity is the vehicle + registration + region + mileage, not
    // whichever login is current. Look in both LOCAL provider caches before
    // choosing a session; this does not call another platform's quote API.
    if(!input.forceRefresh){
      const providers=provider?[provider]:[...new Set([selectedProvider,'che300','guazi'])];
      for(const cachedProvider of providers){
        const cached=await this.cache(cachedProvider,input);
        if(cached)return {...cached,cached:true,provider:cachedProvider};
      }
    }
    if(!selected){
      if(this.list().some(a=>(!provider||a.provider===provider)&&a.status==='verification-required'))
        return {ok:false,code:'CAPTCHA_REQUIRED',message:'请在右侧完成瓜子滑块验证'};
      return {ok:false,code:'AUTH_REQUIRED',message:'请先登录一个可用的报价账号'};
    }
    this.choose(selected);
    if(this.state.used>=ROUND && this.advance(selected,provider))selected=this.ready(provider).find(a=>key(a)===this.state.current);
    const attempted=new Set();
    while(selected&&!attempted.has(key(selected))){
      const providerUsed=selected.provider;
      attempted.add(key(selected));scope?.check();
      const before=this.count(selected);let result;
      try{result=await this.request(selected,input,scope);}
      finally{
        const n=Math.max(0,this.count(selected)-before);
        if(n){this.state.used+=n;this.save();}
      }
      // A price/catalog miss does not trigger another platform. Explicit rate
      // limits stop this run rather than bouncing requests between identities.
      if(['RATE_LIMITED','CAPTCHA_REQUIRED'].includes(result?.code))return {...result,provider:selected.provider};
      if(result?.code==='AUTH_REQUIRED'||result?.code==='NO_ACCOUNT'){
        selected=this.ready(provider).find(a=>!attempted.has(key(a)));
        if(selected){this.choose(selected);continue;}
      }else if(this.state.used>=ROUND)this.advance(selected,provider);
      return {...result,provider:result?.provider||providerUsed};
    }
    return {ok:false,code:'AUTH_REQUIRED',message:'没有可用的登录账号'};
  }
}
module.exports={QuoteAccountPool,interleave,ROUND};
