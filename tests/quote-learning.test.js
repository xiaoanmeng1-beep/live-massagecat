'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {DataStore}=require('../data-store');const {QuoteLearning,features}=require('../quote-learning');
const vehicle={name:'2019款 思域 1.5T 自动豪华',brandName:'本田',seriesName:'思域',catalogPrice:'13.99万',cityName:'广州'};
const input={mileage:6,registration:'2019-01'};
test('两平台训练一套通用规则，不按ID或来源分模型；先预测再纠错；重开保持',()=>{
  const store=new DataStore(':memory:');try{
    const model=new QuoteLearning(store),at=Date.UTC(2026,10,26);
    for(let i=0;i<100;i++) {
      const r={ok:true,cached:false,fetchedAt:at,provider:i%2?'guazi':'che300',prices:{good:{low:7,high:9}}};
      assert.equal(model.observe(vehicle,input,r,'sample-'+i),true);
    }
    const r=model.predict(vehicle,input,at);assert.ok(r.shadow);assert.ok(Math.abs(r.mid-8)<0.1,JSON.stringify(r));
    const v={...vehicle,id:'NEVER_SEEN',provider:'any'};
    assert.deepEqual(features(v,input,at),features(vehicle,input,at));
    const reopened=new QuoteLearning(store);assert.deepEqual(reopened.predict(vehicle,input,at),r);
    assert.ok(store.db.prepare('SELECT count(*) n FROM shadow_samples WHERE predicted_mid IS NOT NULL').get().n>=70);
    const n=model.state.count;
    for(const change of [{cached:true},{ok:false},{historicalFallback:true}])assert.equal(model.observe(vehicle,input,{ok:true,prices:{good:{low:7,high:9}},...change},'skip'),false);
    assert.equal(model.state.count,n);
    assert.equal(model.observe(vehicle,input,{ok:true,prices:{good:{low:7,high:9}}},'sample-1'),false);
  }finally{store.db.close();}
});
test('无指导价或未见过车可用共享特征学习，坏输入不污染模型',()=>{
  const store=new DataStore(':memory:');try{
    const model=new QuoteLearning(store);
    assert.equal(model.observe({},input,{ok:true,prices:{good:{low:7,high:9}}},'first'),true);
    assert.equal(model.observe(vehicle,{...input,mileage:NaN},{ok:true,prices:{good:{low:7,high:9}}},'bad'),false);
    assert.equal(model.observe(vehicle,input,{ok:true,prices:{good:{low:9,high:7}}},'reverse'),false);
    assert.equal(model.predict(vehicle,input),null);
  }finally{store.db.close();}
});

test('错误车型样本可撤销，按保留样本重建，不让错配继续污染共享模型',()=>{
  const store=new DataStore(':memory:');try{
    const model=new QuoteLearning(store),at=Date.UTC(2026,10,26);
    for(let i=0;i<35;i++)model.observe(vehicle,input,{ok:true,fetchedAt:at,prices:{good:{low:7,high:9}}},'good-'+i);
    model.observe(vehicle,input,{ok:true,fetchedAt:at,prices:{good:{low:50,high:60}}},'wrong');
    model.invalidate(['wrong']);assert.equal(model.state.count,35);
    assert.equal(store.db.prepare("SELECT count(*) n FROM shadow_samples WHERE sample_key='wrong'").get().n,0);
    assert.ok(Math.abs(model.predict(vehicle,input,at).mid-8)<0.1);
  }finally{store.db.close();}
});
