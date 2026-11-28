'use strict';
const BLACK_CAR = 'car-silhouette.svg';
const initialized=new WeakSet();
function quoteModelId(key){
  const p=String(key).split(':'),prefix=p[0]==='guazi';
  if(prefix&&!['dealer','private'].includes(p[1]))return '';
  const facts=prefix?p.slice(2):p;
  return facts.length===5 && facts.slice(0,3).every(x=>/^\d+$/.test(x)) && /^\d{4}-\d{1,2}$/.test(facts[3])
    && /^\d+(?:\.\d+)?$/.test(facts[4])?facts[2]:'';
}
function initializeSharedPhotos(store){
  if(initialized.has(store))return;
  const source=store.db.prepare('SELECT category,brand_id brandId,series_id seriesId,id FROM models WHERE id=?');
  for(const row of store.db.prepare('SELECT cache_key,payload,fetched_at FROM quotes ORDER BY fetched_at').all()){
    const id=quoteModelId(row.cache_key);if(!id)continue;
    try{
      const q=JSON.parse(row.payload);
      // Older Guazi mappings may have been corrected. Keep their image bytes,
      // but do not spread an unchecked old mapping through the shared index.
      if(row.cache_key.startsWith('guazi:')&&q.modelRuleVersion!==4)continue;
      const models=source.all(id);
      if(new Set(models.map(m=>m.brandId+':'+m.seriesId)).size!==1)continue;
      for(const model of models)store.linkSharedVehiclePhoto(model,q.vehicle,row.fetched_at);
    }catch{}
  }
  initialized.add(store);
}
function localVehiclePhoto(store,model,preferred=null) {
  initializeSharedPhotos(store);
  const local=preferred?.imageData?preferred:preferred?.imageUrl&&store.getVehiclePhoto(preferred.imageUrl);
  if(local?.imageData){store.linkSharedVehiclePhoto(model,local);return {imageUrl:local.imageUrl||'',imageData:local.imageData};}
  const shared=store.getSharedVehiclePhoto(model);
  if(shared)return shared;
  // Keep a known photo URL usable while an asynchronous download completes.
  if(preferred?.imageUrl && /^https:\/\//i.test(preferred.imageUrl))return {imageUrl:preferred.imageUrl,imageData:''};
  return {imageUrl:BLACK_CAR,imageData:''};
}
function allowedPhotoUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
    ['image-pub.guazistatic.com','image-public.guazistatic.com'].includes(u.hostname);}catch{return false;}
}
class CatalogPhotos {
  constructor({store,fetch,decode,log=()=>{}}){
    Object.assign(this,{store,fetch,decode,log});this.pending=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS catalog_photo_links(
      provider TEXT NOT NULL,series_id TEXT NOT NULL,image_url TEXT NOT NULL,
      PRIMARY KEY(provider,series_id));`);
  }
  get(seriesId){const row=this.store.db.prepare("SELECT image_url FROM catalog_photo_links WHERE provider='guazi' AND series_id=?").get(String(seriesId));
    return row?this.store.getVehiclePhoto(row.image_url):null;}
  async ensure(seriesId,url){
    if(!/^\d+$/.test(String(seriesId))||!allowedPhotoUrl(url))return null;
    const existing=this.store.getVehiclePhoto(url);
    if(existing){this.link(seriesId,url);return existing;}
    if(this.pending.has(url))return this.pending.get(url).then(photo=>{if(photo)this.link(seriesId,url);return photo;});
    const task=(async()=>{
      const response=await this.fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error'});
      if(!response.ok)throw Error('车图下载HTTP '+response.status);
      if(!/^image\/(png|jpeg|webp|gif)(;|$)/i.test(response.headers.get('content-type')||''))throw Error('车图格式异常');
      const chunks=[];let length=0;
      for await(const c of response.body){length+=c.length;if(length>2*1024*1024)throw Error('车图超过2MB');chunks.push(Buffer.from(c));}
      if(!length)throw Error('车图为空');
      const bytes=this.decode(Buffer.concat(chunks));
      const photo={imageUrl:url,imageData:'data:image/png;base64,'+bytes.toString('base64')};
      this.store.saveVehiclePhoto(photo);this.link(seriesId,url);return photo;
    })().catch(error=>{this.log('车图下载暂未完成',{seriesId,message:error.message});return null;}).finally(()=>this.pending.delete(url));
    this.pending.set(url,task);return task;
  }
  link(seriesId,url){this.store.db.prepare("INSERT OR REPLACE INTO catalog_photo_links VALUES ('guazi',?,?)").run(String(seriesId),url);}
  async prefetchKnown(){
    const rows=this.store.db.prepare("SELECT payload FROM provider_catalog WHERE provider='guazi' AND scope LIKE 'series:%'").all();
    let cached=0,failed=0;
    for(const row of rows){let items=[];try{items=JSON.parse(row.payload).filterValue?.tagList||[];}catch{}
      for(const item of items){if(!allowedPhotoUrl(item.icon))continue;
        if(await this.ensure(item.id,item.icon))cached++;else failed++;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    this.log('车系图片预缓存完成',{cached,failed});return {cached,failed};
  }
}
module.exports={localVehiclePhoto,initializeSharedPhotos,quoteModelId,BLACK_CAR,CatalogPhotos,allowedPhotoUrl};
