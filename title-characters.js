// Literal evidence from ONE catalog title. Never invent a missing letter or
// add counts from different trims. A numeric token owns its complete digits.
'use strict';
const norm=s=>String(s??'').normalize('NFKC').toLowerCase();
const units=s=>norm(s).match(/\d+(?:\.\d+)?|[a-z\p{Script=Han}]/gu)||[];
const weight=t=>t.replace('.','').length;
const titleBody=s=>norm(s).replace(/^\s*(?:19|20)\d{2}\s*(?:年款|款)\s*/,'');
function literalScore(query,title){return scoreTokens(query,units(titleBody(title)));}
function scoreTokens(query,tokens){
  const available=new Map();
  for(const t of tokens)available.set(t,(available.get(t)||0)+1);
  let matched='',count=0;
  for(const t of query){
    const n=available.get(t)||0;if(!n)continue;
    available.set(t,n-1);matched+=t;count+=weight(t);
  }
  return {count,matched};
}
const blank=m=>' '.repeat(m.length);
const date=/(?<!\d)(?:(?:19|20)\d{2}|\d{1,2})\s*(?:年款|款|年|上牌|落户)(?:\s*\d{1,2}\s*月份?)?的?/g;
const amounts=/(?:\d+(?:,\d{3})*(?:\.\d+)?|[零〇一二两三四五六七八九十百千万点]+)\s*(?:多|来|左右)?\s*(?:(?:万|w)?\s*(?:公里数?|千米|km)|万(?:元|块)?|w|元|块|座|匹|岁|折|档)/g;
const speech=/公里数|里程|主播|请问|老板|师傅|你好|我的是|我这辆|(?:我)?有一[台辆]|这辆|这台|多少钱|多少米|多少收|多少能收|多少|值钱吗|值不值|什么价(?:格)?|估个价|报价|能收吗|想卖|上牌|跑了|行驶|全车|原版原漆|个人一手|一手车|黑色|白色|银色|红色|蓝色/g;
const detail=/(?:\d\.\d\s*(?:t|l|自吸)?|两驱|四驱|前驱|后驱|手动|自动|豪华|旗舰|舒适|领先|尊贵|时尚|精英|插混|插电|纯电|新能源|天窗|电动座椅)/;
const accessory=/^(?:带|有)?(?:电子手刹|自动空调|全景天窗|天窗|电动座椅|大灯|座椅|水箱)$/;
function describe(raw,brands){
  const clean=norm(raw).replace(date,blank).replace(amounts,blank).replace(speech,blank);
  // Do not turn repair/price talk or two independently named cars into one query.
  if(/[、/;；]|以及|还是|和|与|对比|比较|换过|配件/.test(clean))return null;
  const fields=[...clean.matchAll(/[\p{Script=Han}a-z\d.]+/gu)];
  let first=fields.find(m=>!/^的$/.test(m[0]));
  if(!first)return null;
  let name=first[0].split(detail)[0],end=first.index+name.length;
  const known=brands.find(b=>name.includes(b))||'';
  const tail=clean.slice(end);
  // Two written tokens may describe the maker and its model. Never glue
  // separate digit groups or use an odometer that was removed above.
  if(known && name.endsWith(known)){
    const more=/^[ \t]+([a-z\d\p{Script=Han}]+)/u.exec(tail);
    if(more){
      const part=more[1].split(detail)[0];
      if(part){name+=part;end+=more[0].indexOf(more[1])+part.length;}
    }
  }
  const id=units(name),length=id.reduce((n,t)=>n+weight(t),0);
  if((!known&&length<3)||length<2||length>20||!/[a-z\p{Script=Han}]/u.test(name)||accessory.test(name))return null;
  if(known && (!name.slice(name.indexOf(known)+known.length) || brands.some(b=>b!==known&&b.length>=2&&clean.slice(end).includes(b))))return null;
  if(/^(?:我|你|有|要|这个|那个|但是|如果|可以|就是|今天|换|公里|年检|年审|保险|预算|最低|最高|大概|现在|二手|两地|手动|自动)/.test(name))return null;
  if(/\d$/.test(name)&&/^\s+\d+\s*(?:$|[,，])/.test(clean.slice(end)))return null;
  return {name,known,id,length,start:first.index,end,all:units(clean)};
}
function makeTitleLookup(db){
  // Stream once per make (or once for anonymous passenger inquiries); cache
  // distinct written names within each family, not a copy of the pricing DB.
  const caches=new Map();
  function corpus(make){
    if(caches.has(make))return caches.get(make);
    const tail=make?' and b.name = ? collate nocase':' and m.category in (\'passenger\',\'energy\')';
    const q=db.prepare('select m.category,m.brand_id brand,m.series_id id,m.name,b.name make from models m join brands b on m.category=b.category and m.brand_id=b.id where 1=1'+tail);
    const families=new Map();
    for(const m of q.iterate(...(make?[make]:[]))){
      const key=JSON.stringify([m.category,m.brand,m.id]);
      let f=families.get(key);if(!f)families.set(key,f={key,names:new Set(),vocabulary:new Set()});
      const name=titleBody(m.name);if(f.names.has(name))continue;
      f.names.add(name);for(const t of units(name))f.vocabulary.add(t);
    }
    if(caches.size>=12)caches.delete(caches.keys().next().value);
    caches.set(make,families);return families;
  }
  return {clear:()=>caches.clear(),find(query,series){
    const found=[];
    const tail=query.known?units(query.name.slice(query.name.indexOf(query.known)+query.known.length)):query.id;
    if(!tail.length)return [];
    for(const f of corpus(query.known).values()){
      const row=series.get(f.key);if(!row)continue;
      // The maker is already enforced by the SQL join; many real titles omit it.
      const identifyingUnits=query.known && !query.name.slice(0,query.name.indexOf(query.known)) ? tail : query.id;
      const threshold=Math.max(2,identifyingUnits.reduce((n,t)=>n+weight(t),0)-1);
      const ceiling=identifyingUnits.reduce((n,t)=>n+(f.vocabulary.has(t)?weight(t):0),0);
      if(ceiling<threshold||tail.some(t=>/^\d/.test(t)&&!f.vocabulary.has(t)))continue;
      const names=new Set();
      for(const name of f.names){
        const tokens=units(name), left=tail.slice();
        // Identity glyphs must form a compact, ordered name fragment, not
        // scattered hits in engine size, transmission, and a trim label.
        let identity=false;
        for(let i=0;i<tokens.length&&!identity;i++){
          if(tokens[i]!==left[0])continue;
          let k=0;for(let j=i;j<tokens.length&&j<i+left.length+4;j++)if(tokens[j]===left[k]&&++k===left.length){identity=true;break;}
        }
        if(!identity)continue;
        const a=scoreTokens(identifyingUnits,tokens);
        if(a.count<threshold)continue;
        names.add(name);
      }
      if(names.size)found.push({row,names});
    }
    return found;
  }};
}
module.exports={titleBody,describe,makeTitleLookup,literalScore,units};
