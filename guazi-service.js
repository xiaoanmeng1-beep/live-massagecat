'use strict';
const {localVehiclePhoto}=require('./vehicle-photos');
const MODEL_RULE_VERSION=4;
const QUOTE_BASIS='dealer', GUAZI_CACHE_PREFIX='guazi:dealer:';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/汽车|款|[\s·\-()（）\[\]]/g,'');
const cleanId=x=>/^\d+$/.test(String(x||'')) && +x>0 ? String(x) : '';
function fail(code,message){return {ok:false,code,message};}
function quoteCacheKey(input){
  const date=String(input.registration||'').match(/^(\d{4})-(\d{1,2})$/), mileage=Number(input.mileage);
  if(!date || +date[2]<1 || +date[2]>12 || !Number.isFinite(mileage) || mileage<=0 || mileage>100 ||
      ![input.provinceId,input.cityId,input.modelId].every(id=>cleanId(id)))return '';
  return GUAZI_CACHE_PREFIX+[input.provinceId,input.cityId,input.modelId,date[1]+'-'+String(+date[2]).padStart(2,'0'),mileage].join(':');
}
function sourceVehicle(store,input) {
  return store.db.prepare(`SELECT m.id,m.category,m.brand_id brandId,m.series_id seriesId,
    m.name,m.year,m.catalog_price catalogPrice,b.name brandName,s.name seriesName,
    c.name cityName FROM models m JOIN brands b ON b.category=m.category AND b.id=m.brand_id
    JOIN series s ON s.category=m.category AND s.brand_id=m.brand_id AND s.id=m.series_id
    LEFT JOIN cities c ON c.province_id=? AND c.id=? WHERE m.id=? LIMIT 1`)
    .get(String(input.provinceId),String(input.cityId),String(input.modelId));
}
function matchingName(items,name,brand='',{partial=true}={}) {
  const wanted=norm(name),brands=(Array.isArray(brand)?brand:[brand]).map(norm).filter(Boolean);
  // Brackets are alternate names, not another suffix glued to the main name.
  const aliases=value=>{const text=String(value||'');return [...new Set([text.replace(/\[[^\]]+\]/g,''),
    ...[...text.matchAll(/\[([^\]]+)\]/g)].map(m=>m[1])].map(norm).filter(Boolean))];};
  const wantedAliases=aliases(name);
  const manufacturer=/^(?:一汽|上汽|广汽|东风|北京|北汽|华晨|长安|福建|郑州|东南)/;
  const words=[...new Set(brands.flatMap(b=>[b,...(b.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g)||[]).flatMap(w=>[w,w.replace(manufacturer,'')])]))]
    .filter(w=>w.length>=2).sort((a,b)=>b.length-a.length);
  const core=value=>{
    let s=norm(value).replace(/进口/g,'');
    for(let i=0;i<2;i++){s=s.replace(manufacturer,'');for(const b of words)if(s.startsWith(b))s=s.slice(b.length);}
    return s.replace(/([a-z])级$/,'$1');
  };
  const primaryCore=core(wantedAliases[0]);
  const primaryItems=items.filter(x=>primaryCore&&core(aliases(x.name)[0])===primaryCore);
  if(primaryItems.length){const fitting=primaryItems.find(x=>/进口/.test(x.name)===/进口/.test(name));
    if(fitting)return fitting;if(/进口/.test(name))return primaryItems[0];}
  const exact=items.filter(x=>aliases(x.name).some(n=>wantedAliases.includes(n)) || x.value&&norm(x.value)===wanted);
  if(exact.length){const primary=exact.filter(x=>aliases(x.name)[0]===wantedAliases[0]);
    const preferred=primary.length?primary:exact;return preferred.find(x=>/进口/.test(x.name)===/进口/.test(name))||preferred[0];}
  const same=items.filter(x=>aliases(x.name).some(n=>wantedAliases.some(w=>core(w)&&core(n)===core(w))));
  if(same.length){const primary=same.filter(x=>core(aliases(x.name)[0])===core(wantedAliases[0]));
    const preferred=primary.length?primary:same,fitting=preferred.find(x=>/进口/.test(x.name)===/进口/.test(name));
    if(fitting)return fitting;if(/进口/.test(name))return preferred[0];}
  if(!partial)return undefined;
  const imported=/进口/.test(name);
  const ranked=items.map(item=>{
    const n=core(item.name),w=core(name);
    let score=n && w && (n.includes(w)||w.includes(n))?Math.min(n.length,w.length):0;
    // Manufacturer prefixes differ across platforms (e.g. Chinese text
    // inserted before a shared Latin marque). Preserve a whole Latin marque,
    // not accidental single-letter matches between unrelated car names.
    for(const token of w.match(/[a-z]{3,}/g)||[])if(n.includes(token))score=Math.max(score,token.length);
    return {item,score};
  }).filter(x=>x.score>=2 && /进口/.test(x.item.name)===imported)
    .sort((a,b)=>b.score-a.score||a.item.name.length-b.item.name.length);
  return ranked[0]?.item;
}
function trimScore(a,b) {
  a=norm(a).replace(/\d{4}|进口/g,'');b=norm(b).replace(/\d{4}|进口/g,'');
  if(a===b)return 1000;
  let score=0;
  // Count continuous words and badges, not isolated '1', '2', 't' characters.
  for(const part of b.match(/[a-z]+\d*[a-z]*|\d+(?:\.\d+)?[a-z]+|[\u4e00-\u9fff]{2,}/g)||[]) {
    if(a.includes(part))score+=part.length*2;
    else if(/^[\u4e00-\u9fff]+$/.test(part))for(let i=0;i<part.length-1;i++)if(a.includes(part.slice(i,i+2)))score+=2;
  }
  // Pure numeric tail badges are vehicle evidence too: 260 is not 350h,
  // 200L is not 180L, and a matching trim word must not erase that distinction.
  const numbers=new Set(a.match(/\d+(?:\.\d+)?/g)||[]);
  for(const n of new Set(b.match(/\d+(?:\.\d+)?/g)||[]))
    score+=numbers.has(n)?n.length*4:n.length>=2?-n.length*2:0;
  return score;
}
function chooseTrim(rows,source) {
  if(!rows.length)return null;
  const wanted=+source.year,yearGap=r=>Math.abs(+r.year-wanted);
  return rows.map((r,i)=>({...r,order:i,score:trimScore(r.name,source.name)}))
    .sort((a,b)=>yearGap(a)-yearGap(b) || +a.year-+b.year || b.score-a.score
      || special(a.name)-special(b.name) || a.name.length-b.name.length || a.order-b.order)[0];
  function special(name){return (name.match(/改款|臻藏|特别|纪念|限量/g)||[]).filter(word=>!source.name.includes(word)).length;}
}
function buildQuoteParams(model,input,cityId) {
  if(!cleanId(model.id)||!cleanId(model.seriesId)||!cleanId(cityId))throw Error('瓜子车型或城市ID无效');
  const mileage=Number(input.mileage);
  if(!Number.isFinite(mileage)||mileage<=0||mileage>100)throw Error('行驶里程无效');
  return {carId:Number(model.id),roadHaul:Math.round(mileage*10000),cityId:Number(cityId),tagId:Number(model.seriesId)};
}
function normalizeQuote(data) {
  const low=Number(data?.priceBegin),high=Number(data?.priceEnd);
  if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<low)
    return fail('NO_PRICE','瓜子未返回有效的车商报价');
  return {ok:true,prices:{good:{low:low/10000,high:high/10000}}};
}
function normalizeError(result) {
  const code=String(result?.code||''),message=result?.message||'瓜子请求失败';
  if(['10001','500010','401','403'].includes(code) || /未登录|登录失效|token失效|获取token失败/.test(message))return fail('AUTH_REQUIRED','请在右侧登录瓜子账号');
  if(code==='429'||/频繁|频率|限额|限流|次数.*上限/.test(message))return fail('RATE_LIMITED',message);
  return fail(code||'GUAZI_REQUEST_FAILED',message);
}
class GuaziService {
  constructor({store,call,learn,invalidateSamples,photos,log=()=>{}}) {
    Object.assign(this,{store,call,learn,invalidateSamples,photos,log});this.pending=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS provider_catalog (
      provider TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider,scope)
    ); CREATE TABLE IF NOT EXISTS provider_quote_audit (
      sample_key TEXT PRIMARY KEY,reason TEXT NOT NULL,payload TEXT NOT NULL
    );`);
  }
  getCached(input){
    const key=quoteCacheKey(input);if(!key)return null;
    let cached=this.store.getQuote(key);
    if(cached?.provider!=='guazi'||cached.quoteBasis!==QUOTE_BASIS||!cleanId(cached.providerModel?.id)||!cleanId(cached.providerModel?.seriesId))return null;
    if(cached.modelRuleVersion!==MODEL_RULE_VERSION){
      // v4 changes family-name aliases only. A v3 quote can retain its real
      // price without another request if that family is unchanged. All reads
      // here are LOCAL and do not consult directory freshness/login state.
      if(cached.modelRuleVersion!==3)return null;
      const source=sourceVehicle(this.store,input);if(!source)return null;
      const read=scope=>{try{return JSON.parse(this.store.db.prepare("SELECT payload FROM provider_catalog WHERE provider='guazi' AND scope=?").get(scope)?.payload||'null');}catch{return null;}};
      const brands=Object.values(read('brands')?.filterValue?.common||{}).flat(),brand=matchingName(brands,source.brandName);
      if(!brand)return null;
      const family=matchingName((read('series:'+brand.id)?.filterValue?.tagList||[]).filter(x=>cleanId(x.id)),source.seriesName,[source.brandName,brand.name]);
      if(!family||String(family.id)!==String(cached.providerModel?.seriesId))return null;
      cached={...cached,modelRuleVersion:MODEL_RULE_VERSION};this.store.saveQuote(key,cached);
    }
    if(!normalizeQuote({priceBegin:cached.prices?.good?.low*10000,priceEnd:cached.prices?.good?.high*10000}).ok)return null;
    const photo=localVehiclePhoto(this.store,sourceVehicle(this.store,input),cached.vehicle);
    return {...cached,vehicle:{...cached.vehicle,...photo},ok:true,cached:true};
  }
  indexKnownPhotos(){
    // Foreign IDs are ONLY used to find a known catalog image. Store the link
    // under the app's full brand/series identity; never equate platform IDs.
    const read=scope=>{try{return JSON.parse(this.store.db.prepare("SELECT payload FROM provider_catalog WHERE provider='guazi' AND scope=?").get(scope)?.payload||'null');}catch{return null;}};
    const brands=Object.values(read('brands')?.filterValue?.common||{}).flat();let linked=0;
    for(const brand of this.store.db.prepare('SELECT category,id,name FROM brands').all()){
      const foreign=matchingName(brands,brand.name);if(!foreign)continue;
      const families=read('series:'+foreign.id)?.filterValue?.tagList||[];
      for(const s of this.store.db.prepare('SELECT id,name FROM series WHERE category=? AND brand_id=?').all(brand.category,brand.id)){
        const family=matchingName(families.filter(x=>cleanId(x.id)),s.name,[brand.name,foreign.name],{partial:false});if(!family)continue;
        const photo=this.photos?.get(family.id);if(!photo)continue;
        this.store.linkSharedVehiclePhoto({category:brand.category,brandId:brand.id,seriesId:s.id},photo);linked++;
      }
    }
    return linked;
  }
  async catalog(scope,method,params={}) {
    const row=this.store.db.prepare("SELECT payload,updated_at FROM provider_catalog WHERE provider='guazi' AND scope=?").get(scope);
    if(row && Date.now()-row.updated_at<3*86400000)try{return JSON.parse(row.payload);}catch{}
    if(this.pending.has(scope))return this.pending.get(scope);
    const task=(async()=>{
      const r=await this.call(method,params);
      if(!r.ok)throw Object.assign(Error(r.message),{result:normalizeError(r)});
      if(!r.data||typeof r.data!=='object')throw Error('瓜子车型目录响应为空');
      this.store.db.prepare("INSERT OR REPLACE INTO provider_catalog VALUES ('guazi',?,?,?)")
        .run(scope,JSON.stringify(r.data),Date.now());
      return r.data;
    })().finally(()=>this.pending.delete(scope));this.pending.set(scope,task);return task;
  }
  async resolve(input,scope) {
    const check=()=>scope?.check();check();
    const source=sourceVehicle(this.store,input);
    if(!source)return fail('NO_MODEL','本地车型记录缺失');
    const brands=await this.catalog('brands','brands');
    check();
    const brand=matchingName(Object.values(brands.filterValue?.common||{}).flat(),source.brandName);
    if(!brand)return fail('NO_MODEL','瓜子目录未找到品牌：'+source.brandName);
    const series=await this.catalog('series:'+brand.id,'series',{brandId:brand.id});
    check();
    const family=matchingName((series.filterValue?.tagList||[]).filter(r=>cleanId(r.id)),source.seriesName,[source.brandName,brand.name]);
    if(!family)return fail('NO_MODEL','瓜子目录未找到车系：'+source.seriesName);
    const cities=await this.catalog('cities','cities');
    check();
    const allCities=Object.values(cities.common||{}).flat();
    const city=allCities.find(c=>norm(c.name).replace(/市$/,'')===norm(source.cityName).replace(/市$/,''))
      || allCities.find(c=>c.name==='广州');
    if(!city)return fail('NO_CITY','瓜子目录未找到城市');
    const cityId=cleanId(city.city_id);
    const data=await this.catalog('models:'+family.id,'models',{tagId:family.id,selectType:1,selectedCity:cityId,guazi_city:cityId});
    check();
    const rows=(data.cheXingList||[]).filter(g=>g.fieldValue!=='-1').flatMap(g=>(g.filterValue||[])
      .filter(m=>cleanId(m.fieldValue)).map(m=>({id:String(m.fieldValue),name:String(m.displayName).replace(/^(\d{4}款)\s*/,'$1 '+family.name+' '),
        year:Number(String(g.displayName).match(/\d{4}/)?.[0]),seriesId:String(family.id)})));
    const model=chooseTrim(rows,source);
    if(!model)return fail('NO_MODEL','瓜子目录未找到可报价配置：'+source.seriesName);
    return {ok:true,source,model:{...model,imageUrl:family.icon||''},params:buildQuoteParams(model,input,cityId)};
  }
  async quote(input,scope) {
    try {
      scope?.check();
      // Each source input has its own immutable cache identity, never shares a
      // Che300 key. Registration remains in the identity even though Guazi's
      // current web endpoint does not accept a registration parameter.
      const key=quoteCacheKey(input);
      if(!key)return fail('INVALID_INPUT','车型、地区、上牌年月或里程无效');
      const previous=this.store.getQuote(key),cached=!input.forceRefresh&&previous;
      const ready=!input.forceRefresh&&this.getCached(input);if(ready)return ready;
      const matched=await this.resolve(input,scope);
      if(!matched.ok)return matched;
      const legacyKey=key.replace('guazi:dealer:','guazi:private:'),legacy=this.store.getQuote(legacyKey);
      if(legacy?.provider==='guazi'&&legacy.providerModel?.id!==matched.model.id){
        const sampleKey=legacyKey+':'+legacy.fetchedAt;
        this.store.db.prepare('INSERT OR IGNORE INTO provider_quote_audit VALUES (?,?,?)')
          .run(sampleKey,'历史个人价配置映射修正：'+legacy.providerModel?.name+' → '+matched.model.name,JSON.stringify(legacy));
        this.invalidateSamples?.([sampleKey]);
      }
      if(previous?.provider==='guazi' && (String(previous.providerModel?.id)!==matched.model.id||String(previous.providerModel?.seriesId)!==matched.model.seriesId)) {
        const sampleKey=key+':'+previous.fetchedAt;
        this.store.db.prepare('INSERT OR IGNORE INTO provider_quote_audit VALUES (?,?,?)')
          .run(sampleKey,'配置映射修正：'+previous.providerModel?.name+' → '+matched.model.name,JSON.stringify(previous));
        this.invalidateSamples?.([sampleKey]);
      } else if(cached?.provider==='guazi' && cached.quoteBasis===QUOTE_BASIS && normalizeQuote({priceBegin:cached.prices?.good?.low*10000,
        priceEnd:cached.prices?.good?.high*10000}).ok) {
        const upgraded={...cached,modelRuleVersion:MODEL_RULE_VERSION};this.store.saveQuote(key,upgraded);
        const photo=localVehiclePhoto(this.store,sourceVehicle(this.store,input),cached.vehicle);
        return {...upgraded,vehicle:{...cached.vehicle,...photo},ok:true,cached:true};
      }
      const response=await this.call('quote',matched.params);
      scope?.check();
      if(!response.ok)return {...normalizeError(response),provider:'guazi',providerModel:matched.model,requestParams:matched.params};
      const normalized=normalizeQuote(response.data);
      if(!normalized.ok)return normalized;
      const sharedPhoto=localVehiclePhoto(this.store,matched.source);
      const catalogPhoto=sharedPhoto.imageData?sharedPhoto:await this.photos?.ensure(matched.model.seriesId,matched.model.imageUrl);
      scope?.check();
      const photo=catalogPhoto||sharedPhoto;
      this.store.linkSharedVehiclePhoto(matched.source,photo);
      const result={...normalized,provider:'guazi',quoteBasis:QUOTE_BASIS,modelRuleVersion:MODEL_RULE_VERSION,cached:false,fetchedAt:Date.now(),
        providerModel:{...matched.model},requestParams:matched.params,
        vehicle:{name:matched.model.name,...photo}};
      // Store a photo reference, not another base64 copy for every mileage.
      this.store.saveQuote(key,{...result,vehicle:{...result.vehicle,imageData:''}});
      try{this.learn?.(matched.source,input,result,key+':'+result.fetchedAt);}catch(e){this.log('后台学习失败，不影响已取得的瓜子报价',{message:e.message});}
      this.log('瓜子车商报价已取得',{modelId:matched.model.id,cityId:matched.params.cityId});
      return result;
    }catch(e){return e.result||fail('GUAZI_REQUEST_FAILED',e.message);}
  }
}
module.exports={GuaziService,sourceVehicle,matchingName,chooseTrim,buildQuoteParams,normalizeQuote,normalizeError,MODEL_RULE_VERSION,QUOTE_BASIS,GUAZI_CACHE_PREFIX,quoteCacheKey};
