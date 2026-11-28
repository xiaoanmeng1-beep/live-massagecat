'use strict';

// One small, shared recursive regression. Provider and platform vehicle IDs are
// audit metadata, never input features. Its predictions never enter QuoteBoard.
const SIZE = 48, MAX_SAMPLES = 10000, KEY = 'shadow.regression.v1';
const clamp = (x,a,b) => Math.min(b,Math.max(a,x));
const freshState=()=>({weights:Array(SIZE).fill(0),matrix:Array.from({length:SIZE*SIZE},(_,i)=>i%(SIZE+1)===0?10:0),count:0,error:0,width:0.15});
function fit(s,x,low,high) {
  const mid=(low+high)/2,pred=x.reduce((n,f,i)=>n+f*s.weights[i],0),prediction=s.count>=30?Math.exp(clamp(pred,-5,8)):null;
  const px=x.map((_,i)=>x.reduce((n,f,j)=>n+s.matrix[i*SIZE+j]*f,0));
  const den=1+x.reduce((n,f,i)=>n+f*px[i],0),k=px.map(n=>n/den);
  const delta=s.count?clamp(Math.log(mid)-pred,-1.5,1.5):Math.log(mid)-pred;
  return {...s,weights:s.weights.map((w,i)=>w+k[i]*delta),
    matrix:s.matrix.map((p,ij)=>p-k[Math.floor(ij/SIZE)]*px[ij%SIZE]),count:s.count+1,
    width:s.width*0.98+((high-low)/(2*mid))*0.02,
    error:prediction?s.error*0.98+Math.min(2,Math.abs(prediction-mid)/mid)*0.02:s.error};
}
function hash(s) { let h=2166136261; for (const ch of s) h=Math.imul(h^ch.charCodeAt(0),16777619); return h>>>0; }
function features(v, input, at) {
  const price = Number.parseFloat(v.catalogPrice), mileage=Number(input.mileage);
  const date = /^(\d{4})-(\d{1,2})$/.exec(input.registration || '');
  if (!date || !Number.isFinite(mileage) || mileage<=0) return null;
  const age=clamp((at/86400000-Date.UTC(+date[1],+date[2]-1,1)/86400000)/365.25,0,40);
  const x=Array(SIZE).fill(0),name=(v.name||'').toLowerCase();
  x[0]=1;x[1]=price>0?Math.log(price):0;x[2]=price>0?1:0;
  x[3]=age/10;x[4]=age*age/400;x[5]=Math.log1p(mileage)/4;x[6]=mileage/50;
  x[7]=age*Math.log1p(mileage)/40;
  x[8]=/纯电|电动|ev\b|model\s*[3ysx]/.test(name)?1:0;
  x[9]=/混动|双擎|插电|增程|phev|dm-i/.test(name)?1:0;
  x[10]=Number(name.match(/(\d\.\d)\s*[tl]/)?.[1]||0)/5;
  x[11]=(new Date(at).getUTCFullYear()-2025)/10;
  for (const [s,offset,size] of [[v.brandName||'',12,12],[v.seriesName||'',24,12],[v.cityName||'',36,4]])
    if(s)x[offset+hash(s)%size]=1;
  for(const s of name.match(/豪华|舒适|尊贵|旗舰|手动|四驱|运动|自动/g)||[])x[40+hash(s)%8]=1;
  return x;
}
class QuoteLearning {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS shadow_samples (
      sample_key TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, features TEXT NOT NULL,
      actual_low REAL NOT NULL, actual_high REAL NOT NULL, predicted_mid REAL,
      relative_error REAL
    ); CREATE INDEX IF NOT EXISTS shadow_sample_time ON shadow_samples(observed_at);`);
    const saved=store.getSetting(KEY,null);
    this.state=saved?.weights?.length===SIZE && saved?.matrix?.length===SIZE*SIZE ? saved : freshState();
  }
  predict(v,input,at=Date.now()) {
    const x=features(v,input,at),s=this.state;
    if(!x || s.count<30)return null;
    const mid=Math.exp(clamp(x.reduce((n,f,i)=>n+f*s.weights[i],0),-5,8));
    const width=clamp(Math.max(s.width,s.error),0.05,0.8);
    return {low:mid*(1-width),high:mid*(1+width),mid,shadow:true};
  }
  observe(v,input,result,key) {
    if(!result?.ok || result.cached || result.historicalFallback)return false;
    const {low,high}=result.prices?.good||{},at=result.fetchedAt||Date.now();
    if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<low)return false;
    const x=features(v,input,at);
    if(!x || this.store.db.prepare('SELECT 1 FROM shadow_samples WHERE sample_key=?').get(key))return false;
    const prediction=this.predict(v,input,at),mid=(low+high)/2,next=fit(this.state,x,low,high);
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO shadow_samples VALUES (?,?,?,?,?,?,?)').run(key,at,JSON.stringify(x),low,high,
        prediction?.mid??null,prediction?Math.abs(prediction.mid-mid)/mid:null);
      this.store.db.exec(`DELETE FROM shadow_samples WHERE rowid IN
        (SELECT rowid FROM shadow_samples ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ${MAX_SAMPLES})`);
      this.store.setSetting(KEY,next);
    });
    this.state=next;
    return true;
  }
  invalidate(keys) {
    let next;
    this.store.transaction(()=>{
      const remove=this.store.db.prepare('DELETE FROM shadow_samples WHERE sample_key=?');let count=0;
      for(const key of keys)count+=Number(remove.run(key).changes);
      if(!count)return;
      next=freshState();
      for(const row of this.store.db.prepare('SELECT features,actual_low,actual_high FROM shadow_samples ORDER BY observed_at,rowid').iterate())
        next=fit(next,JSON.parse(row.features),row.actual_low,row.actual_high);
      this.store.setSetting(KEY,next);
    });
    if(next)this.state=next;
  }
}
module.exports={QuoteLearning,features,MAX_SAMPLES};
