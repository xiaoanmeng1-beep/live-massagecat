'use strict';

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
const compact = value => normalize(value).replace(/[\s·・-]/g, '');
const {describe:describeTitle,makeTitleLookup,literalScore,titleBody}=require('./title-characters');
const distinct = values => [...new Set(values)];
const skip = (code, reason) => ({ ok: false, code, reason });
const ignore = (reason, code='CHAT') => ({...skip(code,reason), ignored:true});

// Mask a labelled paint attribute, or a paint name in its own comment field.
// Keep coordinates and ordinary vehicle descriptions such as “吉利熊猫 白色”.
function maskPaint(text){
  const blank=m=>' '.repeat(m.length);
  const finish='(?=$|[\\s,，、。.:：!?！？;；/]|\\d|[零一二两三四五六七八九十]+万|的|不是|并非|外观|内饰|外|内|车身|车漆|配色)';
  const paint='[白黑红蓝灰银黄绿紫橙粉金棕]色?';
  const label='(?:车漆|车身(?:颜色)?|外观颜色|内饰颜色|配色|颜色)';
  return text.replace(new RegExp(label+'\\s*[:：为是]?\\s*[\\u3400-\\u9fff]{0,6}?'+paint+finish,'g'),blank)
    .replace(new RegExp('(?:(?<![\\u3400-\\u9fff])|(?<=\\d[年款]))(?:熊猫|冰川|珍珠|星空|曜石|极光|雪山|水泥|赛车|宝石|哑光|磨砂|陶瓷|金属)'+paint+finish,'g'),blank);
}
const simpleAsk = /^(?:那|所以|请问|老板|主播|老师|哥|大哥|师傅)*(?:(?:这个|那个|这车|那车))?(?:多少(?:钱|米|收)?|几多钱|什么价(?:格)?|啥价|能值多少|还值多少|值多少钱|怎么收|收不收|(?:可以|能|还能|还|敢|要)收(?:吗|么)?|给个价|报个价|估个价|报价|估价)(?:啊|呀|呢|嘛|吧)*$/;
const removeSeparators = text => compact(text).replace(/[\p{P}\p{S}]/gu,'');

// Fast, whole-message checks. No catalog lookup, queue or failure record for
// clearly context-free questions, numeric fragments or prose over the input limit.
function prefilterComment(raw, plain) {
  if (!raw || raw.length>500) return ignore('评论为空或超过 500 字，已忽略','INVALID_TEXT');
  if(!/[\p{L}\p{N}]/u.test(plain) || /^[\d零〇一二两三四五六七八九十百千万]+$/.test(plain))
    return ignore('只有数字或符号，没有车型信息');
  if(simpleAsk.test(plain))return ignore('只有问价，没有车型信息');
  if(/^(?:(?:行|好|行吧|好吧|没问题|可以)(?:那)?|那)?(?:你|我|咱们|你们)?(?:明天|今天|后天|下午|晚上|有空|改天)?(?:过来|来|去)(?:看看|看一下|看|试一下|试|聊聊|聊)(?:看)?车(?:吧|呀|啊|呢|啦|就行)?$/.test(plain))
    return ignore('只有看车安排，没有具体车型');
  if(/^(?:那(?:要是|如果)|要是|如果|假如|那)?(?:换过|修过|动过|换了|修了|爆过)(?:前|后|主驾|副驾|侧面|主副驾)?(?:安全)?(?:气囊|发动机|变速箱|保险杠|车门|大灯)(?:呢|啊|吗|么|咋办|怎么办|还能收吗|还收吗|影响价格吗)?$/.test(plain))
    return ignore('只有车况追问，没有车型信息');
  return null;
}

// Defaults are scoped to one catalog series. They only rank candidates that
// have equal evidence from the viewer’s description.
const defaultTrimBySeries = { '45704':'先锋' };
const trimWords = '幻夜尊贵|旗舰|豪华|尊享|领先|舒适|时尚|精英|先锋|进取|两厢|三厢|全轮驱动|后轮驱动|前轮驱动|四驱|两驱|后驱|手自一体|手动|自动|焕新|双擎';
const ordinalTrimWords='次顶配|次高配|次低配|最高配|最低配|顶配';
const trimGradeWords=ordinalTrimWords+'|低配|中配|高配';
const ordinalTrimTokens=()=>new RegExp(ordinalTrimWords,'g');
function readTrimGrade(text) {
  const canonical={次高配:'次顶配',最高配:'顶配'};
  const grades=distinct([...text.matchAll(new RegExp(trimGradeWords,'g'))]
    .filter(m=>!/(?:不是|并非|不要|非)\s*$/.test(text.slice(0,m.index)))
    .map(([word])=>canonical[word]||word));
  return grades.length===1?grades[0]:'';
}
const trimMentions = () => new RegExp('livis|ultra|max|pro|air|plus|(?<![a-z])(?:amt|cvt|dsg|dct|ecvt)(?![a-z])|'+trimWords+'|\\d+tfsi|\\d+tsi|\\d+thp|(?<![\\d.])\\d{3}t(?![a-z0-9])','g');
const powerBadgeSuffix = 'tfsi|tsi|thp|turbo';
const catalogNumberBadgeSuffix = powerBadgeSuffix+'|t';
const electricFamilySuffix=/(?:新能源|phev|插电混动|插混|混动|双擎)$/;
const hybridCue=/(?<!非|不是|并非|不要)(?:油电混合|混动|插混|插电式混合动力|phev(?![a-z]))/g;
const engineCatalog = require('./app/engine-badges.json');
const {pinyin,polyphonic} = require('pinyin-pro');
const phoneticCache = new Map();
function phoneticKey(word) {
  if(!phoneticCache.has(word)){
    if(phoneticCache.size>=2048)phoneticCache.delete(phoneticCache.keys().next().value);
    phoneticCache.set(word,pinyin(word,{toneType:'none',type:'array'}).join('/'));
  }
  return phoneticCache.get(word);
}
// A two-character family is too short for plain edit distance. One glyph must
// be identical and the other must share an attested pronunciation.
function shortHomophone(a,b) {
  if(a.length!==2 || b.length!==2)return false;
  const diff=[0,1].filter(i=>a[i]!==b[i]);
  if(diff.length!==1)return false;
  const i=diff[0], sounds=c=>polyphonic(c,{toneType:'none',type:'array'})[0];
  return sounds(a[i]).some(x=>sounds(b[i]).includes(x));
}

const { preferredBrandForBareCodes, trimFamilies, seriesAliases, bodyBadges, generationBoundaries } = require('./app/vehicle-aliases.json');
const bareSeriesCode = /^[a-z]{1,5}\d{1,4}[a-z]{0,2}$/;
// Read the suffix in the ORIGINAL comment. After compaction, "25-15年的"
// looks like one number. A quoted price, mileage or year is not a family ID.
function familyNumberEndsHere(tail) {
  if (/^[ \t]*[-~～—至到][ \t]*\d/.test(tail))
    return /^[ \t]*[-—][ \t]*(?:\d{2}|(?:19|20)\d{2})[ \t]*(?:年|款|上牌)/.test(tail);
  return !/^\d|^\s*(?:(?:多|来|左右)?\s*(?:[万千百元块年月款岁折匹座档挡%]|公里|里程|千米|上牌|马力|个油|w\b|km\b)|[a-z.])/.test(tail);
}
const catalogMake = value => {
  const key=compact(value);
  return key==='上汽商用车'?'上汽maxus':key.replace(/(?:汽车|商用车|乘用车)$/,'');
};
const catalogFamilyName = row => compact(row.name).replace(/\[[^\]]+\]$/,'').replace(/\(进口\)$/,'');
function exactSeriesSpelling(hit) {
  if(hit.shortSeries||hit.variant||hit.nearMatch||hit.catalogFamily||hit.reverseTrim)return false;
  const name=catalogFamilyName(hit.row), brand=compact(hit.row.brandName);
  const key=compact(hit.key);
  return key===name || key===(name.startsWith(brand)?name.slice(brand.length):brand+name);
}
const sameCrossCatalogFamily = (a,b) => (a.category==='commercial')!==(b.category==='commercial') &&
  catalogMake(a.brandName)===catalogMake(b.brandName) && catalogFamilyName(a)===catalogFamilyName(b);

// Rank only aliases that compete for the SAME characters. Independent mentions
// of two cars remain two cars, even if one has a much longer name.
function strongestSeriesHits(hits) {
  const score = h => (h.coverage??h.key.length)
    + Math.min(h.key.length,500)/1000;
  const kept = [];
  for (const h of hits.sort((a,b)=>score(b)-score(a))) {
    if (!kept.some(k=>k.i<h.end && h.i<k.end &&
      ((k.row.brand===h.row.brand&&k.row.id===h.row.id)?score(k)>score(h):(k.coverage??k.key.length)>(h.coverage??h.key.length))))kept.push(h);
  }
  return kept;
}

// Learn configuration names from THIS series, not a global whitelist.
// “天狼星”/“北极星” are independent catalog words, not synonyms for “四驱”.
function trimLabels(name, label) {
  return [...normalize(name).matchAll(/[\u3400-\u9fff]{2,}/g)].map(([token])=>{
    // The catalog may glue either transmission or series into an edition name.
    for(let n=token.length-2;n>=2;n--)if(label.endsWith(token.slice(0,n))){token=token.slice(n);break;}
    return token.replace(/^(?:(?:自动|手动|两驱|四驱|后驱|前驱))+/,'').replace(/(?:版|型|套装)$/,'');
  }).filter(word=>word.length>=2&&!label.includes(word));
}

function seriesTrimWords(rows, rest, series) {
  const label=compact(series.brandName+series.name),text=normalize(rest);
  const words=new Set();
  for (const row of rows) for(const word of trimLabels(row.name,label)) if(text.includes(word))words.add(word);
  return [...words];
}

// Each model title retains whether the text names a complete edition or
// merely appears inside another product label. Neither case requires that
// a series alias was matched in the viewer's comment first.
function catalogTrimEvidence(model, series) {
  const words=new Map(), label=compact(series.brandName+series.name);
  for(const word of trimLabels(model.name,label)){
    if(word.length<=12)words.set(word,2);
    const suffix=word.match(/(?:系列|版本)([\u3400-\u9fff]{2,8})$/)?.[1];
    if(suffix && !words.has(suffix))words.set(suffix,1);
  }
  for(const m of normalize(model.name).matchAll(/([\u3400-\u9fff]{1,8})\s*(pro|ultra|max|livis|plus|air)(?![a-z])/g)){
    const stem=m[1].replace(/^(?:两驱|四驱|前驱|后驱|手动|自动)+/,'');
    if(stem)words.set(stem+m[2],2);
  }
  return words;
}

const isEquipment=w=>/^(?:(?:电动|电子|全景|自动|多功能|真皮|加热|通风|全液晶|智能|无钥匙|感应|前排|后排|前|后|带)*)(?:座椅|天窗|手刹|大灯|尾门|雨刷|空调|方向盘|仪表盘|后视镜|倒车影像|行车记录仪)$/.test(w);
const genericTrim = new RegExp('^(?:'+trimWords+'|'+trimGradeWords+'|动感|尊贵|舒适型|入门|标准|运动|基础|纪念|特别|限量|国内|进口|新能源|燃油|汽油|柴油|旗舰版|科技|经典|都市|公路|现款|更换|公里|汽车|激光大灯|大灯|水箱)$');

function matchCatalogBadge(name,stem,grade,allowLong=false) {
  // Catalog variants: “C级 C 200 L”, “NX(进口) 260”, “A 200 L”.
  const title=normalize(name).replace(/\(进口\)/g,' ');
  const prefix='(?<![a-z0-9.])'+stem+'(?:级\\s*(?:'+stem+')?)?';
  const suffix=allowLong&&/^\d+$/.test(grade)?'(?:\\s*l)?':'';
  // A boundary before the next token matters: “180 L 时尚” matches a
  // shortened “180”, but “180K” or “200 L” never substitutes for it.
  return new RegExp(prefix+'\\s*'+grade.replace(/(?<=\d)(?=[a-z])/g,'\\s*')+suffix+
    '(?![a-z0-9]|\\s*l\\b)').test(title);
}

function matchTrimVariant(model, v, allowLong=false) {
  if(v.startsWith('range:'))return new RegExp('(?<![\\d.])'+v.slice(6)+'\\s*(?:km|公里)(?![a-z])').test(normalize(model.name));
  if(v.startsWith('near-trim:'))return v.slice(10).split('|').some(word=>compact(model.name).includes(word));
  if(v==='自动')return /自动|双离合|手自一体|(?:e?cvt|dsg|dct|amt|[4-9]at|s[ -]?tronic|tiptronic)(?![a-z])/.test(normalize(model.name));
  if(v==='手自一体')return /手自一体|自动(?!空调)|[4-9]\s*at(?![a-z0-9])/.test(normalize(model.name));
  if(v==='powertrain:hybrid')return /混动|油混|油电混合|双擎|插混|插电式|(?:p?hev|i-hev|e:hev|em-[ip]|c-dm)(?![a-z])/i.test(model.name);
  if(v==='四驱')return /四驱|全驱|全轮驱动|全时驱动|(?:xdrive|4matic|quattro|awd|4wd|4motion)/i.test(model.name);
  if(v==='两驱')return /两驱|前驱|后驱|前轮驱动|后轮驱动|(?:sdrive|fwd|rwd|2wd)/i.test(model.name);
  if(v==='后驱')return /后驱|后轮驱动|(?:rwd|sdrive)/i.test(model.name);
  if(/^[2-9]座$/.test(v))return seatCount(model.name)===+v[0];
  if(v.startsWith('body-badge:')){
    const [,body,badge]=v.split(':');
    return compact(model.name).includes(body)||matchTrimVariant(model,'model-code:'+badge);
  }
  if(v.startsWith('power-grade:'))
    return new RegExp('(?<![a-z0-9])'+v.slice(12)+'\\s*(?:'+powerBadgeSuffix+')(?![a-z])').test(normalize(model.name));
  if(v.startsWith('number-badge:')){
    const [,number,suffix]=v.split(':');
    return new RegExp('(?<![a-z0-9.])'+number+'\\s*(?:'+(suffix||catalogNumberBadgeSuffix)+')(?![a-z0-9])')
      .test(normalize(model.name));
  }
  if(v.startsWith('model-root:'))
    return new RegExp('(?<![a-z0-9.])'+v.slice(11)+'(?:li|i|l|d|e|h)?(?![a-z0-9.])').test(normalize(model.name));
  if(/^(?:amt|cvt|dsg|dct|ecvt)$/.test(v))
    return new RegExp('(?<![a-z])'+v+'(?![a-z])').test(normalize(model.name));
  if(v.startsWith('badge:')){
    const [,stem,grade]=v.split(':');
    return matchCatalogBadge(model.name,stem,grade,allowLong);
  }
  if(v.startsWith('model-code:')){
    const code=v.slice(11).replace(/^([a-z]+)(?=\d)/,'$1[ \\t]*');
    return new RegExp('(?<![a-z0-9.])'+code+'(?![a-z0-9])').test(normalize(model.name));
  }
  return /^\d+\.?\d*$/.test(v)
    ? new RegExp('(?<![\\d.])'+v.replace('.','\\.')+'(?![\\d.])','i').test(normalize(model.name))
    : compact(model.name).includes(v);
}

function adjacentPowerGrades(rows, editionWords, text) {
  if(!editionWords.length || !rows.some(row=>new RegExp('(?<![a-z0-9])[1-9]\\d\\s*(?:'+powerBadgeSuffix+')(?![a-z])')
    .test(normalize(row.name))))return [];
  return distinct(observedPowerGrades(editionWords,text).map(x=>x.variant));
}

function observedPowerGrades(editionWords,text) {
  const grades=[];
  for(const word of editionWords){
    const name=word.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
    const suffix='(?![\\d.]|\\s*(?:公里|千米|km|万|w|块|元|年|月|座|岁))';
    const pair=new RegExp(name+'(?:版|型)?\\s*([1-9]\\d)'+suffix+
      '|(?<![a-z0-9.])([1-9]\\d)\\s*'+name,'g');
    for(const match of text.matchAll(pair)){
      const number=match[1]||match[2];
      grades.push({variant:'power-grade:'+number,i:match.index+(match[1]?match[0].lastIndexOf(number):0)});
    }
  }
  return grades;
}

const vehicleJoiner = /[、/;；]|以及|还是|(?:和|跟|与|或|比)|\bvs\b/;

function closeLatinSeries(input, alias) {
  // Protect model numbers from typo correction: Model 7 isn't Model 3.
  if(input===alias || Math.abs(input.length-alias.length)>1
    || (input.match(/\d+/g)||[]).join('/')!==(alias.match(/\d+/g)||[]).join('/'))return null;
  let head=0,tail=0;
  while(head<Math.min(input.length,alias.length)&&input[head]===alias[head])head++;
  while(tail<Math.min(input.length,alias.length)-head &&
    input[input.length-1-tail]===alias[alias.length-1-tail])tail++;
  const a=input.slice(head,input.length-tail), b=alias.slice(head,alias.length-tail);
  if(a.length>1 || b.length>1 || !/^[a-z]*$/.test(a+b))return null;
  const length=Math.max(input.length,alias.length), matched=head+tail;
  return matched>=4 && matched/length>=0.8 ? {matched,length,head,tail} : null;
}

const deletionKeys = word => [word,...Array.from(word,(_,i)=>word.slice(0,i)+word.slice(i+1))];
function closeHan(input, alias) {
  if(input===alias || Math.abs(input.length-alias.length)>1)return 0;
  let start=0, end=0, n=Math.min(input.length,alias.length);
  while(start<n&&input[start]===alias[start])start++;
  while(end<n-start&&input[input.length-1-end]===alias[alias.length-1-end])end++;
  return input.length-start-end<=1 && alias.length-start-end<=1 ? start+end : 0;
}

function nearTrimCode(word, target) {
  if(word.length!==target.length || word.length<4)return false;
  const differences=[...word].flatMap((c,i)=>c===target[i]?[]:[i]);
  return differences.length===1 || differences.length===2 && differences[1]===differences[0]+1 &&
    word[differences[0]]===target[differences[1]] && word[differences[1]]===target[differences[0]];
}

function inferTrimWords(rows,text,series) {
  const label=compact(series.brandName+series.name);
  const lexicon=distinct(rows.flatMap(row=>trimLabels(row.name,label))).filter(w=>w.length<=8);
  const result=[];
  for(const m of text.matchAll(/([\u3400-\u9fff]{2,8})(型|版)/g)){
    const input=m[1];
    if(lexicon.some(w=>input.endsWith(w)) || /(?:中配|高配|低配|版本|型式)$/.test(input))continue;
    const matches=lexicon.flatMap(w=>[-1,0,1].flatMap(n=>{
      const length=w.length+n;
      if(length<2 || length>input.length)return [];
      const piece=input.slice(-length), matched=closeHan(piece,w);
      // 型/版 and an already fixed series are additional evidence for a two-Han trim.
      return matched && matched+1>=Math.ceil((Math.max(length,w.length)+1)*2/3)?[{w,matched,length}]:[];
    }));
    matches.sort((a,b)=>b.matched-a.matched || b.length-a.length);
    if(matches.length){
      const choices=distinct(matches.filter(x=>x.matched===matches[0].matched&&x.length===matches[0].length).map(x=>x.w));
      // Ambiguous spelling repairs are alternatives within this family,
      // not simultaneous constraints or a reason to change the car's brand.
      result.push({from:input,to:choices.length===1?choices[0]:'near-trim:'+choices.join('|')});
    }
  }
  return result;
}

function matchesEngine(row, series, engine) {
  const title=normalize(row.name);
  const literal=engine.replace('.','\\.').replace(/(?<=\d)(?=[tl]$)/,'\\s*');
  if (new RegExp('(?<![\\d.])'+literal+'(?![\\d.])').test(title)) return true;
  const label=compact(title);
  return engineCatalog.some(rule=>rule.brand===series.brandName && rule.series===series.name
    && (!rule.years || rule.years.includes(Number(row.year)))
    && [engine,...(/^\d\.\d$/.test(engine)?[engine+'t',engine+'l']:[])]
      .some(key=>rule.engines[key]?.some(badge=>label.includes(badge))));
}

function hasOpaqueEngineBadge(row,series) {
  const title=normalize(row.name), name=compact(title);
  if(!/(?<![a-z0-9.])(?:\d{2,3}\s*(?:tfsi|tsi|thp|turbo|t)|[a-z]{1,5}\s*\d{3}(?:\s*[ilhed]{1,2})?)(?![a-z0-9])/.test(title)
      || /(?<![\d.])\d\.\d\s*(?:[tl]|升|自吸)/.test(title))return false;
  return !engineCatalog.some(rule=>rule.brand===series.brandName && rule.series===series.name
    && (!rule.years || rule.years.includes(+row.year))
    && Object.values(rule.engines).flat().some(badge=>name.includes(badge)));
}

function seatCount(title) {
  const m=normalize(title).match(/(?<!\d)([2-9二两三四五六七八九])\s*[座坐]/);
  return m?chineseNumber(m[1]):null;
}

// Ancillary dates are not registration dates. Mask only the date inside its
// local clause, so a later explicit 上牌 cue can still introduce a real date.
function registrationDateText(text) {
  const auxiliary=/保险|强险|交强险|商业险|年检|审车|保养|脱保|费用|质保|到期/;
  return text.replace(/[^,，。;；!?！？]+/g,clause=>{
    const spans=[...clause.matchAll(/(?<![\d.])(?:(?:19|20)\d{2}|\d{1,2})\s*(?:年款|款|年|月(?:份)?|上牌|落户)/g)];
    let out=clause;
    for(const m of spans.reverse()){
      const before=clause.slice(0,m.index), after=clause.slice(m.index+m[0].length);
      const context=before.split(/上牌|落户|年款/).at(-1);
      const isAuxiliary=auxiliary.test(context) || /^(?:\s*\d{1,2}\s*月(?:份)?)?\s*(?:份)?\s*(?:保险|强险|交强险|商业险|年检|审车|保养|脱保|费用|质保|到期|续保)/.test(after);
      const actual=/^(?:\s*\d{1,2}\s*月(?:份)?)?\s*(?:份)?\s*(?:上牌|落户)/.test(after);
      if(isAuxiliary&&!actual)out=out.slice(0,m.index)+' '.repeat(m[0].length)+out.slice(m.index+m[0].length);
    }
    return out;
  }).replace(/((?:19|20)\d{2}|\d{2})\s*年\s*(1[0-2]|[1-9])\s*(?=上牌|落户)/g,'$1年$2月');
}

// Grade words rank the compatible trims of the chosen year only.
// Rank distinct guide prices so duplicated emissions/seat variants do not skew it.
function gradePreference(rows, grade) {
  const price=r=>Number(String(r.catalog_price ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*万(?:元)?\s*$/)?.[1]);
  if(!grade)return null;
  const prices=rows.map(price);
  const levels=distinct(prices.filter(p=>p>0)).sort((a,b)=>a-b);
  const second=grade==='次顶配'||grade==='次低配';
  if(!levels.length || ((second||grade==='顶配'||grade==='最低配') && prices.some(p=>!(p>0))) ||
      (second && levels.length<2))return null;
  const index=grade==='低配'||grade==='最低配'?0:grade==='次低配'?1:grade==='次顶配'?levels.length-2:
    grade==='高配'||grade==='顶配'?levels.length-1:Math.floor((levels.length-1)/2);
  const target=levels[index];
  return r=>price(r)>0? -Math.abs(price(r)-target) : -Infinity;
}

function chineseNumber(value) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const shortened=value.match(/^([一二两三四五六七八九十百]+)万([一二两三四五六七八九])$/);
  if(shortened)return chineseNumber(shortened[1])*10000+chineseNumber(shortened[2])*1000;
  const digits = '零一二三四五六七八九';
  let total = 0, part = 0, n = 0;
  for (const ch of value.replace(/两/g, '二').replace(/〇/g,'零').match(/\d+(?:\.\d+)?|[零一二三四五六七八九十百千万]/g)||[]) {
    if (/^\d/.test(ch)) n=Number(ch);
    else if (digits.includes(ch)) n = digits.indexOf(ch);
    else if (ch === '万') { total += (part + n || 1) * 10000; part = n = 0; }
    else { part += (n || 1) * { 十: 10, 百: 100, 千: 1000 }[ch]; n = 0; }
  }
  return total + part + n;
}

function withoutPrices(text) {
  // Amounts can precede the price cue. “7w还值多少” remains odometer shorthand;
  // neither a bare 万 nor an arbitrary decimal is by itself evidence of a price.
  return text
    .replace(/(?:首付|贷款金额|尾款)\s*[:：]?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)\s*(?:万元?|w|元|块钱?)/g,' ')
    .replace(/(?:维修(?:记录|费(?:用)?|花了?|用了?|总额)?|修车(?:费(?:用)?|花了?)?|出险金额|理赔(?:金额|了)?|定损(?:金额|了)?|保养(?:费(?:用)?|花了?))\s*[:：]?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)\s*(?:万元?|w|元|块钱?)(?![a-z\d.]|\s*(?:多|左右|上下)?\s*(?:公里|千米|km))/g,' ')
    .replace(/(?:预算|卖价|想卖|出价|报价|成交价|开价|要价|标价|喊价|砍到)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:万元?|w|元|块钱?)?(?![\d.tl]|公里)/g,' ')
    .replace(/(?<![\d.])\d+(?:\.\d+)?\s*(?:万元|万块钱?|块钱|元(?:钱)?)/g,' ')
    .replace(/(?<![\d.])\d+(?:\.\d+)?\s*(?:(?:万|w)\s*)?(?:多|左右|上下)?\s*(?=[,， ]*(?:能买(?:吗|不|么)?|能不能买|可以买|值得买|值不值|合不合适|划算吗|能入手|能拿下))/g,' ')
    .replace(/(?<![\d.])\d+(?:\.\d+)?(?:\s*(?:万|w))?\s*(?=(?:(?:这|那)(?:个)?|的)?(?:价(?:格|钱)?|要价|卖价)|(?:能|还能|可以)砍|贵(?:吗|不贵)|能买(?:吗|不))/g,' ');
}

// Remove only thousands separators inside an explicitly labeled odometer,
// not punctuation between facts such as an amount and a city.
const normalizeGroupedMileage = text => text.replace(
  /(?<![\d.])(?<!\d[,，])\d{1,3}(?:[,，]\d{3})+(?=\s*(?:多|左右|上下)?\s*(?:公里|千米|km)(?![a-z]))/gi,
  value=>value.replace(/[,，]/g,''));
function extractMileage(text, {fallbackOnInvalid=false}={}) {
  text=normalizeGroupedMileage(text);
  let rest = withoutPrices(text).replace(/(?:续航|cltc|wltp)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:万公里|公里|km)?/g, ' ');
  let unreadable=false;
  function clearUnreadable(pattern) {
    rest=rest.replace(pattern,()=>{unreadable=true;return ' ';});
  }
  // Consume the entire mixed numeral before the unit-bearing regex can grab
  // only its tail (10万零俩千公里 -> 10万, never 千公里 -> 0.1万).
  rest=rest.replace(/(?<![\d.])(\d+|[一二两三四五六七八九十百]+)\s*万\s*(零?\s*(?:俩|两|[一二三四五六七八九]|\d+)\s*千(?:[零一二两三四五六七八九十百\d\s]*))\s*(?:多|左右|上下|来)?\s*(公里|千米|km)/g,
    (_,major,remainder,unit)=>{
      const extra=remainder.includes('俩')?0:chineseNumber(remainder.replace(/\s/g,''));
      return (chineseNumber(major)+extra/10000)+'万'+unit;
    });
  // A malformed group is not a second chance to parse only its last digits.
  clearUnreadable(/\d+(?:[,，]\d{1,3})*[,，]\d{1,2}\s*(?:多|左右|上下)?\s*(?:公里|千米|km)(?![a-z])/gi);
  rest=rest.replace(/(?<![\d.])(\d{1,2})\s*万\s*([1-9]\d{3})\s*(?:多|左右)?\s*(公里|km)(?![a-z])/g,
    (_,wan,km,unit)=>(Number(wan)+Number(km)/10000)+'万'+unit);
  clearUnreadable(/(?<![\d.])\d+(?:\.\d+)?\s*(?:(?:万|w)?\s*(?:公里|千米|km)|万|w)?\s*[-~–—至到]\s*\d+(?:\.\d+)?\s*(?:(?:万|w)?\s*(?:公里|千米|km)|万|w)/g);
  clearUnreadable(/(?:(?:公里数|里程)\s*[:：]?\s*)?(?<!\d)\d+万\d{1,3}(?![\d千百十])\s*(?:公里|千米|km)?|(?:公里数|里程)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?=$|[，,。！？!?])/g);
  clearUnreadable(/(?<![零〇一二两三四五六七八九十百千万点])[一二两三四五六七八九]{2,}\s*万\s*(?:公里|千米|km)/g);
  const explicit=[], bareValues=[];
  rest = rest.replace(/(?:公里数\s*[:：]?\s*|里程\s*[:：]?\s*|跑了\s*|行驶\s*)?((?<![\d.])\d+(?:\.\d+)?|(?<![零一二两三四五六七八九十百千万])[零一二两三四五六七八九十百千万]+)\s*(万|w)?\s*(?:多|左右|上下|来)?\s*(公里|千米|km)|(?<![\d.])(?:(公里数|里程|跑了|行驶)\s*[:：]?\s*)?(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+)\s*(?:万|w)(?![a-z0-9千百十车元块])/g,
    (_, n, scale, unit, bareLabel, bare, offset, input) => {
      const count = chineseNumber(n || bare);
      const shorthand = n && /^\d+\.\d+$/.test(n) && count < 100 && unit === '公里'
        && !/(?:实际(?:才|只)?(?:跑|行驶)?|实跑|仅行驶|仅跑)\s*$/.test(input.slice(0,offset));
      (unit||bareLabel?explicit:bareValues).push(Number((scale || bare || shorthand ? count : count / 10000).toFixed(6)));
      return ' ';
    });
  clearUnreadable(/\d+\s*(?:万|w)?\s*(?:公里|千米|km)|(?:公里数|里程)\s*[:：]?\s*\d+(?:\.\d+)?/g);
  // An odometer unit or label outweighs free-standing “7万”, which may
  // be a price or other amount. True conflicting odometers stay unresolved.
  const mileage=distinct(explicit.length?explicit:bareValues);
  if((unreadable && !explicit.length) || mileage.length>1 || mileage.some(v=>!Number.isFinite(v)||v<=0||v>100)){
    return fallbackOnInvalid?{value:10,defaulted:true,unresolved:true,rest}:null;
  }
  return { value: mileage[0] ?? 10, defaulted: !mileage.length, rest };
}

const quoteCue = /多少钱|值多少|多少收|多少米|什么价|啥价|报价|估价|卖多少|价还能砍|能收吗|收不收/;
const modelCode = /(?<![a-z0-9.])[a-z]{1,8}[- ]?\d{1,4}[a-z]{0,5}(?![a-z0-9.])/;
const vehicleYear = /(?<![\d.])(?:(?:19|20)\d{2}(?=\s|[\u3400-\u9fff]|$)|\d{1,2}\s*(?=年|款|上牌))/g;
const vehicleDistance = /(?<![\d.])(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(?:(?:万|w)?\s*(?:公里|千米|km)|[万w](?![\da-z元块]))/g;
const vehiclePower = /(?<![\d.])\d\.\d\s*(?:t|l|自吸|涡轮)(?![a-z])/g;
const calendarYear = token => token.length===2?(+token>=70?1900:2000)+ +token:+token;
const modelYearRange=/(?<![a-z\d.])((?:19|20)\d{2}|\d{2})\s*[-‐‑‒–—−~至到]\s*((?:19|20)\d{2}|\d{2})(?=\s*(?:年款|款))/g;
const colorDescriptor = /^(?:[黑白银灰蓝红绿黄棕紫橙金]色|香槟色)/;
// Only a single name-shaped token in front of an explicit quote request.
// Bare chatter stays ignored if this token has no corroborating catalog entry.
const conciseQuoteLabel=/^(?:(?:主播|老板|请问|您好)[，,\s]*)*(?<label>[\u3400-\u9fff]{3,7}?)\s*[,，]?\s*(?:多少钱|多少米|多少收|还?值多少(?:钱)?|什么价|估个价)[啊呀吗呢?？。!！]*$/d;

function maybeUnknownVehicle(raw, hasBrand) {
  // Keep unresolved but credible leads around for improving the catalog. Bare
  // year/mileage, on the other hand, is not evidence of a particular car.
  const coded = raw.replace(/(?<![\da-z])(?:4s|6at|7dct|8at)(?![a-z0-9])/g,' ');
  const badge=coded.match(modelCode)?.[0];
  const clean = withoutPrices(raw);
  const hasYear = clean.search(vehicleYear)>=0;
  const hasDistance = clean.search(vehicleDistance)>=0;
  const hasPower = clean.search(vehiclePower)>=0;
  if (badge && (hasBrand || hasYear || hasDistance || hasPower || quoteCue.test(raw)
    || removeSeparators(raw)===removeSeparators(badge)))return true;
  const label = clean.replace(vehicleYear,' ').replace(vehicleDistance,' ').replace(vehiclePower,' ')
    .replace(/(?:年款|款|年|月|上牌|上路|公里数|里程|行驶|跑了|这车|那车|新车|二手车|什么价(?:格)?|还?值多少(?:钱)?|多少(?:钱|收|米)?|能收吗|收不收|卖多少|报价|估价|大概|主播|老板|请问)/g,' ');
  if(!/[\p{L}]{2}/u.test(label))return false;
  return (hasBrand && (hasYear || hasDistance || hasPower || quoteCue.test(raw)))
    || (hasDistance && (hasYear || hasPower || quoteCue.test(raw)));
}

function makeParser(db, { today = () => new Date(), familyAliases = trimFamilies } = {}) {
  const byFirst = new Map(), spacedLatinFamilies=[];
  const badgeStems = new Map(), seriesRows = new Map(), codeCache = new Map();
  const latinSeriesByBrand = new Map();
  const numberedFamilyAliases = new Map();
  const labelMakes=new Map();
  const abbreviatedFamilies = new Map();
  const titleLookup=makeTitleLookup(db);
  const hanByDeletion = new Map();
  const familyByName = new Map();
  const preferredBareCodes = new Set();
  const seriesKey = row => JSON.stringify([row.category,row.brand,row.id]);
  const versionQuery = db.prepare('select count(*) n, max(updated_at) t from metadata');
  const modelQuery = db.prepare('select id,year,name,min_registration_year lo,max_registration_year hi,catalog_price,rowid catalog_order from models where category=? and brand_id=? and series_id=?');
  let version, cities, provinces, brands, brandKeys, placeTokens, trimIndex;
  const preferredSeries = { l6:'理想l6', l7:'理想l7', l8:'理想l8', l9:'理想l9', mega:'理想mega' };
  function isOnlyBrandLabel(key,row) {
    const label=removeSeparators(key), make=removeSeparators(catalogMake(row.brandName));
    return brandKeys.has(label) || label===make ||
      (/^[\u3400-\u9fff]{2,}$/.test(label) && make.startsWith(label) && /^[a-z]{2,}$/.test(make.slice(label.length)));
  }
  function add(key, row, variant = '', shortSeries = false, omittedSeriesSuffix = false) {
    if (!key || key.length===1 && !/^[\u3400-\u9fff]$/.test(key) || /^\d+$/.test(key)) return;
    // A generated alias must retain some series identity. Preserve actual catalog
    // names, but do not make a brand token an alias of an unrelated full series.
    if(key!==compact(row.name) && key!==catalogFamilyName(row) && isOnlyBrandLabel(key,row))return;
    if (!byFirst.has(key[0])) byFirst.set(key[0], []);
    const entry={key,row,variant,shortSeries,omittedSeriesSuffix};
    byFirst.get(key[0]).push(entry);
    if(row.brandName===preferredBrandForBareCodes && bareSeriesCode.test(key))preferredBareCodes.add(key);
    if(!variant && !shortSeries){
      const brand=compact(row.brandName);
      const alias=(key.startsWith(brand)?key.slice(brand.length):key).replace(/\(进口\)$/,'');
      const hanAlias=alias.match(/^([\u3400-\u9fff]{3,7})([a-z]{1,5}\d{0,3})?$/);
      if(row.category!=='commercial' && hanAlias){
        for(const deletion of deletionKeys(hanAlias[1])){
          if(!hanByDeletion.has(deletion))hanByDeletion.set(deletion,new Map());
          hanByDeletion.get(deletion).set(alias+seriesKey(row),{alias:hanAlias[1],suffix:hanAlias[2]||'',row});
        }
      }
      if(alias.length>=5 && /^[a-z]{4,16}(?:\d{1,4}[a-z]{0,3})?$/.test(alias)){
        if(!latinSeriesByBrand.has(brand))latinSeriesByBrand.set(brand,new Map());
        const aliases=latinSeriesByBrand.get(brand);
        if(!aliases.has(alias))aliases.set(alias,new Map());
        aliases.get(alias).set(seriesKey(row),row);
      }
    }
    return entry;
  }
  function addWithBrand(alias, row, variant = '', approvedAlias=false, requiresVehicleContext=false) {
    // Do not emit either “奥迪” or “奥迪AUDI奥迪” for “奥迪E7X”.
    if(isOnlyBrandLabel(alias,row) && alias!==catalogFamilyName(row))return;
    const entry=add(alias,row,variant);
    if(entry&&approvedAlias)Object.assign(entry,{approvedAlias:true,requiresVehicleContext});
    if(!alias.startsWith(compact(row.brandName))){
      const branded=add(compact(row.brandName)+alias,row,variant);
      if(branded&&approvedAlias)branded.approvedAlias=true;
    }
  }

  function refresh() {
    const next = JSON.stringify(versionQuery.get());
    if (next === version) return;
    version = next;
    byFirst.clear();spacedLatinFamilies.length=0;badgeStems.clear();seriesRows.clear();codeCache.clear();latinSeriesByBrand.clear();hanByDeletion.clear();familyByName.clear();numberedFamilyAliases.clear();trimIndex=null;
    labelMakes.clear();preferredBareCodes.clear();abbreviatedFamilies.clear();titleLookup.clear();
    brands=distinct(db.prepare('select distinct name from brands').all().map(r=>removeSeparators(r.name)).filter(b=>b.length>=2))
      .sort((a,b)=>b.length-a.length);
    brandKeys=new Set(brands);
    const series = db.prepare('select s.category,s.brand_id brand,s.id,s.name,b.name brandName from series s join brands b on s.category=b.category and s.brand_id=b.id');
    for (const row of series.iterate()) {
      const b = compact(row.brandName), key = compact(row.name);
      if(row.category!=='commercial'){
        for(const label of normalize(row.name).match(/[a-z]{2,}/g)||[]){
          if(!labelMakes.has(label))labelMakes.set(label,new Set());
          labelMakes.get(label).add(b);
        }
      }
      // Preserve literal catalog word boundaries in names like “Model Y” and
      // “Model Y L”. A brand-qualified one-letter nickname is generated only
      // from a complete single-letter series, never its longer sibling.
      const phrase=normalize(row.name).replace(/\(进口\)$/,'').match(/^(电动)?([a-z]{2,12}(?:[ \t]+[a-z0-9]{1,14}){1,3})$/);
      if(row.category!=='commercial' && phrase){
        const parts=phrase[2].split(/[ \t]+/);
        spacedLatinFamilies.push({row,pattern:new RegExp('(?<![a-z0-9])'+parts.join('[ \\t]+')+'(?![a-z0-9])','g'),last:parts.at(-1),electric:!!phrase[1]});
        if(!phrase[1] && parts.length===2 && /^[a-z]$/.test(parts[1])){
          const entry=add(b+parts[1],row);
          if(entry)Object.assign(entry,{brandQualifiedSingleLetter:true,approvedAlias:true});
        }
      }
      // Catalog brackets are alternate spellings, not mandatory text in a viewer's comment.
      const bracket = key.match(/^([^\[\]]+)\[([a-z0-9\u3400-\u9fff]{2,})\]$/);
      const k = bracket ? bracket[1] : key;
      seriesRows.set(seriesKey(row),row);
      for(const rule of familyAliases){
        if(rule.brand!==row.brandName || rule.series!==row.name)continue;
        for(const name of rule.names.map(compact)){
          const entries=familyByName.get(name)||[];
          entries.push({row,key:name,variant:rule.trim,catalogFamily:true,refinesSeries:rule.refinesSeries});
          familyByName.set(name,entries);
        }
      }
      if (bracket) add(key,row);
      add(k,row);
      if (!k.startsWith(b)) add(b+k,row);
      else add(k.slice(b.length),row);
      // Catalogs prepend the manufacturer/location to the marque (北京现代),
      // or repeat a suffix of it (广汽传祺/传祺GS4). Derive the actual code
      // from those catalog boundaries, not from a hand-written car whitelist.
      const innerMake=k.indexOf(b);
      if(row.category!=='commercial' && innerMake>0 && /^[\u3400-\u9fff]+$/.test(k.slice(0,innerMake)) && bareSeriesCode.test(k.slice(innerMake+b.length))){
        add(k.slice(innerMake),row);add(k.slice(innerMake+b.length),row);
      }
      const spokenMake=catalogMake(row.brandName);
      const unbranded=k.startsWith(spokenMake)?k.slice(spokenMake.length):'';
      // Keep name-shaped shorthands (“旅行者”), not generic numbered
      // labels such as “1号”, which routinely occur in registration dates.
      if(spokenMake!==b && spokenMake.length>=2 && (/^[\u3400-\u9fff]{2}/.test(unbranded)||row.category!=='commercial'&&bareSeriesCode.test(unbranded)))add(unbranded,row);
      for(const alias of seriesAliases.filter(a=>a.brand===row.brandName && a.series===row.name))
        for(const name of alias.names)addWithBrand(compact(name),row,'',true,alias.requiresVehicleContext);
      if(k.endsWith('(进口)')){
        const base=k.slice(0,-4);
        const bare=base.startsWith(b)?base.slice(b.length):base;
        // Single Latin stems still need a known model badge. “NX999” must
        // not silently become “NX” just because we removed “(进口)”.
        if (/[\u3400-\u9fff]|\d/.test(bare)){
          addWithBrand(base,row);
          if(base.startsWith(b))add(base.slice(b.length),row);
        }
        else if(/^[a-z]{3,8}$/.test(bare)){
          add(bare,row,'',true);add(b+bare,row,'',true);
        }
      }
      const short=(k.startsWith(b)?k.slice(b.length):k);
      const namedBadge=short.match(/^([a-z]{1,5}\d{1,4})([\u3400-\u9fff]{2,5})$/);
      if(namedBadge && !/新能源|纯电|插混|混动/.test(namedBadge[2])){
        add(namedBadge[1],row,'',true);add(b+namedBadge[1],row,'',true);
        // A shared edition adjective never becomes a standalone car name:
        // H5经典 and i6经典 are valid complete names; 经典 alone is not.
        const suffix=namedBadge[2].replace(/(?:版|型|款)$/,'');
        if(!genericTrim.test(suffix) && !/^(?:风尚|尊荣|智享|豪享|畅享|实用|冠军|卓越|性能|运动感)$/.test(suffix)){
          add(namedBadge[2],row,'',true);add(b+namedBadge[2],row,'',true);
        }
      }
      if(row.category!=='commercial' && /^[a-z]{1,5}\d{1,3}l$/.test(short)){
        add(short.slice(0,-1),row,'',true,true);add(b+short.slice(0,-1),row,'',true,true);
      }
      if(k.startsWith(b) && /^[a-z]{1,6}级$/.test(k.slice(b.length))){
        add(k.slice(0,-1),row,'',true);
      }
      // Catalog brands sometimes repeat the first part of the series:
      // “吉利帝豪” + “帝豪GS” is spoken as “吉利帝豪GS”.
      for(let n=Math.min(b.length,k.length-1);n>=2;n--){
        if(b.endsWith(k.slice(0,n)) && /^[\u3400-\u9fff]+$/.test(k.slice(0,n))){
          add(b+k.slice(n),row);
          if(row.category!=='commercial'&&bareSeriesCode.test(k.slice(n)))add(k.slice(n),row);
          break;
        }
      }
      // Some spoken combinations elide a single character shared by the
      // manufacturer and its numbered family: 方程豹 + 豹5 → 方程豹5.
      if(/^[\u3400-\u9fff]\d{1,3}$/.test(k) && b.endsWith(k[0]))add(b+k.slice(1),row);
      const seriesStem=(k.startsWith(b)?k.slice(b.length):k).replace(/\(进口\)$/,'').replace(/级$/,'');
      if(/^[a-z]{1,6}$/.test(seriesStem) && row.category!=='commercial'){
        if(!badgeStems.has(seriesStem[0]))badgeStems.set(seriesStem[0],[]);
        badgeStems.get(seriesStem[0]).push({row,stem:seriesStem});
      }
      if (bracket) {
        addWithBrand(bracket[2],row);
        const localName=k.slice(b.length).match(/^(\d+)([\u3400-\u9fff]{2,})$/);
        if (k.startsWith(b) && localName) {
          // E.g. 马自达3 昂克赛拉[昂克塞拉]. Do not register “马自达3” alone.
          const [,modelNumber,nickname]=localName;
          addWithBrand(nickname,row);
          add(b+modelNumber+bracket[2],row);
          add(modelNumber+bracket[2],row);
        }
      }
      // A named series owns the alphanumeric suffix in its catalog name:
      // e.g. “天逸 C5” is one alias, not a separate hit on another brand's C5.
      // Keep powertrain qualifiers distinct; bare “天逸” denotes the unqualified series.
      const named = k.match(/^([\u3400-\u9fff]{2,})([a-z]{1,5}\d{1,4})(?:aircross|picasso|x)(新能源)?$/);
      if (named) {
        const [,head,code,qualifier=''] = named;
        addWithBrand(head+qualifier,row);
        addWithBrand(head+code+qualifier,row);
      }
      if (b==='奔驰' && k==='奔驰glc级') {
        // Only use this shorthand for the domestic GLC; official import/AMG names stay separate.
        addWithBrand('glc',row);
      }
      if (b === '雷克萨斯' && k === '雷克萨斯es(进口)') {
        for (const trim of ['200','240','250','260','300h','350']) {
          add('雷克萨斯es'+trim,row,trim); add('es'+trim,row,trim);
        }
      }
      if (b==='大众' && k==='高尔夫') for (const prefix of [k,b+k]) add(prefix+'pro',row,'pro');
      if (Object.values(preferredSeries).includes(k)) {
        const short = k.slice('理想'.length);
        const variants = ['pro','max','ultra','air','livis'];
        for (const word of variants) for (const prefix of [k,short]) add(prefix+word,row,word);
        if (short === 'l8') for (const prefix of [k,short]) add(prefix+'李维斯',row,'livis');
        if (/^l[789]$/.test(short)) for (const prefix of [k,short]) add(prefix+'u',row,'ultra');
      }
    }
    // Derive spoken forms from the actual model family. Don't rewrite
    // arbitrary numbers in an entire comment (year, distance, or price).
    const catalogNames=[...byFirst.values()].flat();
    for(const a of catalogNames){
      const mixed=a.key.match(/^([a-z]{1,8})(\d{1,4})([\u3400-\u9fff]{2,12})$/);
      if(!mixed || a.variant)continue;
      const entries=numberedFamilyAliases.get(mixed[1])||[];
      entries.push({digits:mixed[2],label:mixed[3],row:a.row});numberedFamilyAliases.set(mixed[1],entries);
    }
    const peerFamilies=new Map();
    for(const row of seriesRows.values()){
      const key=catalogMake(row.brandName)+':'+catalogFamilyName(row);
      const entries=peerFamilies.get(key)||[];
      entries.push(row);peerFamilies.set(key,entries);
    }
    for(const {key,row,variant} of catalogNames){
      if(variant)continue;
      const peers=peerFamilies.get(catalogMake(row.brandName)+':'+catalogFamilyName(row));
      for(const peer of peers||[]){
        if(!sameCrossCatalogFamily(row,peer))continue;
        const other=compact(peer.brandName);
        if(key===catalogFamilyName(row) && !key.startsWith(other))add(other+key,row);
      }
      if(row.category==='commercial')continue;
      const number=key.match(/^(.+[^\d]|[^\d])([1-9])$/);
      if(number && /[\u3400-\u9fff]/.test(number[1]))
        add(number[1]+'零一二三四五六七八九'[Number(number[2])],row);
      // A spoken series may omit the whole Latin stem. Index the complete
      // digits and written Chinese prefix; never index a number by itself.
      const omitted=key.match(/^([\u3400-\u9fff]{2,})([a-z])([1-9]\d{1,2})$/);
      if(omitted){
        const entries=abbreviatedFamilies.get(omitted[3])||[];
        if(!entries.some(e=>e.key===key&&seriesKey(e.row)===seriesKey(row)))entries.push({prefix:omitted[1],key,row});
        abbreviatedFamilies.set(omitted[3],entries);
      }
    }
    cities = db.prepare('select province_id provinceId,id cityId,name from cities').all();
    provinces = db.prepare('select id,name from provinces').all();
    placeTokens = distinct([...provinces,...cities].map(r=>removeSeparators(r.name)).filter(n=>n.length>=2))
      .sort((a,b)=>b.length-a.length);
  }

  function brandOnly(plain, brand) {
    // Directory-generated brand/location pairs, e.g. “天津 劳斯莱斯汽车”.
    let rest=plain.replace(brand,'').replace(/多少(?:钱|收|米)?$|什么价(?:格)?$|啥价$|能收吗$|报价$|估价$/,'');
    while (rest) {
      const lexeme=rest.match(/^(?:汽车|品牌|4s店|经销商|车)/)?.[0]
        || placeTokens.find(p=>rest.startsWith(p));
      if(!lexeme)return false;
      rest=rest.slice(lexeme.length).replace(/^[省市区]/,'');
    }
    return true;
  }

  function getTrimIndex() {
    if(trimIndex)return trimIndex;
    trimIndex=new Map();
    const query=db.prepare("select category, brand_id brand, series_id id, name from models where category <> 'commercial'");
    for(const item of query.iterate()){
      const key=seriesKey(item), row=seriesRows.get(key);
      if(!row)continue;
      for(const [word,quality] of catalogTrimEvidence(item,row)){
        if(genericTrim.test(word))continue;
        if(!trimIndex.has(word))trimIndex.set(word,new Map());
        const entries=trimIndex.get(word);
        const parent=row.brand+':'+row.id;
        const previous=entries.get(parent);
        if(!previous || quality>previous.quality)entries.set(parent,{row,quality});
      }
    }
    return trimIndex;
  }

  function lookupModelCode(code, brand = '') {
    const cacheKey=brand+':'+code;
    if(codeCache.has(cacheKey))return codeCache.get(cacheKey);
    const spaced=/^[a-z]+\d/.test(code);
    const sqlTitle=spaced?"replace(replace(lower(name),' ',''),char(9),'')":"lower(name)";
    const query=db.prepare("select category,brand_id brand,series_id id,name from models where category in ('passenger','energy') and "+sqlTitle+" like ?");
    const found=new Set();
    const variant=(/^\d+$/.test(code)?'model-root:':'model-code:')+code;
    for(const r of query.iterate('%'+code+'%')){
      const key=seriesKey(r);
      const series=seriesRows.get(key);
      if(series && (!brand || compact(series.brandName)===brand) && matchTrimVariant(r,variant))found.add(key);
    }
    // Build a bounded cache against the current catalog, no external search.
    if(codeCache.size>=256)codeCache.delete(codeCache.keys().next().value);
    const result=[...found].map(key=>seriesRows.get(key));
    codeCache.set(cacheKey,result);return result;
  }

  function lookupNumberBadge(number,suffix,brand) {
    const variant='number-badge:'+number+':'+suffix, cacheKey=brand+':'+variant;
    if(codeCache.has(cacheKey))return codeCache.get(cacheKey);
    const found=new Map();
    const query=db.prepare("select category,brand_id brand,series_id id,name from models where category <> 'commercial' and lower(name) like ?");
    for(const item of query.iterate('%'+number+'%')){
      const key=seriesKey(item), row=seriesRows.get(key);
      if(row && catalogMake(row.brandName)===catalogMake(brand) && matchTrimVariant(item,variant))found.set(key,row);
    }
    if(codeCache.size>=256)codeCache.delete(codeCache.keys().next().value);
    const result=[...found.values()];codeCache.set(cacheKey,result);
    return result;
  }

  function explain(comment, secondPass=false, rescue=false, titlePass=false) {
    const source=normalize(comment?.text).trim();
    const filtered=prefilterComment(source,source.length<=500?removeSeparators(source):'');
    if(filtered)return filtered;
    // Resolve “22-23款” before compacting: otherwise E260 and the
    // year range run together. Bare prices, distances and badges stay intact.
    // A dangling decimal before an engine unit is a spoken 2.0T-style
    // displacement, not punctuation connecting T to the following odometer.
    const raw=normalizeGroupedMileage(maskPaint(source)).replace(/4s\s*店/g,m=>' '.repeat(m.length)).replace(/(?<![a-z\d.])([1-6])\.\s*([tl])(?=[^a-z]|$)/g,'$1.0$2').replace(modelYearRange,(whole,first,last)=>
      calendarYear(first)<=calendarYear(last) && calendarYear(last)<=today().getFullYear()?last:whole);
    const plain=removeSeparators(raw);
    const concise=raw.match(conciseQuoteLabel);
    refresh();
    const namedBrand=brands.find(b=>plain.includes(b));
    if(namedBrand && brandOnly(plain,namedBrand))return ignore('只有品牌或地区，缺少具体车系');
    const offsets=[]; let s='';
    // Spaces are word boundaries throughout recall. Never build a new word
    // by concatenating tokens from the viewer's sentence.
    for(let i=0;i<raw.length;i++)if(!/[·・-]/.test(raw[i])){s+=raw[i];offsets.push(i);}

    // Prevent an engine token from starting a false series such as T10 in “1.6T10万”.
    const powerSpans=[...raw.matchAll(/(?<![\d.])\d\.\d\s*(?:t|l|自吸)/g)]
      .map(m=>[m.index,m.index+m[0].length]);
    // “里程4万” labels a number; it does not add a second car (本田里程).
    // A complete branded name starts outside this label span and still works.
    const mileageLabels=[...raw.matchAll(/(?:公里数|里程)(?=\s*(?:[:：]\s*\d|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)\s*(?:万|w|公里|千米|km)))/g)]
      .map(m=>[m.index,m.index+m[0].length]);
    const hits = [], rowCache=new Map();
    function rowsFor(row) {
      const k=seriesKey(row);
      if(!rowCache.has(k))rowCache.set(k,modelQuery.all(row.category,row.brand,row.id));
      return rowCache.get(k);
    }
    const brandSpans=[];
    for(const key of brands){
      for(let i=s.indexOf(key);i>=0;i=s.indexOf(key,i+key.length)){
        const end=i+key.length;
        if(!brandSpans.some(b=>b.i<=i && b.end>=end))brandSpans.push({key,i,end});
      }
    }
    for (let i=0;i<s.length;i++) for (const a of byFirst.get(s[i]) || []) {
      if (!s.startsWith(a.key,i)) continue;
      if(a.requiresVehicleContext && !(raw.search(vehicleDistance)>=0 || /上牌|续航|快充|慢充/.test(raw)))continue;
      // Do not fabricate a badge by joining a separated number to a model suffix (C5 6万 ≠ C56).
      let splitNumber=false;
      for(let j=1;j<a.key.length;j++){
        if (/\d/.test(a.key[j-1]) && /\d/.test(a.key[j]) && offsets[i+j]!==offsets[i+j-1]+1) {
          splitNumber=true; break;
        }
        // Whitespace can belong to a real name (BMW X 3), but a separately
        // written measured number is not a model suffix (T 10万公里 ≠ T10).
        if(/[a-z]/.test(a.key[j-1]) && /\d/.test(a.key[j]) && offsets[i+j]!==offsets[i+j-1]+1 &&
          /^\d+(?:\.\d+)?\s*(?:万|w|公里|千米|km|元|块|年|月|款)(?![a-z])/.test(raw.slice(offsets[i+j]))){
          splitNumber=true;break;
        }
      }
      if (splitNumber) continue;
      if (powerSpans.some(([start,end])=>offsets[i]>=start && offsets[i]<end)) continue;
      if (mileageLabels.some(([start,end])=>offsets[i]>=start && offsets[i]<end)) continue;
      if (/^[a-z]/.test(a.key) && /[a-z]/.test(s[i-1] || '')) continue;
      const tail=s.slice(i+a.key.length);
      if(preferredBareCodes.has(a.key) && /^(?:号)?纸/.test(tail))continue;
      if(a.key.length===1 && !/^(?:燃油|纯油|油车|纯电|混动|插混|ev|dm)/.test(tail))continue;
      if(a.shortSeries && offsets[i+a.key.length]===offsets[i+a.key.length-1]+1 &&
        /^[a-z0-9]/.test(tail) && !/^(?:\d{2}|\d{4})(?:年|款)/.test(tail))continue;
      if(a.brandQualifiedSingleLetter && /^[ \t]*[a-z]/.test(tail))continue;
      if (a.row.name==='奔驰GLC级' && /glc(?:级)?$/.test(a.key)) {
        const badge=tail.match(/^([1-9]\d{2}[led])(?=[^a-z]|$)|^([1-9]\d{2})(?![a-z0-9])/);
        const grade=badge?.[1]||badge?.[2];
        if (grade) {
          hits.push({...a,variant:'badge:glc:'+grade,i,end:i+a.key.length+grade.length,key:a.key+grade});
          continue;
        }
        if (/^\d/.test(tail) && !/^(?:\d{2}|\d{4})(?:年|款|月)/.test(tail)) continue;
      }
      const touchesTail=offsets[i+a.key.length]===offsets[i+a.key.length-1]+1;
      if (/\d$/.test(a.key) && touchesTail && /^\d/.test(tail) && !/^(?:\d{2}|\d{4})(?:年|款)/.test(tail)) continue;
      if (a.variant==='ultra' && /u$/.test(a.key) && /^[a-z]/.test(tail)) continue;
      hits.push({...a,i,end:i+a.key.length});
    }
    for(const m of raw.matchAll(/(?<![a-z\d.])([1-9]\d{1,2})(?!\d)/g)){
      const entries=abbreviatedFamilies.get(m[1]), stop=m.index+m[1].length;
      if(!entries || !familyNumberEndsHere(raw.slice(stop)))continue;
      const left=raw.slice(0,m.index).trimEnd(), d=offsets.indexOf(m.index), end=d+m[1].length;
      if(d<0)continue;
      for(const {prefix,key,row} of entries){
        if(!left.endsWith(prefix))continue;
        const i=offsets.indexOf(left.length-prefix.length);
        if(i<0)continue;
        hits.push({row,key:prefix+m[1],variant:'',i,end,
          modelSpans:[{i,end:i+prefix.length},{i:d,end}],
          nearMatch:{alias:key,matched:prefix.length+m[1].length,length:key.length,
            omittedStem:key.length-prefix.length-m[1].length}});
      }
    }
    // Match complete catalog phrases without joining arbitrary words in the
    // viewer's sentence. A shorter family and its longer sibling may overlap;
    // the existing whole-series comparison keeps the stronger complete name.
    for(const {row,pattern,last,electric} of spacedLatinFamilies)for(const m of s.matchAll(pattern)){
      const i=m.index,end=i+m[0].length;
      if(electric && !/(?:纯电|电动)/.test(raw))continue;
      if(/^\d+$/.test(last) && /^\s*(?:万|w|公里|千米|km|元|块|年|月|款)/.test(s.slice(end)))continue;
      if(powerSpans.some(([start,stop])=>offsets[i]>=start&&offsets[i]<stop))continue;
      hits.push({row,key:m[0],variant:'',i,end});
    }
    // A brand-qualified, explicitly separated family code is a phrase made
    // of two tokens, not a rewritten word. Check both against catalog parts;
    // a measured number is never allowed to occupy the family-number slot.
    for(const m of s.matchAll(/(?<![a-z0-9.])([a-z]{1,6})[ \t]+([1-9]\d{0,3}[a-z]{0,2})(?![a-z0-9.])/g)){
      const i=m.index,end=i+m[0].length;
      if(/^\s*(?:万|w|公里|千米|km|元|块|年|月|款)(?![a-z])/.test(s.slice(end)))continue;
      const brand=brandSpans.find(b=>b.end<=i && /^\s*$/.test(s.slice(b.end,i)));
      if(!brand)continue;
      for(const a of byFirst.get(m[1][0])||[]){
        const code=a.key.match(/^([a-z]{1,6})(\d{1,4}[a-z]{0,2})$/);
        if(!code||code[1]!==m[1]||code[2]!==m[2]||catalogMake(a.row.brandName)!==catalogMake(brand.key))continue;
        hits.push({...a,key:m[0],i,end,nearMatch:{alias:a.key,matched:a.key.length,length:a.key.length},
          modelSpans:[{i,end:i+m[1].length},{i:end-m[2].length,end}]});
      }
    }
    // A viewer can omit the final powertrain letter of a confirmed badge.
    // Only relax a bare numeric query, never a different number or typed suffix.
    function fitsBadge(name,stem,grade) {
      return matchCatalogBadge(name,stem,grade,true) || rescue && /^\d+$/.test(grade) &&
        ['h','e','i','d'].some(letter=>matchCatalogBadge(name,stem,grade+letter));
    }
    const fitsVariant=(m,v)=>matchTrimVariant(m,v,true) ||
      (rescue && v.startsWith('badge:') && fitsBadge(m.name,...v.split(':').slice(1)));
    // A short alphabetic series prefix only becomes a match if the full badge
    // exists on a real catalog trim. E.g. C-200L, NX 260, E300L.
    for(let i=0;i<s.length;i++){
      const entries=badgeStems.get(s[i]);
      if(!entries || (/[a-z0-9.]/.test(s[i-1]||'') && offsets[i]===offsets[i-1]+1)
        || powerSpans.some(([start,end])=>offsets[i]>=start && offsets[i]<end))continue;
      for(const {row,stem} of entries){
        if(!s.startsWith(stem,i))continue;
        const startOfSuffix=i+stem.length;
        const link=s.slice(startOfSuffix).match(new RegExp('^(?:(?:\\(进口\\)|级(?:[ \\t]*'+stem+')?)?[,，]?[ \\t]*)'))?.[0]||'';
        if(link.includes('(进口)')&&!compact(row.name).endsWith('(进口)'))continue;
        const at=startOfSuffix+link.length;
        const gradeMatch=s.slice(at).match(/^([1-9]\d{2}(?:[ \t]*[a-z]{1,2})?)(?=$|[^a-z0-9]|(?:19|20)\d{2}(?:年|款)|\d{1,2}(?:年|款)|\d{1,2}(?:万|w)(?:公里|km|$))/);
        const grade=gradeMatch&&compact(gradeMatch[1]);
        if(!grade)continue;
        const context=brandSpans.find(b=>b.end===i);
        if(context && context.key!==compact(row.brandName))continue;
        const end=at+gradeMatch[0].length;
        if(grade.split('').some((ch,n)=>n>0 && /\d/.test(ch) && offsets[at+n]!==offsets[at+n-1]+1))continue;
        if(!rowsFor(row).some(r=>fitsBadge(r.name,stem,grade)))continue;
        const start=context?.i??i;
        hits.push({row,key:s.slice(start,end),variant:'badge:'+stem+':'+grade,i:start,end});
      }
    }
    // A performance label and a badge can be two fields in a comment.
    // Validate the division against the actual family and the WHOLE badge
    // against a concrete trim. Punctuation outside the pair stays untouched.
    function addDivisionBadge(m,division,code){
      const i=m.index,end=i+m[0].length;
      const context=brandSpans.find(b=>b.end<=i && /^[ \t,，]*$/.test(s.slice(b.end,i)));
      const named=brandSpans.filter(b=>b.end<=i||b.i>=end);
      if(!labelMakes.has(division))return true;
      const rows=lookupModelCode(code).filter(row=>
        new RegExp('(?<![a-z])'+division+'(?![a-z])').test(normalize(row.name)));
      // A distinctive division belongs to one maker. A written but
      // unverified code must not degrade to a random car from that maker.
      if(!rows.length && labelMakes.get(division).size===1 && !genericTrim.test(division) &&
          !trimMentions().test(division) && !brandKeys.has(division))return false;
      if(rows.length && named.some(b=>!rows.some(row=>b.key===compact(row.brandName))))
        return false;
      for(const row of rows){
        const start=context?.i??i;
        hits.push({row,key:s.slice(start,end),variant:'model-code:'+code,i:start,end,divisionBadge:code});
      }
      return true;
    }
    // Pair complete fields rather than deleting punctuation across the comment.
    // Also read joined spellings using labels from this catalog, not a make whitelist.
    const sep='[ \\t,，、。.:：;；/\\-]+', code='[a-z]{1,5}[ \\t]*\\d{2,}[a-z]{0,2}';
    const badgePair=new RegExp('(?<![a-z0-9.])(?:([a-z]{2,12})'+sep+'('+code+')|('+code+')'+sep+'([a-z]{2,12}))(?![a-z0-9]|\\.\\d)','g');
    const pairs=[...s.matchAll(badgePair)].map(m=>({m,division:m[1]||m[4],code:compact(m[2]||m[3]),last:!!m[2]}));
    for(const m of s.matchAll(/(?<![a-z0-9.])([a-z]{3,16})(\d{2,})|(?<![a-z0-9.])([a-z]{1,5})(\d{2,})([a-z]{2,12})(?![a-z0-9])/g)){
      if(pairs.some(p=>p.m.index<=m.index && p.m.index+p.m[0].length>=m.index+m[0].length))continue;
      if(m[3]){
        if(labelMakes.has(m[5]))pairs.push({m,division:m[5],code:m[3]+m[4]});
      }else if(!/[a-z0-9.]/.test(s[m.index+m[0].length]||'')){
        for(let n=m[1].length-1;n>=2;n--){
          const division=m[1].slice(0,n);
          if(!labelMakes.has(division)||m[1].length-n>5||brandKeys.has(division))continue;
          pairs.push({m,division,code:m[1].slice(n)+m[2],last:true});break;
        }
      }
    }
    for(const pair of pairs){
      const {m,division,code,last}=pair;
      if(last && /^\s*(?:万|公里|km|元|块|年|款)/.test(s.slice(m.index+m[0].length)))continue;
      if(!addDivisionBadge(m,division,code))
        return skip('MODEL_CONFLICT','目录里没有同时符合品牌、系列标识和型号的车');
    }
    // An explicit make + two-digit alphanumeric badge can also identify
    // the trim (奔驰 G63). Do not infer G63 from a separate “G 63万公里”.
    for(const b of brandSpans){
      const m=s.slice(b.end).match(/^[ \t,，]*([a-z]{1,3})[ \t]*(\d{2})(?![a-z0-9.]|\s*(?:万|公里|km|年|款|元))/);
      if(!m)continue;
      const end=b.end+m[0].length,code=m[1]+m[2];
      if(hits.some(h=>h.end===end && h.i>=b.i && compact(h.row.brandName)===b.key && exactSeriesSpelling(h)))continue;
      for(const row of lookupModelCode(code,b.key))
        hits.push({row,key:s.slice(b.i,end),variant:'model-code:'+code,i:b.i,end});
    }
    // Numeric-leading model badges have no fixed relationship to the series
    // string (“325Li” is sold under “3系”). Reverse-lookup exact catalog codes.
    for(const m of s.matchAll(/[1-9]\d{2}(?:li|xdrive|dci|[ilhde])/g)){
      const i=m.index,end=i+m[0].length;
      if((/[a-z0-9.]/.test(s[i-1]||'') && offsets[i]===offsets[i-1]+1)
        || (/[a-z0-9]/.test(s[end]||'') && offsets[end]===offsets[end-1]+1 && !/^(?:m运动|\d{1,2}(?:万|w)(?:公里|km|\D|$))/.test(s.slice(end)))
        || offsets[i+2]!==offsets[i]+2 || hits.some(h=>h.i<=i && h.end>=end))continue;
      const context=brandSpans.find(b=>b.end===i);
      for(const row of lookupModelCode(m[0])){
        if(context && context.key!==compact(row.brandName))continue;
        const start=context?.i??i;
        hits.push({row,key:s.slice(start,end),variant:'model-code:'+m[0],i:start,end});
      }
    }
    for(const m of raw.matchAll(/(?<![a-z0-9.])([1-9]\d{2})(?![a-z0-9.]|\s*(?:公里|km|万|元|块|年|款|月|匹|马力))/g)){
      const code=m[1], i=offsets.indexOf(m.index), end=i+3;
      if(i<0 || hits.some(h=>h.i<=i&&h.end>=end))continue;
      const context=brandSpans.find(b=>b.end===i);
      // A bare catalog badge needs independent vehicle details, not a chat
      // amount. This is a reverse catalog lookup, never a fixed badge->brand map.
      if(!context && !(raw.search(vehicleYear)>=0 && raw.search(vehicleDistance)>=0 &&
          !/[\p{L}]/u.test(raw.slice(0,m.index).replace(/(?<![\d.])(?:(?:19|20)\d{2}|\d{1,2})\s*(?:年款|年|款|上牌)/g,'').replace(/主播|老板|请问|上牌|月份|月/g,'')) &&
          /^(?:\s*)(?:尊享|豪华|领先|舒适|时尚|运动|旗舰|精英)/.test(raw.slice(m.index+code.length))))continue;
      for(const row of lookupModelCode(code,context?.key)){
        const start=context?.i??i;
        hits.push({row,key:s.slice(start,end),variant:'model-root:'+code,i:start,end,codeSpan:{i,end}});
      }
    }
    // A detached badge can appear before the series (“260 创驰 NX 雷克萨斯”).
    // Bind it only with an explicit catalog brand and a real compatible model,
    // never by taking a bare number from the mileage, price or year.
    for(const gradeMatch of raw.matchAll(/(?<![a-z0-9.])([1-9]\d{2}[a-z]{0,2})(?![a-z0-9.])(?!\s*(?:元|万|块|公里|千米|年|款|月|这个价))/g)){
      const grade=gradeMatch[1], gradeStart=offsets.indexOf(gradeMatch.index);
      if(gradeStart<0 || /(?:km|kg|kw|cc|hp)$/.test(grade))continue;
      const gradeEnd=gradeStart+grade.length;
      for(let i=gradeEnd;i<Math.min(s.length,gradeEnd+12);i++){
        const gap=s.slice(gradeEnd,i).replace(/^[,，]+|[,，]+$/g,'').replace(/[版型]$/,'');
        if(vehicleJoiner.test(gap))continue;
        for(const {row,stem} of badgeStems.get(s[i])||[]){
          if(stem.length<2 || !s.startsWith(stem,i) || /[a-z0-9]/.test(s[i+stem.length]||'')
              && !brandSpans.some(b=>b.i===i+stem.length))continue;
          const end=i+stem.length;
          const brand=brandSpans.find(b=>b.key===compact(row.brandName) &&
            Math.abs(i-b.end)<20 && !vehicleJoiner.test(s.slice(Math.min(b.end,gradeStart),Math.max(b.i,end))));
          if(!brand || hits.some(h=>h.i<=i && h.end>=end && h.variant &&
            h.row.brand===row.brand && h.row.id===row.id))continue;
          const rows=rowsFor(row).filter(r=>matchCatalogBadge(r.name,stem,grade));
          if(!rows.length || gap && !seriesTrimWords(rows,gap,row).includes(gap))continue;
          hits.push({row,key:stem,variant:'badge:'+stem+':'+grade,i,end,extraSpans:[{i:gradeStart,end:gradeEnd}]});
        }
      }
    }
    const numberBadgeHints=[];
    const badgePattern=new RegExp('(?<![a-z0-9.])([1-9]\\d{1,2})(?:[ \\t]*('+catalogNumberBadgeSuffix+'))?(?![a-z0-9.])','g');
    for(const m of raw.matchAll(badgePattern)){
      const [token,number,suffix='']=m, i=offsets.indexOf(m.index), end=i+compact(token).length;
      if(i<0 || (number.length<3 && !suffix)
          || /^\s*(?:公里|千米|km|万|w|块|元|年|月|款|座|岁|个|台|马力|这个价)/.test(raw.slice(m.index+token.length))
          || /(?:价格|落地|多少|预算|报价|卖了?|给了?|要价)\s*[:：]?\s*$/.test(raw.slice(0,m.index)))continue;
      // Keep the typed span even if it is later masked for date/odometer parsing.
      const variant='number-badge:'+number+':'+suffix;
      if(hits.some(h=>h.i<=i&&h.end>=end&&h.variant && !h.variant.startsWith('model-root:')))continue;
      const context=brandSpans.find(b=>b.end<=i && /^[,，:：]*$/.test(s.slice(b.end,i)));
      const parents=new Set();
      for(const h of hits){
        if(h.variant?.startsWith('model-root:') || (h.i<end&&i<h.end)
            || context && catalogMake(h.row.brandName)!==catalogMake(context.key))continue;
        const gap=s.slice(Math.min(end,h.end),Math.max(i,h.i));
        if(gap.length>16 || vehicleJoiner.test(gap) || /(?:公里|落地|报价|多少)/.test(gap))continue;
        if(rowsFor(h.row).some(r=>matchTrimVariant(r,variant)))parents.add(seriesKey(h.row));
      }
      if(!parents.size && context){
        // Brand + an exact typed badge can recover the series from its trims.
        // A full but contradictory series is not swapped out for another car.
        for(const row of lookupNumberBadge(number,suffix,context.key)){
          const key=seriesKey(row);
          parents.add(key);
          hits.push({row,key:s.slice(context.i,end),variant,i:context.i,end,reverseTrim:true});
        }
      }
      numberBadgeHints.push({i,end,variant,parents});
    }
    // Repair only a known trim token inserted strictly inside a catalog alias.
    // The reconstructed name still participates in normal cross-series ambiguity checks.
    for (const trim of s.matchAll(new RegExp('('+trimWords+')(?:版|型)?','g'))) {
      const cut=trim.index, after=cut+trim[0].length;
      if(!cut||after>=s.length)continue;
      const joined=s.slice(0,cut)+s.slice(after);
      for(let i=Math.max(0,cut-64);i<cut;i++)for(const a of byFirst.get(joined[i])||[]){
        const end=i+a.key.length;
        if(a.variant||end<=cut||!joined.startsWith(a.key,i))continue;
        // Only rejoin model names where the next character is part of that same name.
        if(!/[\u3400-\u9fff]/.test(joined[cut-1]) || !/[\u3400-\u9fffa-z]/.test(joined[cut])
          || (a.key.match(/[\u3400-\u9fff]/g)||[]).length<2)continue;
        hits.push({...a,variant:trim[1],i,end:end+trim[0].length});
      }
    }
    // Match a catalog's mixed code by its full textual suffix and its
    // numeric value. Leading zeros may vary; a different model number may not.
    for(const m of raw.matchAll(/(?<![a-z0-9.])([a-z]{1,8})[ \t-]*(\d{1,4})(?!\d)/g)){
      const [token,prefix,digits]=m, i=offsets.indexOf(m.index), at=i+compact(token).length;
      if(i<0)continue;
      const context=brandSpans.find(b=>b.end===i);
      const entries=(numberedFamilyAliases.get(prefix)||[]).filter(entry=>
        s.startsWith(entry.label,at) && (!context || catalogMake(entry.row.brandName)===catalogMake(context.key)));
      if(!entries.length)continue;
      const compatible=entries.filter(entry=>+entry.digits===+digits);
      if(!compatible.length)return skip('MODEL_CONFLICT','评论中的型号数字和车系名称不一致');
      if(!secondPass)continue;
      for(const {row,label,digits:officialDigits} of compatible){
        const end=at+label.length, alias=prefix+officialDigits+label;
        if(digits===officialDigits && hits.some(h=>seriesKey(h.row)===seriesKey(row)&&h.i<=i&&h.end>=end))continue;
        const numeralStart=at-Math.min(digits.length,officialDigits.length);
        hits.push({row,key:s.slice(i,end),variant:'',i,end,modelSpans:[{i,end:i+prefix.length},{i:numeralStart,end}],
          nearMatch:{alias,matched:prefix.length+label.length+Math.min(digits.length,officialDigits.length),
            length:prefix.length+label.length+Math.max(digits.length,officialDigits.length)}});
      }
    }
    // Known brand + near-unique catalog spelling can produce a candidate
    // even when none of the exact name/code lookups hit.
    const hasVehicleDetails=raw.search(vehicleYear)>=0 && raw.search(vehicleDistance)>=0;
    if(brandSpans.length || secondPass && hasVehicleDetails){
      const exact=hits.slice();
      for(const m of raw.matchAll(/(?<![a-z0-9.])[a-z]{4,16}(?:[ \t-]*\d{1,4}[a-z]{0,3}|[ \t-]+[a-z])?(?![a-z0-9.])/g)){
        // “Pasat 6万公里” contains an odometer, not a model numbered 6.
        const measured=/\d$/.test(m[0]) && /^\s*(?:万|w|公里|千米|km|元|块|年|款|月)/.test(raw.slice(m.index+m[0].length));
        const phrase=measured?m[0].replace(/[ \t-]*\d+$/,''):m[0];
        const token=compact(phrase),i=offsets.indexOf(m.index),end=offsets.indexOf(m.index+phrase.length-1)+1;
        if(i<0 || end<=i || token.length<5 || brandSpans.some(b=>b.i<end && i<b.end))continue;
        // Never override an exact match. A typo after an explicit separator
        // may still reveal a second car; leave that decision to multi-car guard.
        if(exact.some(h=>(h.i<end && i<h.end)
          || !vehicleJoiner.test(s.slice(Math.min(h.end,end),Math.max(h.i,i)))))continue;
        const nearby=distinct(brandSpans.filter(b=>!vehicleJoiner.test(s.slice(Math.min(b.end,end),Math.max(b.i,i)))).map(b=>b.key));
        if(nearby.length!==1 && !(secondPass && !brandSpans.length && hasVehicleDetails))continue;
        const catalogs=nearby.length?[latinSeriesByBrand.get(nearby[0])].filter(Boolean):latinSeriesByBrand.values();
        const matches=[];
        for(const catalog of catalogs)for(const [alias,rows] of catalog){
          const evidence=closeLatinSeries(token,alias);
          if(evidence && (nearby.length || evidence.matched>=5))matches.push({alias,rows,evidence});
        }
        matches.sort((a,b)=>b.evidence.matched/b.evidence.length-a.evidence.matched/a.evidence.length);
        if(!matches.length)continue;
        const best=matches.filter(m=>m.evidence.matched*matches[0].evidence.length===matches[0].evidence.matched*m.evidence.length);
        // Same spelling may exist in domestic and imported catalog series;
        // defer that choice to the ordinary import rule.
        if(best.length>1 && distinct(best.flatMap(m=>[...m.rows.keys()])).length>1)
          return skip('AMBIGUOUS_SERIES','型号 '+token+' 同时接近 '+best.map(x=>x.alias).join(' / '));
        const {rows,alias,evidence}=best[0];
        const missingStart=i+evidence.head,missingEnd=end-evidence.tail;
        const modelSpans=[{i,end:missingStart},{i:missingEnd,end}];
        for(const row of rows.values())hits.push({row,key:token,variant:'',i,end,modelSpans,nearMatch:{alias,...evidence}});
      }
    }
    if((secondPass||!hits.length||hits.every(h=>h.key.length<=2)) &&
        (brandSpans.length || hasVehicleDetails || secondPass && concise)){
      for(const run of s.matchAll(/[\u3400-\u9fff]{2,12}/g))for(let start=0;start<run[0].length;start++){
        const i=run.index+start;
        for(let size=2;size<=8 && start+size<=run[0].length;size++){
          const end=i+size, key=s.slice(i,end);
          if(brandSpans.some(b=>b.i<end&&i<b.end) || placeTokens.includes(key))continue;
          if(secondPass && hits.some(h=>!h.nearMatch && h.i<=i && h.end>=end && h.key.length>=3))continue;
          const candidates=new Map();
          for(const del of deletionKeys(key))for(const [k,v] of hanByDeletion.get(del)||[])candidates.set(k,v);
          for(const {alias,suffix,row} of candidates.values()){
            if(namedBrand && compact(row.brandName)!==namedBrand)continue;
            const suffixText=suffix&&s.slice(end).match(new RegExp('^'+suffix.split('').join('[ \\t]*')))?.[0];
            const rawEnd=suffixText?end+suffixText.length:end;
            if(suffix && rawEnd===end || !suffix && /^[a-z]/.test(s[end]||''))continue;
            const matched=closeHan(key,alias);
            if(matched<2 || matched/Math.max(size,alias.length)<2/3)continue;
            // A two-out-of-three match without a brand needs a catalog trim
            // or an engine as independent evidence, not just the year.
            const wholeAskedName=secondPass && concise && [offsets[i],offsets[end-1]+1].every(
              (pos,n)=>pos===concise.indices.groups.label[n]) && size===alias.length;
            if(!namedBrand && matched<=2 && !wholeAskedName){
              const rest=s.slice(0,i)+' '+s.slice(end), rows=rowsFor(row);
              const engine=rest.match(/(?<![\d.])(\d\.\d)\s*([tl])?/);
              if(!seriesTrimWords(rows,rest,row).length && !numberBadgeHints.some(h=>
                  !vehicleJoiner.test(s.slice(Math.min(h.end,end),Math.max(h.i,i))) &&
                  rows.some(m=>matchTrimVariant(m,h.variant))) &&
                !(engine && rows.some(m=>matchesEngine(m,row,engine[1]+(engine[2]||'')))))continue;
            }
            let head=0,tail=0;
            while(head<matched&&key[head]===alias[head])head++;
            while(tail<matched-head&&key[size-tail-1]===alias[alias.length-tail-1])tail++;
            hits.push({row,key:s.slice(i,rawEnd),variant:'',i,end:rawEnd,modelSpans:[{i,end:i+head},{i:end-tail,end:rawEnd}],
              nearMatch:{alias:alias+suffix,matched:matched+suffix.length,length:Math.max(size,alias.length)+suffix.length,
                homophone:size===alias.length && phoneticKey(key)===phoneticKey(alias)}});
          }
        }
      }
    }
    // Rescue runs only after both normal passes failed. Generate candidates
    // from the actual catalog and the observed name slot, not the whole sentence.
    const datedLead=raw.search(vehicleYear)>=0 || raw.search(vehicleDistance)>=0;
    const swallowedByBrand=h=>brandSpans.some(b=>b.i<=h.i && h.end<=b.end &&
      catalogMake(b.key)!==catalogMake(h.row.brandName));
    if(rescue && datedLead && hits.every(swallowedByBrand)){
      for(let n=hits.length-1;n>=0;n--)if(swallowedByBrand(hits[n]))hits.splice(n,1);
      const slots=[];
      for(const match of s.matchAll(/(?:^|(?:\d{2,4}\s*(?:年款|年|款)(?:的)?))\s*([\u3400-\u9fff]{2})/g))
        slots.push({word:match[1],i:match.index+match[0].lastIndexOf(match[1])});
      for(const b of brandSpans){
        const m=/^\s*([\u3400-\u9fff]{2})/.exec(s.slice(b.end));
        if(m)slots.push({word:m[1],i:b.end+m[0].indexOf(m[1]),brand:b.key});
      }
      const push=(row,i,end,alias,matched,extra={})=>hits.push({row,i,end,key:s.slice(i,end),variant:'',
        nearMatch:{alias,matched,length:Math.max(end-i,alias.length)},...extra});
      for(const row of seriesRows.values()){
        if(row.category==='commercial'||namedBrand && catalogMake(row.brandName)!==catalogMake(namedBrand))continue;
        const make=compact(row.brandName), family=catalogFamilyName(row);
        const alias=family.startsWith(make)?family.slice(make.length):family;
        const bilingual=alias.match(/^[a-z]{4,}([\u3400-\u9fff]{2,6})$/);
        if(bilingual && !genericTrim.test(bilingual[1]) && !isOnlyBrandLabel(bilingual[1],row)){
          const word=bilingual[1],i=s.indexOf(word);
          if(i>=0)push(row,i,i+word.length,alias,word.length);
        }
        if(/^[\u3400-\u9fff]{2}$/.test(alias))for(const {word,i,brand} of slots){
          if(brand && catalogMake(brand)!==catalogMake(make))continue;
          if(![0,1].some(n=>word[n]===alias[n]) || !shortHomophone(word,alias))continue;
          // Without a brand require a real numeric grade in this actual series.
          if(!brand && !numberBadgeHints.some(h=>h.i>=i+2 && h.i-i<=8 &&
            rowsFor(row).some(m=>matchTrimVariant(m,h.variant))))continue;
          const at=i+(word[0]===alias[0]?0:1);
          push(row,i,i+2,alias,1,{modelSpans:[{i:at,end:at+1}]});
        }
        const code=alias.match(/^([a-z]{1,6})(\d{1,3})([a-z]{0,8})$/);
        if(!code)continue;
        for(const brand of brandSpans.filter(b=>catalogMake(b.key)===catalogMake(make))){
          const obs=s.slice(brand.end).match(/^\s*(叉|艾克斯|埃克斯)?([1-9]\d{0,2})([a-z]{0,8})(?![a-z0-9.])/);
          if(!obs||obs[2]!==code[2] || (obs[1] && code[1]!=='x'))continue;
          const end=brand.end+obs[0].length;
          if(/^\s*(?:年|款|月|万|元|公里|千米|块|座|岁|马力|w|km)/.test(s.slice(end)))continue;
          if(obs[3] ? obs[3]!==code[3]&&!nearTrimCode(obs[3],code[3]) : Boolean(code[3]))continue;
          push(row,brand.end,end,alias,obs[2].length+(obs[3]===code[3]?code[3].length:Math.max(0,code[3].length-2)));
        }
      }
      // A non-generic edition written immediately after its make can be a
      // partial name. Keep ALL catalog parents, and rank their actual trims.
      if(!hits.length)for(const b of brandSpans.filter(b=>b.key===namedBrand)){
        const token=s.slice(b.end).match(/^\s*([\u3400-\u9fff]{3,7})(?=\d|版|型)/);
        if(!token)continue;
        const i=b.end+token[0].indexOf(token[1]);
        for(let n=token[1].length-1;n>=2;n--){
          const word=token[1].slice(0,n);
          if(!/^[家者型版]$/.test(token[1].slice(n)))continue;
          const found=[...(getTrimIndex().get(word)?.values()||[])].filter(x=>
            compact(x.row.brandName)===b.key && x.quality===2 && !genericTrim.test(word));
          if(!found.length)continue;
          const numberAt=i+token[1].length;
          const number=s.slice(numberAt).match(/^(\d{2,4})(?![0-9.])/);
          const numberHint=number && {key:number[1],i:numberAt,end:numberAt+number[1].length};
          for(const {row,quality} of found)hits.push({row,key:word,i,end:i+n,variant:word,quality,
            reverseTrim:true,partialEdition:true,numberHint});
          break;
        }
      }
    }
    // Fuzzy recall can discover a family only after a detached numeric badge
    // was scanned. Rebind the same typed span to that family before evaluation.
    for(const hint of numberBadgeHints)for(const h of hits){
      if(h.i<hint.end&&hint.i<h.end || hint.parents.has(seriesKey(h.row)))continue;
      const gap=s.slice(Math.min(h.end,hint.end),Math.max(h.i,hint.i));
      if(gap.length<=16 && !vehicleJoiner.test(gap) && !/(?:公里|落地|报价|多少)/.test(gap) &&
          rowsFor(h.row).some(m=>matchTrimVariant(m,hint.variant)))hint.parents.add(seriesKey(h.row));
    }
    // Known family names can identify a catalog parent even when the viewer
    // gives only the configuration family, not its make or series.
    const directHits=hits.slice(), familyHits=[], refinement=new Set();
    for(const [key,entries] of familyByName)for(let i=s.indexOf(key);i>=0;i=s.indexOf(key,i+key.length)){
      const end=i+key.length;
      if(/^[a-z]/.test(key) && /[a-z]/.test(s[i-1]||'') && offsets[i]===offsets[i-1]+1)continue;
      if(/[a-z]$/.test(key) && /[a-z]/.test(s[end]||'') && offsets[end]===offsets[end-1]+1)continue;
      for(const entry of entries){
        // If a real series name is present, preserve it rather than treating
        // its own family label as another vehicle in the same description.
        if(directHits.some(h=>{
          const from=Math.min(end,h.end),to=Math.max(i,h.i);
          return !vehicleJoiner.test(s.slice(from,to)) &&
            !(entry.refinesSeries===h.row.name && h.row.brand===entry.row.brand) &&
            (h.key.length>key.length || h.row.brand===entry.row.brand) &&
            rowsFor(h.row).some(m=>matchTrimVariant(m,entry.variant));
        }))continue;
        familyHits.push({...entry,i,end});
      }
    }
    const strongestFamilies=familyHits.filter(h=>!familyHits.some(other=>
      other.i<=h.i && other.end>=h.end && other.key.length>h.key.length));
    for(const family of strongestFamilies) for(const h of directHits){
      if(family.refinesSeries===h.row.name && h.row.brand===family.row.brand && !h.variant &&
        !vehicleJoiner.test(s.slice(Math.min(family.end,h.end),Math.max(family.i,h.i))))refinement.add(h);
    }
    if(refinement.size)for(let i=hits.length-1;i>=0;i--)if(refinement.has(hits[i]))hits.splice(i,1);
    hits.push(...strongestFamilies);

    // Configuration recall runs alongside brand/series recall. Restrict it
    // to words in vehicle-description positions, not any substring in chat.
    const trimCue=raw.search(vehicleYear)>=0 || raw.search(vehicleDistance)>=0 || quoteCue.test(raw) || brandSpans.length;
    const titleHits=hits.slice(), recalled=[];
    const partInquiry=!titleHits.length && /\d+(?:\.\d+)?\s*(?:元|块(?:钱)?)\s*的\s*(?:配件|零件|零部件)/.test(raw);
    const typedCodes=[...raw.matchAll(/(?<![a-z0-9.])([a-z]{1,6})[\s-]*([1-9]\d{2}[a-z]{0,2})(?![a-z0-9.])/g)];
    const conflictsWithTypedBadge=row=>typedCodes.some(([,stem,grade])=>
      (badgeStems.get(stem[0])||[]).some(entry=>entry.stem===stem && seriesKey(entry.row)===seriesKey(row))
      && !rowsFor(row).some(m=>fitsBadge(m.name,stem,grade)));
    for(const run of s.matchAll(/[\u3400-\u9fff]{2,}/g))for(let pos=0;pos<run[0].length-1;pos++){
      if(partInquiry)break;
      const i=run.index+pos;
      const left=s.slice(0,i);
      if(pos && !/(?:年款|年|款|月|上牌|白色|黑色|银色|红色|蓝色|灰色|请问|主播|我的是|我这辆|收一台|出一台|公里|千米|还是|以及|或者|和|与)$/.test(left)
        && !brandSpans.some(b=>b.end===i))continue;
      for(let size=Math.min(12,run[0].length-pos);size>=2;size--){
        const end=i+size,word=s.slice(i,end),right=s.slice(end);
        if(!trimCue && (i!==0 || !/^(?:版|型)?[。！？!?]*$/.test(right)))continue;
        const afterEdition=right.replace(/^(?:版|型|套装)(?!式)/,'');
        if(/^[\u3400-\u9fff]/.test(afterEdition) &&
          !colorDescriptor.test(afterEdition) &&
          !/^(?:多少|值多少|还能|怎么|多钱|什么价|换(?:过|了|水箱|大灯)|原版|小剐蹭|上牌|公里|没出险|[一二两三四五六七八九十百和与])/.test(afterEdition))continue;
        if(brandSpans.some(b=>b.i<end && i<b.end) || genericTrim.test(word))continue;
        // Do not expand a shortened edition back to competing models once
        // the same text explicitly identifies a powertrain-qualified family.
        if(titleHits.some(h=>h.catalogFamily && h.refinesSeries && h.i<=i && h.end>=end))continue;
        const matches=getTrimIndex().get(word);
        if(!matches)continue;
        // Common labels are useful as supporting evidence, but cannot by
        // themselves pick one of many unrelated vehicle families.
        if(isEquipment(word))continue;
        const entries=[...matches.values()].filter(({row})=>!namedBrand||compact(row.brandName)===namedBrand);
        if(!entries.length || entries.length>8)continue;
        const local=titleHits.filter(h=>!vehicleJoiner.test(s.slice(Math.min(end,h.end),Math.max(i,h.i))));
        for(const {row,quality} of entries){
          if(conflictsWithTypedBadge(row))continue;
          if(local.some(h=>h.row.brand===row.brand && h.row.id===row.id))continue;
          if(local.some(h=>h.catalogFamily && h.refinesSeries===row.name))continue;
          // An edition right next to a strongly identified series is a
          // configuration clue, not a second car merely sharing that word.
          if(local.some(h=>!h.catalogFamily && h.key.length>2 && (h.end<=i || end<=h.i)))continue;
          recalled.push({row,key:word,variant:word,i,end,reverseTrim:true,quality});
        }
      }
    }
    hits.push(...recalled.filter(h=>!recalled.some(other=>other.i<=h.i && other.end>=h.end
      && other.key.length>h.key.length && other.quality>=h.quality)));
    const written=describeTitle(raw,brands);
    if(titlePass){
      if(!written || (/\d$/.test(written.name) && !familyNumberEndsHere(raw.slice(written.end))))
        return skip('NO_SERIES','没有独立的车型字符线索');
      const i=offsets.indexOf(written.start),end=offsets.indexOf(written.end-1)+1;
      if(i<0||end<=i)return skip('NO_SERIES','没有可核对的车型名称位置');
      const allowed=new Set(hits.filter(exactSeriesSpelling).map(h=>seriesKey(h.row)));
      if(hits.some(a=>exactSeriesSpelling(a)&&hits.some(b=>exactSeriesSpelling(b)&&seriesKey(a.row)!==seriesKey(b.row)&&
          a.end<=b.i)))return skip('AMBIGUOUS_SERIES','有两个独立书写的车系名称');
      const matches=titleLookup.find(written,seriesRows).filter(f=>!allowed.size||allowed.has(seriesKey(f.row)));
      hits.length=0;
      for(const {row,names} of matches)hits.push({row,key:s.slice(i,end),i,end,variant:'',titleHit:names});
    }
    for(const brand of brandSpans){
      const m=/^[ \t,，:：]*([a-z]{1,7})[ \t]*(\d{3,4}[a-z]{0,2})(?![a-z0-9.]|\s*(?:万|公里|km|年|款|元))/.exec(s.slice(brand.end));
      if(!m)continue;
      const end=brand.end+m[0].length,code=m[1]+m[2];
      const sameMake=row=>catalogMake(row.brandName)===catalogMake(brand.key) ||
        (/^[\u3400-\u9fff]{2,}$/.test(brand.key) && compact(row.brandName).startsWith(brand.key));
      // Do not lose unrelated full model mentions elsewhere in a comparison.
      const inside=h=>h.i>=brand.i && h.i<end && h.end<=end;
      for(let n=hits.length-1;n>=0;n--)if(inside(hits[n])&&!sameMake(hits[n].row))hits.splice(n,1);
      const startOfCode=brand.end+m[0].indexOf(m[1]);
      if(hits.some(h=>inside(h) && h.i<=startOfCode && h.end===end && sameMake(h.row) && !h.reverseTrim && (h.variant||exactSeriesSpelling(h))))continue;
      let verified=lookupModelCode(code).filter(sameMake),variant='model-code:'+code;
      if(!verified.length && labelMakes.has(m[1])){
        // “GT535i” can be catalogued as series …GT, trim 535i.
        variant='model-code:'+m[2];
        verified=lookupModelCode(m[2]).filter(row=>sameMake(row)&&new RegExp('(?<![a-z])'+m[1]+'(?![a-z])').test(normalize(row.name)));
      }
      if(verified.length){
        const parents=new Set(verified.map(seriesKey));
        for(let n=hits.length-1;n>=0;n--)if(inside(hits[n])&&!parents.has(seriesKey(hits[n].row)))hits.splice(n,1);
      }
      for(const row of verified)hits.push({row,key:s.slice(brand.i,end),i:brand.i,end,variant});
    }
    if(!hits.length){
      if(maybeUnknownVehicle(raw,!!namedBrand))return skip('NO_SERIES','有车辆线索，但没有识别到明确车系');
      const label=concise?.groups.label;
      const checkName=!secondPass && label && deletionKeys(label).some(key=>
        [...(hanByDeletion.get(key)?.values()||[])].some(entry=>!entry.suffix &&
          entry.alias.length===label.length && closeHan(label,entry.alias)>=2));
      return {...ignore('评论没有可用于报价的车型线索'),...(checkName?{checkName:true}:{})};
    }
    // Never treat a brand suffix as a different brand (“雪铁龙” ≠ “铁龙”).
    const usable = hits.filter(h=>!(h.row.category==='commercial' && !h.variant &&
      h.key===compact(h.row.brandName) && h.key===compact(h.row.name)) &&
      !(h.codeSpan && h.variant?.startsWith('model-root:') && numberBadgeHints.some(
      span=>span.parents.size && span.i===h.codeSpan.i&&span.end===h.codeSpan.end)) &&
      !(h.codeSpan && hits.some(other=>other.extraSpans?.some(
      span=>span.i===h.codeSpan.i&&span.end===h.codeSpan.end))) &&
      !brandSpans.some(b=>b.i<=h.i && b.end>=h.end && (b.i<h.i||b.end>h.end||h.row.category==='commercial') && catalogMake(b.key)!==catalogMake(h.row.brandName)));
    if(!usable.length)return maybeUnknownVehicle(raw,!!namedBrand)
      ? skip('NO_SERIES','有车辆线索，但没有识别到明确车系')
      : ignore('评论没有可用于报价的车型线索');
    const same=(a,b)=>a.row.brand===b.row.brand && a.row.id===b.row.id;
    const intersect=(a,b)=>a.i<b.end && b.i<a.end;
    const gapBetween=(a,b)=>s.slice(Math.min(a.end,b.end),Math.max(a.i,b.i));
    const sameMention=(a,b)=>intersect(a,b) || !vehicleJoiner.test(gapBetween(a,b)) &&
      ((a.reverseTrim && !b.reverseTrim && b.key.length<=3) ||
       (b.reverseTrim && !a.reverseTrim && a.key.length<=3));
    const coveredPositions=spans=>{
      const chars=new Set();
      for(const {i,end} of spans)for(let n=i;n<end;n++)if(/[\p{L}\p{N}]/u.test(s[n]))chars.add(n);
      return chars;
    };
    const mentionedTrims=distinct(s.match(trimMentions())||[]);
    const ordinalSpans=[...s.matchAll(ordinalTrimTokens())].map(m=>({i:m.index,end:m.index+m[0].length}));
    const hybridSpans=[...s.matchAll(hybridCue)].map(m=>({i:m.index,end:m.index+m[0].length}));
    function modelEvidence(model,group,powerHints,engineHints,editionSpans){
      const series=group[0].row, title=compact(model.name);
      const brand=coveredPositions(group.flatMap(h=>h.brandSpan?[h.brandSpan]:[]));
      const seriesChars=new Set(), modelChars=new Set(), editionChars=new Map();
      const terms=catalogTrimEvidence(model,series);
      for(const v of mentionedTrims)if(matchTrimVariant(model,v) && !terms.has(v))terms.set(v,1);
      for(const h of group){
        if(!h.reverseTrim && !h.catalogFamily){
          for(const i of coveredPositions(h.modelSpans||[h]))if(!brand.has(i))seriesChars.add(i);
        }
        if(title.includes(compact(h.key)) || h.nearMatch || h.approvedAlias || (h.variant && fitsVariant(model,h.variant))){
          for(const i of coveredPositions([...(h.modelSpans||[h]),...(h.extraSpans||[])]))modelChars.add(i);
        }
        if(h.reverseTrim){
          // Match edition numbers only as distinct catalog tokens, never the
          // “202” prefix of a year such as 2025, or part of a longer number.
          if(h.numberHint && new RegExp('(?<![a-z0-9.])'+h.numberHint.key+'(?![0-9.])')
              .test(normalize(model.name).replace(/^\s*\d{4}\s*款/,'')))
            for(const i of coveredPositions([h.numberHint]))modelChars.add(i);
          for(const i of coveredPositions([h]))editionChars.set(i,terms.get(h.variant)||0);
        }
      }
      for(const p of brand)if(title.includes(compact(series.brandName)))modelChars.add(p);
      for(const hint of powerHints)if(matchTrimVariant(model,hint.variant)){
        const from=offsets.indexOf(hint.i),to=offsets.indexOf(hint.i+1);
        if(from>=0 && to>=0)for(const p of coveredPositions([{i:from,end:to+1}]))modelChars.add(p);
      }
      for(const hint of numberBadgeHints)if(hint.parents.has(seriesKey(series)) && matchTrimVariant(model,hint.variant)){
        for(const p of coveredPositions([hint]))modelChars.add(p);
      }
      for(const hint of engineHints)if(matchesEngine(model,series,hint.engine)){
        const from=offsets.indexOf(hint.i),to=offsets.indexOf(hint.end-1);
        if(from>=0 && to>=0)for(const p of coveredPositions([{i:from,end:to+1}]))modelChars.add(p);
      }
      if(matchTrimVariant(model,'powertrain:hybrid'))for(const span of hybridSpans){
        if(group.some(h=>!vehicleJoiner.test(gapBetween(h,span))))
          for(const i of coveredPositions([span]))modelChars.add(i);
      }
      for(const [word,quality] of terms){
        if(isEquipment(word))continue;
        if(/^(?:[黑白蓝灰银红绿金黄棕]色|大灯|水箱)$/.test(word))continue;
        for(let i=s.indexOf(word);i>=0;i=s.indexOf(word,i+word.length)){
          const span={i,end:i+word.length};
          if(ordinalSpans.some(g=>g.i<=span.i && span.end<=g.end))continue;
          if(group.every(h=>vehicleJoiner.test(gapBetween(h,span))))continue;
          for(const p of coveredPositions([span])){
            modelChars.add(p);
            editionChars.set(p, Math.max(editionChars.get(p)||0,quality));
          }
        }
      }
      for(const {i,end,variant} of editionSpans)if(!variant || fitsVariant(model,variant))
        for(const pos of coveredPositions([{i,end}]))modelChars.add(pos);
      const strengths=[...editionChars.values()].reduce((sum,n)=>sum+n,0);
      const relevant=new Set([...brand,...seriesChars,...modelChars]);
      // Sets deduplicate WITHIN each layer, not across layers: the same
      // token can independently support the family and the concrete row.
      return {brand:brand.size,series:seriesChars.size,model:modelChars.size,
        characters:brand.size+seriesChars.size+modelChars.size,
        score:2*brand.size+2*seriesChars.size+3*modelChars.size+strengths,relevant};
    }
    for(const h of usable){
      const brandKey=compact(h.row.brandName);
      const localBrands=brandSpans.filter(b=>{
        if (intersect(h,b))return b.key===brandKey;
        if(vehicleJoiner.test(gapBetween(h,b)))return false;
        // A full branded model at a separate position owns its own brand.
        // Do not use “瑞驰” from a second “瑞驰C5” to rank the first “C5”.
        if(usable.some(other=>!intersect(h,other) && other.i<=b.i && other.end>b.end
          && compact(other.row.brandName)===b.key))return false;
        return !brandSpans.some(other=>other!==b
          && ((b.end<=other.i && other.end<=h.i)||(h.end<=other.i && other.end<=b.i)));
      });
      const brand=localBrands.find(b=>b.key===brandKey || catalogMake(b.key)===catalogMake(brandKey));
      // A standalone brand in this same description is a hard constraint only
      // where no stronger branded hit has claimed it for another car.
      h.brandConflict=!brand && localBrands.length>0 &&
        (h.catalogFamily || h.reverseTrim || h.variant?.startsWith('badge:') || h.variant?.startsWith('model-code:')
          || /^[a-z]{1,6}\d{1,4}[a-z]{0,3}$/.test(h.key)
          || localBrands.some(b=>usable.some(other=>!same(h,other)&&b.key===compact(other.row.brandName)
              && other.i<=b.i && other.end>=h.end && intersect(other,h))));
      if(brand && !intersect(h,brand)) h.brandContext=brand;
      h.brandSpan=brand;
      const base=[...(h.modelSpans||[h]),...(brand?[brand]:[]),...(h.extraSpans||[])];
      h.covered=coveredPositions(base);h.coverage=h.covered.size;
      // Only competing aliases need trim comparison. Count the BEST SINGLE
      // compatible catalog row, never the sum of two different configurations.
      if(!usable.some(other=>!same(h,other) && intersect(h,other)))continue;
      const label=compact(h.row.brandName+h.row.name);
      for(const row of rowsFor(h.row)){
        if(h.variant && !matchTrimVariant(row,h.variant))continue;
        const explicitTokens=mentionedTrims.filter(v=>matchTrimVariant(row,v));
        const spans=distinct([...trimLabels(row.name,label),...explicitTokens]).flatMap(word=>{
          if(/^(?:黑色|白色|蓝色|灰色|银色|红色|绿色|金色|黄色|棕色)$/.test(word))return [];
          const matches=[];
          for(let i=s.indexOf(word);i>=0;i=s.indexOf(word,i+word.length)){
            const span={i,end:i+word.length};
            if(vehicleJoiner.test(gapBetween(h,span)))continue;
            if(usable.some(other=>!same(h,other) && !intersect(h,other)
              && other.key.startsWith(compact(other.row.brandName))
              && intersect(other,span)))continue;
            matches.push({...span,word});
          }
          return matches;
        });
        const covered=coveredPositions([...base,...spans]);
        if(covered.size>h.coverage){h.covered=covered;h.coverage=covered.size;h.coverageWords=spans.map(span=>span.word);}
      }
    }
    const eligible=usable.filter(h=>!h.brandConflict);
    if(!eligible.length)return skip('NO_SERIES','评论中的品牌和型号未匹配到同一车系');
    const initialHits = strongestSeriesHits(eligible);
    const isTrimWord = new RegExp('^(?:'+trimWords+')$');
    const editionSpanCache=new Map();
    function observedEditionSpans(main) {
      if(editionSpanCache.has(main))return editionSpanCache.get(main);
      const rows=rowsFor(main.row), words=new Set();
      for(const model of rows)for(const [word,quality] of catalogTrimEvidence(model,main.row))
        if(quality===2)words.add(word);
      // A badge like 40TFSI also owns its text span; TF is not a
      // separate vehicle when it appears inside this verified badge.
      for(const word of mentionedTrims)if(/^\d/.test(word)&&rows.some(model=>matchTrimVariant(model,word)))words.add(word);
      const spans=[];
      for(const word of words)for(let i=s.indexOf(word);i>=0;i=s.indexOf(word,i+word.length)){
        const span={i,end:i+word.length};
        if(!intersect(main,span) && !vehicleJoiner.test(gapBetween(main,span)))spans.push(span);
      }
      editionSpanCache.set(main,spans);
      return spans;
    }
    const unqualified=h=>!h.brandContext && !h.key.startsWith(compact(h.row.brandName)) && !h.variant;
    const shortUnqualifiedWord=h=>unqualified(h)&&/^[\u3400-\u9fff]{1,2}$/.test(h.key);
    const explicitlyBranded=h=>Boolean(h.brandSpan)||h.key.startsWith(compact(h.row.brandName));
    const explicitSeparation=(a,b)=>!intersect(a,b) &&
      (vehicleJoiner.test(gapBetween(a,b)) || (!sameMention(a,b)&&explicitlyBranded(a.i<b.i?b:a)));
    function differentVehicleMentions(a,b) {
      if(intersect(a,b))return false;
      if(explicitSeparation(a,b))return true;
      if(sameMention(a,b))return false;
      // A short unqualified word in the same description competes on
      // evidence. It is not on its own proof of a second car.
      return !shortUnqualifiedWord(a)&&!shortUnqualifiedWord(b);
    }
    const independentHits=initialHits.filter(h=>!unqualified(h)||!initialHits.some(main=>
      main!==h && !same(main,h) && !intersect(main,h) && !main.reverseTrim && !main.catalogFamily &&
      (main.key.length>=3 || main.brandSpan) && observedEditionSpans(main).some(span=>
        span.i<=h.i && span.end>=h.end && span.end-span.i>h.end-h.i)));
    // If two proposed anchors could each absorb the other, keep both and
    // let the existing ambiguity rules decide rather than erasing the input.
    const longestHits=independentHits.length?independentHits:initialHits;
    // Evaluate whole-series explanations, not a vote between individual hits.
    // “风尚” can be both a real series and a catalog trim of another car.
    function explains(main,h) {
      if(main.i<h.end && h.i<main.end) return false;
      if(!unqualified(h)) return false;
      const between=s.slice(Math.min(main.end,h.end),Math.max(main.i,h.i));
      if(vehicleJoiner.test(between))return false;
      // Only a complete, locally attested edition can claim an interior
      // substring. A brand-qualified name or an explicit second mention
      // remains independent.
      if(observedEditionSpans(main).some(span=>span.i<=h.i && span.end>=h.end))return true;
      const rows=rowsFor(main.row);
      return seriesTrimWords(rows,h.key,main.row).includes(h.key)
        || (isTrimWord.test(h.key) && rows.some(m=>compact(m.name).includes(h.key)));
    }
    const complete=longestHits.filter(main=>longestHits.every(h=>same(main,h)||explains(main,h)));
    const top=complete.length?complete:longestHits;
    const ambiguous = contenders => skip('AMBIGUOUS_SERIES','车系有歧义：'+distinct(contenders.map(h=>h.row.brandName+' '+h.row.name)).slice(0,6).join(' / '));
    const anchor=top[0];
    if(top.some(a=>top.some(b=>!same(a,b)&&explicitSeparation(a,b))))return {...ambiguous(top),separateVehicles:true};
    if(!secondPass && top.some(a=>top.some(b=>!same(a,b)&&differentVehicleMentions(a,b))))return ambiguous(top);
    if(top.some(a=>top.some(b=>same(a,b)&&!intersect(a,b))))return skip('MULTIPLE_CARS','评论里有多处车型，暂不合并');

    // Compare interpretations of the same written name. Never fall back from a
    // longer complete name to just one of its substrings (“帝豪GS” → “帝豪”).
    const candidateHits=[...top,...eligible.filter(h=>!same(anchor,h)&&!explains(anchor,h)&&
      (h.i===anchor.i&&h.end===anchor.end || h.reverseTrim&&sameMention(anchor,h)
      || !explicitSeparation(anchor,h) && longestHits.some(topHit=>same(h,topHit) || sameMention(h,topHit))))];
    const groups=new Map();
    for(const h of candidateHits){
      const key=h.row.brand+':'+h.row.id, group=groups.get(key)||[];
      if(!group.includes(h))group.push(h);
      groups.set(key,group);
    }
    let candidates=[...groups.values()];
    // Catalogs can list the same manufacturer and exact name under both
    // passenger and commercial divisions. An ordinary inquiry defaults to
    // passenger, while a real body type or trim code takes priority.
    const crossPeers=(a,b)=>sameCrossCatalogFamily(a[0].row,b[0].row)
      && a.some(x=>b.some(y=>intersect(x,y)));
    const twins=candidates.filter(g=>candidates.some(other=>crossPeers(g,other)));
    const crossVariants=[];
    if(twins.length){
      const codes=[...raw.matchAll(/(?<![a-z0-9.])([a-z]{1,6}\d{1,4})(?![a-z0-9.])/g)]
        .map(m=>({name:m[1],i:offsets.indexOf(m.index)}))
        .filter(m=>m.i>=0&&!twins.some(g=>g.some(h=>h.i<=m.i && h.end>=m.i+m.name.length)))
        .map(m=>'model-code:'+m.name);
      const uses=raw.match(/救险车|旅居车|房车|皮卡|货车|冷藏车|救护车|厢式运输车|工程车/g)||[];
      for(const word of distinct([...codes,...uses])){
        if(twins.some(g=>g.some(h=>rowsFor(h.row).some(m=>matchTrimVariant(m,word)))))crossVariants.push(word);
      }
      if(crossVariants.length){
        candidates=candidates.filter(g=>!twins.includes(g)||
          g.some(h=>rowsFor(h.row).some(m=>crossVariants.every(v=>matchTrimVariant(m,v)))));
      } else if(!/商用(?:车|版)/.test(raw)){
        candidates=candidates.filter(g=>g[0].row.category!=='commercial'||!twins.includes(g));
      } else if(twins.some(g=>g[0].row.category==='commercial')){
        candidates=candidates.filter(g=>!twins.includes(g)||g[0].row.category==='commercial');
      }
    }
    if(!candidates.length)return skip('NO_TRIM','找不到同时满足用途和型号的车型');
    // Brand defaults are for a bare, catalog-backed code shared by makes,
    // never for a fully named vehicle or an independent second mention.
    const sameCodeSpan=h=>h.i===anchor.i && h.end===anchor.end && h.key===anchor.key;
    const hasAudiCode=candidates.some(g=>g.some(h=>h.row.brandName===preferredBrandForBareCodes && sameCodeSpan(h)));
    const sharedCode=candidates.some(g=>g.some(h=>h.row.brandName!==preferredBrandForBareCodes && sameCodeSpan(h)));
    const defaultBrand=!namedBrand&&preferredBareCodes.has(anchor.key)&&hasAudiCode&&sharedCode?preferredBrandForBareCodes:'';
    if(defaultBrand)
      candidates=candidates.filter(g=>g[0].row.brandName===defaultBrand);
    const fullNameBeatsAbbreviation=(exact,abbrev)=>catalogMake(exact[0].row.brandName)===catalogMake(abbrev[0].row.brandName)
      && exact.some(a=>exactSeriesSpelling(a) && abbrev.some(b=>b.omittedSeriesSuffix && a.i===b.i && a.end===b.end));
    const isImport=h=>/\(进口\)/.test(normalize(h.row.name));
    const importVariant=defaultBrand==='奥迪'||namedBrand==='奥迪'
      ?raw.match(/(?<![a-z])(?:avant|allroad)(?![a-z])/)?.[0]:'';
    const mentionsImport=/(?<!非|不是|并非)进口/.test(raw)||Boolean(importVariant);
    const exclusiveImportTrim=(imported,domestic)=>{
      const importedRows=rowsFor(imported[0].row),domesticRows=rowsFor(domestic[0].row);
      const labels=seriesTrimWords(importedRows,raw,imported[0].row);
      const codes=[...raw.matchAll(/(?<![a-z])([a-z]{2,8})(?=\d|[^a-z]|$)/g)].map(m=>'model-code:'+m[1]);
      const clues=distinct([...labels,...codes]).filter(v=>!genericTrim.test(v));
      return clues.some(v=>importedRows.some(m=>matchTrimVariant(m,v)) && !domesticRows.some(m=>matchTrimVariant(m,v)));
    };
    const spokenYear=raw.match(/(?<![\d.])(\d{4}|\d{2})\s*(?:年|款)/)?.[1];
    const catalogYear=spokenYear?calendarYear(spokenYear):null;
    const hasCatalogYear=group=>catalogYear && group.some(h=>rowsFor(h.row).some(m=>+m.year===catalogYear));
    const rescueImportYear=(g,other)=>rescue &&
      catalogFamilyName(g[0].row)===catalogFamilyName(other[0].row) && hasCatalogYear(g) && !hasCatalogYear(other);
    if(mentionsImport && candidates.some(g=>isImport(g[0])))candidates=candidates.filter(g=>isImport(g[0]));
    else if(!mentionsImport)candidates=candidates.filter(g=>!isImport(g[0]) || !candidates.some(other=>
      !isImport(other[0]) && other[0].row.brand===g[0].row.brand && !fullNameBeatsAbbreviation(g,other)
        && !exclusiveImportTrim(g,other) && !rescueImportYear(g,other) && other.some(a=>g.some(b=>a.i===b.i&&a.end===b.end))));
    // Omitted suffix (e.g. XL): only extend a full family name within the
    // same make when a concrete year AND engine corroborate the extended row.
    // A naked letter/number or a lookalike from another make is not evidence.
    if(rescue && candidates.length===1){
      const g=candidates[0], base=g[0].row, key=catalogFamilyName(base);
      const power=raw.match(/(?<![\d.])(\d\.\d)\s*([tl])(?![a-z])/);
      if(power && catalogYear && key.length>=2 && raw.includes(key) && !mentionsImport){
        const target=catalogYear, engine=power[1]+power[2];
        const confirmed=row=>rowsFor(row).some(m=>+m.year===target && matchesEngine(m,row,engine));
        if(!confirmed(base))for(const row of seriesRows.values()){
          if(row.category!==base.category||row.brand!==base.brand||row.id===base.id)continue;
          const name=catalogFamilyName(row);
          if(name.startsWith(key) && /^[a-z]{1,5}$/.test(name.slice(key.length)) && confirmed(row))
            candidates.push(g.map(h=>({...h,row})));
        }
      }
    }
    if(titlePass && written?.known){
      const suffix=compact(written.name.slice(written.name.indexOf(written.known)+written.known.length));
      const energy=/(?:新能源|插电|插混|纯电|电动版|phev)/i.test(raw);
      const family=g=>catalogFamilyName(g[0].row);
      // Only break a base-name/新能源 tie for the same real catalog family.
      // Other vehicles sharing two Chinese characters remain independent.
      if(suffix && /^[\u3400-\u9fff]{2,}$/.test(suffix))candidates=candidates.filter(g=>!candidates.some(peer=>
        g!==peer && g[0].row.brand===peer[0].row.brand &&
        (energy ? family(g).endsWith(suffix) && family(peer)===family(g)+'新能源'
                : family(peer).endsWith(suffix) && family(g)===family(peer)+'新能源')));
    }
    if(candidates.length>1){
      // An inserted trim can split the spelling of one family (e.g. 锐…放).
      // Prefer its full catalog name over a proper substring at the same
      // location. A generic grade alone is not a second vehicle identifier.
      const spelled=g=>g.filter(h=>exactSeriesSpelling(h)||compact(h.key)===catalogFamilyName(h.row));
      const stronger=(a,b)=>spelled(a).some(x=>(spelled(b).length?spelled(b):b).every(y=>{
        if(explicitSeparation(x,y))return false;
        const named=compact(x.key),other=compact(y.key);
        if(genericTrim.test(other)&&!y.brandSpan&&!genericTrim.test(named))return true;
        if(!intersect(x,y))return false;
        return named.length>other.length && named.includes(other) ||
          /[a-z]+\d/i.test(named)&&!/[a-z]+\d/i.test(other)&&catalogMake(x.row.brandName)===catalogMake(y.row.brandName);
      })&&!genericTrim.test(compact(x.key)));
      const specific=candidates.filter(g=>!candidates.some(other=>other!==g&&stronger(other,g)));
      if(specific.length)candidates=specific;
    }
    // Some catalogs store electrified siblings as separate series IDs (occasionally
    // in both passenger and energy). Expand an identified family, not a brand-wide search.
    if(!titlePass && hybridSpans.length && candidates.length===1){
      const group=candidates[0], base=group[0].row, family=catalogFamilyName(base);
      const exact=eligible.filter(h=>same(h,group[0]) && (exactSeriesSpelling(h)||h.approvedAlias) &&
        group.some(g=>intersect(g,h)));
      if(exact.length && !electricFamilySuffix.test(family)){
        const siblings=new Map();
        for(const row of seriesRows.values()){
          if(row.brand!==base.brand || row.category==='commercial' ||
            (!electricFamilySuffix.test(catalogFamilyName(row)) || catalogFamilyName(row).replace(electricFamilySuffix,'')!==family) || isImport({row})!==isImport(group[0]))continue;
          if(!rowsFor(row).some(m=>matchTrimVariant(m,'powertrain:hybrid')) && !/(?:phev|插混|插电混动)$/.test(catalogFamilyName(row)))continue;
          if(!siblings.has(row.id)||row.category===base.category)siblings.set(row.id,row);
        }
        for(const row of siblings.values())candidates.push(exact.map(h=>({...h,row,linkedHybrid:true})));
      }
    }
    const evaluated=candidates.map(group=>({group,result:evaluate(group,anchor)}));
    // A valid complete spelling trumps an omitted-L alias. A real trim
    // can still disambiguate an unavailable spelling (e.g. A6 旗舰动感).
    const outcomes=evaluated.filter(other=>!evaluated.some(exact=>exact!==other &&
      fullNameBeatsAbbreviation(exact.group,other.group) &&
      (!other.result.ok || (exact.result.ok ? exact.result.evidence.characters>=other.result.evidence.characters
        : exact.result.code==='NO_YEAR_MATCH' && !mentionedTrims.length && !defaultBrand))));
    // Same spoken form, same model evidence: G50 needs one omitted letter,
    // EG50 needs two. Two equally short reconstructions remain ambiguous.
    const comparable=outcomes.filter(o=>o.result.ok);
    const stemCosts=new Map();
    if(anchor.nearMatch?.omittedStem && comparable.length>1)for(const o of comparable){
      const hs=o.group.filter(h=>h.i===anchor.i && h.end===anchor.end && h.key===anchor.key);
      const costs=hs.map(h=>h.nearMatch?.omittedStem??(exactSeriesSpelling(h)?0:Infinity));
      const cost=Math.min(...costs);
      if(Number.isFinite(cost))stemCosts.set(o,cost);
    }
    const sameProvenBadge=comparable.length>1 && comparable[0].group.some(h=>h.divisionBadge &&
      comparable.every(o=>o.group.some(other=>other.divisionBadge===h.divisionBadge && other.row.brand===h.row.brand)));
    const rank=(a,b)=>b.result.evidence.characters-a.result.evidence.characters || (titlePass?b.result.titleMatch.count-a.result.titleMatch.count:0) ||
      b.result.evidence.score-a.result.evidence.score || b.result.coverage-a.result.coverage ||
      (stemCosts.size===comparable.length?stemCosts.get(a)-stemCosts.get(b):0) ||
      Number(b.group.some(h=>h.nearMatch?.homophone))-Number(a.group.some(h=>h.nearMatch?.homophone)) ||
      (a.group.some(h=>h.linkedHybrid) || b.group.some(h=>h.linkedHybrid)
        ? a.result.yearGap-b.result.yearGap || Number(a.group.some(h=>h.linkedHybrid))-Number(b.group.some(h=>h.linkedHybrid)):0) ||
      (defaultBrand||sameProvenBadge?(a.result.yearGap??0)-(b.result.yearGap??0) || b.result.modelYear-a.result.modelYear:0);
    const valid=outcomes.filter(o=>o.result.ok).sort(rank);
    if(valid.length>1 && !rank(valid[0],valid[1])){
      const tied=valid.filter(o=>!rank(valid[0],o));
      // Only the same written edition under the same explicit make gets a
      // catalog-order tie break; unrelated vehicles and bare badges stay ambiguous.
      if(!rescue || !namedBrand || !tied.every(o=>o.group.some(h=>h.partialEdition &&
          h.key===valid[0].group[0].key && compact(h.row.brandName)===namedBrand)))
        return ambiguous(tied.map(o=>o.group[0]));
      tied.sort((a,b)=>a.result.yearGap-b.result.yearGap || a.result.order-b.result.order);
      const at=valid.indexOf(tied[0]);
      [valid[0],valid[at]]=[valid[at],valid[0]];
      valid[0].result.job.reason+='；同品牌多个车系命中同一配置片段，按年款和目录顺序近似选取';
    }
    if(valid.length){
      if(secondPass){
        const best=valid[0];
        // A short/partial alias needs an explanation from the winning
        // model, or substantially stronger text. Do not ignore a second
        // full, independently written series simply because it scored less.
        const competing=outcomes.some(other=>other!==best && other.group.some(h=>
          best.group.every(g=>!same(g,h)&&!intersect(g,h)&&!explains(g,h))
          && ![...coveredPositions([h])].every(p=>best.result.evidence.relevant.has(p))
          && !h.nearMatch && !h.reverseTrim && !h.shortSeries
          && (h.key.length>=3 || explicitlyBranded(h))));
        if(competing)return ambiguous(candidates.map(g=>g[0]));
      }
      // With indistinguishable names/configurations, an age mismatch alone is
      // not evidence that the viewer meant the remaining brand.
      const explicitModelYear=/(?<![\d.])(?:(?:19|20)\d{2}|\d{1,2})\s*(?:年款|款)/.test(raw);
      if(!defaultBrand && !explicitModelYear && !valid[0].group.some(h=>h.reverseTrim||h.catalogFamily||h.divisionBadge) && valid.length===1 && outcomes.some(o=>o!==valid[0] && o.result.code==='NO_YEAR_MATCH'
          && !(rescue && catalogMake(o.group[0].row.brandName)===catalogMake(valid[0].group[0].row.brandName)
            && catalogFamilyName(o.group[0].row)===catalogFamilyName(valid[0].group[0].row))
          && !o.group.some(h=>h.linkedHybrid) && !valid[0].group.some(h=>h.linkedHybrid)
          && !(crossVariants.length && crossPeers(o.group,valid[0].group))
          && rowsFor(o.group[0].row).some(m=>+m.year>=1900 && +m.year<=today().getFullYear())
          && o.group[0].coverage>=valid[0].result.coverage))return ambiguous(candidates.map(g=>g[0]));
      const {coverage,yearGap,modelYear,evidence,order,...result}=valid[0].result;
      result.exactFamily=valid[0].group.some(exactSeriesSpelling);
      const relevant=new Set(valid.flatMap(o=>[...o.result.evidence.relevant]));
      for(const h of candidateHits)for(const i of coveredPositions([h,...(h.extraSpans||[])]))relevant.add(i);
      result.matchEvidence={brand:evidence.brand,series:evidence.series,model:titlePass?result.titleMatch.count:evidence.model,relevantChars:relevant.size};
      return result;
    }
    if(outcomes.length===1)return outcomes[0].result;
    if(outcomes.length && outcomes.every(o=>o.result.constraint==='engine'))return outcomes[0].result;
    return ambiguous(candidates.map(g=>g[0]));

    function evaluate(group, primary) {
      const found=group[0], series=found.row;
      const alternatives=usable.filter(h=>!same(found,h)&&intersect(found,h)&&h.coverage<found.coverage);
      const evidenceTotal=alternatives.length
        ? new Set([...found.covered,...alternatives.flatMap(h=>[...h.covered])]).size : 0;
      let rest=raw;
      for(const span of [found,...(found.brandContext?[found.brandContext]:[]),...(found.extraSpans||[])].sort((a,b)=>b.i-a.i)){
        const start=offsets[span.i],end=offsets[span.end-1]+1;
        rest=rest.slice(0,start)+' '.repeat(end-start)+rest.slice(end);
      }
      const geoSpans=items=>items.flatMap(place=>{
        if(!place.name)return [];
        const spans=[];
        for(let i=rest.indexOf(place.name);i>=0;i=rest.indexOf(place.name,i+place.name.length))
          spans.push({place,i,end:i+place.name.length});
        return spans;
      });
      const provinceSpans=geoSpans(provinces), provMatches=distinct(provinceSpans.map(p=>p.place));
      const citySpans=geoSpans(cities).filter(c=>!provinceSpans.some(p=>
        intersect(c,p) && (p.i!==c.i||p.end!==c.end)));
      // “青海西宁” contains the accidental crossing substring “海西”.
      // Keep real independent city mentions, but drop overlapping fragments.
      const cityMatches=distinct(citySpans.filter(c=>!citySpans.some(other=>intersect(c,other)
        && other.end-other.i>c.end-c.i)).map(c=>c.place));
      const compatible=cityMatches.filter(c=>!provMatches.length||provMatches.some(p=>p.id===c.provinceId));
      const defaultCity=compatible.length!==1 || provMatches.length>1 ||
        cityMatches.some(c=>c.name!==compatible[0]?.name);
      const city=defaultCity
        ?cities.find(c=>c.name==='广州'&&provinces.some(p=>p.name==='广东'&&p.id===c.provinceId))
        :compatible[0];
      if(!city)return skip('LOCATION','本地地区目录缺少广东广州');
      const province=provinces.find(p=>p.id===city.provinceId)?.name || '';
      for(const p of [...provMatches,...cityMatches])rest=rest.split(p.name).join(' ');
      const conversationalYear=rest.match(/(?<![a-z0-9.])((?:19|20)\d{2}|\d{2})\s*的\s*[,，]?\s*(?=[\d零一二两三四五六七八九十百]+(?:\.\d+)?\s*(?:(?:万|w)\s*(?:公里|千米|km)?|公里|千米|km))/)?.[1];
      // A charging/range qualifier belongs to the edition, not the odometer.
      const rangeHints=[];
      rest=rest.replace(/(?:续航|cltc|wltp)\s*[:：]?\s*(\d{2,4})(?:\s*(?:公里|km))?|(\d{2,4})(?:\s*(?:公里|km))?\s*(?=(?:慢充|快充))/g,
        (_,before,after)=>{rangeHints.push('range:'+(before||after));return ' ';});
      const mileage=extractMileage(rest,{fallbackOnInvalid:true});
      rest=registrationDateText(mileage.rest);
      if(/(?:车龄|开了|用了|开满)\s*\d+年/.test(rest)) return skip('DATE','车龄不是上牌年份');
      const dates=[...rest.matchAll(/(?<![\d.])((?:19|20)\d{2}|\d{1,2})\s*(年款|款|年|上牌|落户)/g)];
      const registrations=distinct(dates.filter(d=>/^(年|上牌|落户)$/.test(d[2])).map(m=>m[1]));
      const trims=distinct(dates.filter(d=>/款$/.test(d[2])).map(m=>m[1]));
      // “25年的…26年1月份上牌” has an explicit registration date and
      // an earlier description year. Two actual registration dates still conflict.
      if(dates.length===2 && registrations.length===2 && !trims.length){
        const tagged=dates.filter(d=>/^(?:上牌|落户)$/.test(d[2]) ||
          /^\s*(?:\d{1,2}\s*月份?\s*)?(?:上牌|落户)/.test(rest.slice(d.index+d[0].length)));
        const other=dates.find(d=>!tagged.includes(d));
        if(tagged.length===1 && other && /^\s*的/.test(rest.slice(other.index+other[0].length)) &&
          calendarYear(other[1])<=calendarYear(tagged[0][1])){
          registrations.splice(0,2,tagged[0][1]);trims.push(other[1]);
        }
      }
      const exactRecalledEditions=group.filter(h=>h.reverseTrim && h.quality===2);
      // A four-digit year next to an exact edition (“2024甄享”) is a
      // model-year preference, not a stated registration date.
      for(const h of exactRecalledEditions){
        const bareEditionYear=raw.slice(0,offsets[h.i]).match(/(?:^|[\s，,。:：])((?:19|20)\d{2})\s*$/)?.[1];
        if(bareEditionYear && !trims.includes(bareEditionYear))trims.push(bareEditionYear);
      }
      const dateTouchingTrim=/(?<![\da-z.])((?:19|20)\d{2}|\d{2})\s*(?=(?:ultra|max|pro|air|plus|livis)(?![a-z]))/g;
      for(const m of rest.matchAll(dateTouchingTrim))if(!trims.includes(m[1]))trims.push(m[1]);
      rest=rest.replace(dateTouchingTrim,' ');
      if(!registrations.length&&!trims.length){
        const bare=rest.match(/^\s*(?:(?:请问|主播|老板|师傅|你好|您好|麻烦)\s*[,，:：]?\s*)*((?:19|20)\d{2}|\d{2})(?!\s*(?:上下|左右|万|w|元|块|公里|千米|km))(?=\s|[，,。\u3400-\u9fff]|$)/)
          || rest.match(new RegExp('(?:^|[\\s,，。])((?:19|20)\\d{2})(?=\\s*(?:'+trimGradeWords+'|手动|自动))'));
        if(bare&&!/^\s*\d{2}月/.test(rest)) registrations.push(bare[1]);
        else if(conversationalYear)registrations.push(conversationalYear);
      }
      // Preserve numeric month shorthand. Chinese months need a date/registration
      // anchor: “21年上牌，四月脱保” does not make April its registration month.
      const monthPattern=/(?<!\d)\d{1,2}\s*月|(?<=\d\s*年\s*|上牌\s*[:：]?\s*)[零〇一二两三四五六七八九十]{1,3}\s*月|(?<![零〇一二两三四五六七八九十])[零〇一二两三四五六七八九十]{1,3}\s*月(?=份?\s*(?:上牌|落户))/g;
      const months=distinct([...rest.matchAll(monthPattern)].map(m=>chineseNumber(m[0].replace(/\s*月$/,''))));
      if(registrations.length>1||trims.length>1||months.length>1||months.some(m=>m<1||m>12))return skip('DATE','上牌年月或年款冲突');
      // Consume dates before reading engine/trim tokens, especially “1.4T2019款”.
      rest=rest.replace(/(?<![\d.])((?:19|20)\d{2}|\d{1,2})\s*(?:年款|款|年|上牌|落户)/g,' ');
      rest=rest.replace(monthPattern,' ');
      const grade=readTrimGrade(rest);
      rest=rest.replace(ordinalTrimTokens(),' ');
      const generation=generationBoundaries.find(g=>g.brand===series.brandName&&g.series===series.name);
      const oldGeneration=generation&&/(?<!不是|非|不要)(?:老款|旧款|改款前)/.test(rest);
      const newGeneration=generation&&/(?<!不是|非|不要)(?:焕新(?:版)?|改款后)/.test(rest);
      if(oldGeneration&&newGeneration)return skip('NO_TRIM','新旧款线索冲突');
      if(generation)rest=rest.replace(/老款|旧款|改款前|焕新(?:版)?|改款后/g,' ');
      // Ignore prose and counts; normalize short drive terms only in configuration position.
      rest=rest.replace(/(^|[\s,，、;；]|(?:挡|档))((?:两|二|四|前|后)[驱区曲渠])(?=\d|[\s,，、;；。！？]|$)/g,
        (_,lead,word)=>lead+(word[0]==='二'?'两':word[0])+'驱');
      const competingTrimWords=usable.filter(h=>!same(found,h)&&intersect(found,h)&&h.brandConflict)
        .flatMap(h=>h.coverageWords||[]).filter(w=>normalize(rest).includes(w));
      const detachedBadges=numberBadgeHints.filter(h=>group.some(g=>h.parents.has(seriesKey(g.row))));
      let variants=distinct([...group.map(h=>h.variant),...detachedBadges.map(h=>h.variant),
        ...(secondPass?[]:longestHits.filter(h=>!same(found,h)&&differentVehicleMentions(primary,h)&&!explains(found,h)).map(h=>h.key)),
        ...competingTrimWords,...(twins.includes(group)?crossVariants:[]),...(normalize(rest).match(trimMentions())||[])].filter(Boolean));
      if(importVariant && isImport(found))variants.push(importVariant);
      const power=rest.match(/(?<![\d.])(\d\.\d)\s*(t|l|自吸)(?![a-z])/)
        || rest.match(/(?<![\d.])(\d\.\d)(?![\d.])/);
      const engine=power && power[1]+(power[2]==='自吸'?'l':power[2]||'');
      if(/真省油|真好看|好帅|我喜欢|路过|点赞|怎么保养|怎么维修/.test(rest) && !(/多少|估价|报价/.test(rest)||registrations.length||trims.length||!mileage.defaulted))return ignore('只是在聊车，没有提供报价信息');
      let rows=[...new Map(group.flatMap(h=>rowsFor(h.row)).map(r=>[r.id,r])).values()];
      if(titlePass)rows=rows.filter(m=>group.some(h=>h.titleHit?.has(titleBody(m.name))));
      variants.push(...distinct(rangeHints).filter(v=>rows.some(m=>matchTrimVariant(m,v))));
      const catalogTrims=seriesTrimWords(rows,rest,series);
      const shorthandGrades=adjacentPowerGrades(rows,catalogTrims,rest);
      variants.push(...catalogTrims.filter(w=>!isEquipment(w)),...shorthandGrades);
      if(rescue&&candidates.length===1)variants=variants.filter(v=>!(/^(?:plus|pro|max|ultra|air)$/.test(v)&&group.some(h=>exactSeriesSpelling(h)&&new RegExp('^\\s*'+v+'(?![a-z])').test(s.slice(h.end)))&&!rows.some(m=>matchTrimVariant(m,v))));
      const bodies=bodyBadges.find(rule=>rule.brand===series.brandName&&rule.series===series.name)?.badges;
      for(const [badge,label] of Object.entries(bodies||{})){
        if(new RegExp('(?<![a-z0-9])'+badge+'(?![a-z])').test(rest))variants.push('model-code:'+badge);
        variants=variants.map(v=>v===label?'body-badge:'+label+':'+badge:v);
      }
      if(hybridSpans.some(span=>group.some(h=>!vehicleJoiner.test(gapBetween(h,span)))))variants.push('powertrain:hybrid');
      const corrected=[];
      if(!catalogTrims.length){
        const identities=variants.filter(v=>/^(?:badge|model-code|model-root|number-badge|power-grade):/.test(v));
        const identified=rows.filter(m=>identities.every(v=>matchTrimVariant(m,v,true)));
        const spellingRows=identified.length?identified:rows;
        const corrections=inferTrimWords(spellingRows,rest,series);
        // An absent adjective corrected against this family's own lexicon
        // must not survive as an additional, contradictory hard constraint.
        variants=variants.filter(v=>!corrections.some(c=>c.from.endsWith(v)&&!spellingRows.some(m=>matchTrimVariant(m,v))));
        corrected.push(...corrections);
        variants.push(...corrections.map(c=>c.to));
      }
      for(const {0:word} of rest.matchAll(/(?<![a-z0-9])[a-z]{4,8}(?![a-z0-9])/g)){
        const codes=['plus','ultra','livis'].filter(code=>nearTrimCode(word,code)&&rows.some(m=>matchTrimVariant(m,code)));
        if(catalogTrims.length && codes.length===1){variants.push(codes[0]);corrected.push({from:word,to:codes[0]});}
      }
      const seats=seatCount(rest);
      // Missing catalog seat metadata is unknown, not a contradiction. If
      // some compatible rows do name their seats, prefer the known match.
      if(seats && rows.some(m=>seatCount(m.name)!=null))variants.push(seats+'座');
      const naturalGas=/\bcng\b|天然气|油气两用/;
      const wantsNaturalGas=naturalGas.test(rest);

      const directory=rows;
      const fuelOK=m=>!wantsNaturalGas||naturalGas.test(normalize(m.name));
      // Some verified catalog aliases name the propulsion explicitly while
      // the model title only says 新能源. Trust that alias for its own trim,
      // not for every 新能源 vehicle (which may also be battery-electric).
      const namedHybrid=group.filter(h=>h.catalogFamily && h.variant && [...h.key.matchAll(hybridCue)].length);
      const compatibleVariant=(m,v)=>fitsVariant(m,v) || v==='powertrain:hybrid' &&
        (/(?:phev|插混|插电混动)$/.test(catalogFamilyName(series)) || namedHybrid.some(h=>fitsVariant(m,h.variant)));
      // Vehicle identifiers bind the model being priced. Descriptive words
      // (edition names, seats, drive) compete on the same score, never AND.
      const identity=variants.filter(v=>/^(?:badge:|model-code:|model-root:|number-badge:|power-grade:|body-badge:|powertrain:|range:|(?:amt|cvt|dct|dsg|ecvt)$|\d+(?:t|tsi|tfsi|thp)$)/.test(v));
      const familyAnchors=group.filter(h=>h.catalogFamily||h.reverseTrim);
      const namedByEdition=familyAnchors.length===group.length;
      rows=directory.filter(m=>fuelOK(m)&&identity.every(v=>compatibleVariant(m,v)) &&
        (!namedByEdition||familyAnchors.some(h=>compatibleVariant(m,h.variant))));
      if(!rows.length)return {...skip('NO_TRIM','车系目录中没有对应的型号或动力标识'),constraint:'identity'};
      const knownYears=rows.map(m=>+m.year).filter(Number.isFinite);
      const now=today(), maxYear=now.getFullYear();
      const yearFor=(token,pool)=>{
        if(!token)return null;
        if(token.length===1){const values=distinct(pool.filter(y=>y>=1900&&y<=maxYear&&y%10===+token));return values.length===1?values[0]:NaN;}
        return calendarYear(token);
      };
      const explicit=yearFor(trims[0],knownYears);
      if(Number.isNaN(explicit))return skip('DATE','单数字年款有歧义');
      const regPool=new Set();
      if(registrations[0]?.length===1)for(const m of rows)for(let y=Math.max(+m.lo,1900);y<=Math.min(+m.hi,maxYear);y++)regPool.add(y);
      let registration=yearFor(registrations[0],[...regPool]);
      if(Number.isNaN(registration))return skip('DATE','单数字上牌年份有歧义');
      const month=months[0]||1;
      const quoteYear=m=>registration||+m.year;
      const fitsRegistration=(m,allowStaleUpper=false)=>{
        const y=quoteYear(m);
        if(+m.year<1900||(+m.year>maxYear&&+m.year!==99999)||y<1900||y<+m.lo||(!allowStaleUpper&&y>+m.hi)||y*12+month>maxYear*12+now.getMonth()+1)return false;
        if(!generation)return true;
        const refreshed=+m.year>=generation.firstNewYear;
        if(oldGeneration&&refreshed||newGeneration&&!refreshed)return false;
        const ym=y+'-'+String(month).padStart(2,'0');
        return !refreshed||!registration||!months.length||ym>=generation.firstNewRegistration;
      };
      const requested=explicit||registration;
      let discardedYear=null;
      if(requested && (Boolean(explicit)!==Boolean(registration))
          && candidates.length===1 && !variants.length && !engine && !grade){
        // A year predating the entire family (including imported siblings)
        // is treated as missing only when the description has no other grade.
        const yearField=explicit?'year':'lo';
        const family=[...new Map(candidateHits.filter(h=>h.row.brand===series.brand)
          .map(h=>[seriesKey(h.row),h.row])).values()];
        const earliest=Math.min(...family.flatMap(r=>rowsFor(r).map(m=>+m[yearField]))
          .filter(y=>Number.isFinite(y)&&y>=1900));
        if(Number.isFinite(earliest) && requested<earliest){
          discardedYear=requested;registration=null;
        }
      }
      const targetYear=discardedYear?null:requested;
      const noYear=()=>skip('NO_YEAR_MATCH',targetYear&&knownYears.length
          ? series.name+' 本地库没有符合 '+targetYear+' 年'+(explicit?'款':'上牌')+'的车型'
          : '没有符合年款和上牌年月的配置');
      // For a uniquely identified catalog edition, a model-year hint
      // ranks matching rows rather than excluding the whole edition.
      // Keep explicit registration dates and engine constraints intact.
      const hasExactEdition=exactRecalledEditions.length>0 || catalogTrims.some(word=>!genericTrim.test(word));
      const allowEditionYearFallback=candidates.length===1 && hasExactEdition;
      if(targetYear && (targetYear>maxYear
        || (explicit && !allowEditionYearFallback && (targetYear<Math.min(...rows.map(m=>Math.min(+m.year,+m.lo)))
          || targetYear>Math.max(...rows.map(m=>Math.max(+m.year,+m.hi)))))))return noYear();
      // A catalog's max registration year can lag behind reality. A car can
      // register after its model year, but never before the model existed.
      const listed=rows.filter(m=>fitsRegistration(m));
      const describedEdition=catalogTrims.some(w=>!isEquipment(w)) ||
        variants.some(v=>mentionedTrims.includes(v) && v!=='自动');
      const registeredRows=candidates.length===1 && (!listed.length||describedEdition)
        ?rows.filter(m=>fitsRegistration(m,true)):listed;
      let looseEngine=false;
      const noEngine=()=>({...skip('NO_TRIM','找不到满足明确动力的车型'),constraint:'engine'});
      if(engine){
        const matches=rows.filter(m=>matchesEngine(m,series,engine));
        const confirmed=matches.filter(m=>registeredRows.includes(m));
        // Retry only within a well-identified family, and only for
        // catalog badges whose engine is actually unknown. Never swap a
        // known different engine or erase a stated trim/model code.
        const fallbackYear=registeredRows.slice().sort((a,b)=>targetYear
          ?Math.abs(+a.year-targetYear)-Math.abs(+b.year-targetYear)||+a.year-+b.year:+b.year-+a.year)[0]?.year;
        const opaque=secondPass&&(candidates.length===1 || rescue && group.some(h=>exactSeriesSpelling(h)))&&group.some(h=>!h.nearMatch&&!h.reverseTrim&&!h.shortSeries)
          ?registeredRows.filter(m=>+m.year===+fallbackYear&&hasOpaqueEngineBadge(m,series)):[];
        if(confirmed.length)rows=confirmed;
        else if(opaque.length){rows=opaque;looseEngine=true;}
        else if(matches.length)return noYear();
        else if(explicit && candidates.length===1 && (!registration || registration>=explicit)){
          // Preserve the narrow opaque-badge rule for an exact year only.
          // A verified drivetrain mismatch never drops to another engine.
          const sameYear=registeredRows.filter(m=>+m.year===explicit);
          if(sameYear.length && !engineCatalog.some(rule=>rule.brand===series.brandName && rule.series===series.name && (!rule.years || rule.years.includes(explicit))) &&
            sameYear.every(m=>!/(?<![\d.])\d\.\d\s*(?:[tl]|升)/.test(normalize(m.name)))){
            rows=sameYear;looseEngine=true;
          } else return noEngine();
        } else return noEngine();
      } else rows=registeredRows;
      if(!rows.length)return noYear();
      // Don't substitute a niche alternate-fuel vehicle solely for a closer
      // year when the viewer didn't say natural gas and standard cars fit.
      if(!wantsNaturalGas && rows.some(m=>!naturalGas.test(normalize(m.name))))
        rows=rows.filter(m=>!naturalGas.test(normalize(m.name)));
      const powerHints=shorthandGrades.length?observedPowerGrades(catalogTrims,raw)
        .filter(hint=>shorthandGrades.includes(hint.variant)):[];
      const engineHints=power?.[2]?[...raw.matchAll(/(?<![\d.])(\d\.\d)\s*(t|l|自吸)(?![a-z])/g)]
        .filter(m=>m[1]+(m[2]==='自吸'?'l':m[2])===engine)
        .map(m=>({engine,i:m.index,end:m.index+m[0].length})):[];
      // Evidence is computed for EVERY quotable row, before narrowing by model
      // year. Partial written edition names may outweigh one exact generic word.
      const clues=new Map();
      const addClue=(word,variant=word,observed=false)=>{
        if(!word||word.includes(':')||isEquipment(word)||!observed&&!rest.includes(word))return;
        const k=word+'|'+variant;if(clues.has(k))return;
        const spans=[];
        for(let at=s.indexOf(word);at>=0;at=s.indexOf(word,at+word.length))
          if(group.some(h=>!vehicleJoiner.test(gapBetween(h,{i:at,end:at+word.length}))))
            spans.push({i:at,end:at+word.length,variant});
        clues.set(k,spans);
      };
      for(const v of variants)addClue(v);
      for(const c of corrected){
        const stem=c.to.replace(/^near-trim:/,'').split('|')[0];
        addClue(c.from.slice(-stem.length),c.to,true);
      }
      for(const m of s.matchAll(/(?:两|二|四|前|后)[区曲渠]|[2-9二两三四五六七八九]\s*[座坐]/g)){
        const normalized=seatCount(m[0])?seatCount(m[0])+'座':m[0].replace('二','两').slice(0,1)+'驱';
        if(variants.includes(normalized))addClue(m[0],normalized,true);
      }
      for(const m of rows)for(const term of catalogTrimEvidence(m,series).keys()){
        const stem=term.replace(/(?:版|型)$/,'');
        if(isEquipment(stem)||!/^\p{Script=Han}{3,}$/u.test(stem))continue;
        for(let i=0;i<stem.length-1;i++)addClue(stem.slice(i,i+2));
      }
      for(const m of s.matchAll(/(?<![\d.])\d+\s*周年/g))
        if(rows.some(r=>normalize(r.name).includes(m[0])))addClue(m[0]);
      const editionSpans=[...clues.values()].flat();
      const fits=new Map(rows.map(m=>[m.id,modelEvidence(m,group,powerHints,engineHints,editionSpans)]));
      const literal=new Map();
      if(written)for(const m of rows)literal.set(m.id,literalScore(written.all,m.name));
      // If the comment only names one vehicle, every row has the same
      // parent. A make repeated in a subset of titles is not a trim clue.
      const hasDetails=editionSpans.length || variants.length || engine || titlePass ||
        rows.some(m=>[...catalogTrimEvidence(m,series).keys()].some(w=>!isEquipment(w)&&s.includes(w)));
      const count=m=>hasDetails?fits.get(m.id).characters:0;
      const best=Math.max(...rows.map(count));
      rows=rows.filter(m=>count(m)===best);
      if(titlePass && rows.length>1){
        const top=Math.max(...rows.map(m=>literal.get(m.id).count));
        rows=rows.filter(m=>literal.get(m.id).count===top);
      }
      if(rows.some(m=>fitsRegistration(m)))rows=rows.filter(m=>fitsRegistration(m));
      const yearRank=m=>targetYear?Math.abs(+m.year-targetYear):0;
      // Date proximity only ranks configurations that match the description.
      // On equal gaps: earlier first (Y-1, Y+1, Y-2, Y+2, …).
      const selectedYear=[...rows].sort((a,b)=>yearRank(a)-yearRank(b)
        || (targetYear?+a.year-+b.year:+b.year-+a.year))[0].year;
      rows=rows.filter(m=>m.year===selectedYear);
      const badgeVariants=variants.filter(v=>v.startsWith('badge:'));
      if(badgeVariants.length && rows.some(m=>badgeVariants.every(v=>matchTrimVariant(m,v))))
        rows=rows.filter(m=>badgeVariants.every(v=>matchTrimVariant(m,v)));
      const defaultTrim=defaultTrimBySeries[series.id];
      const gradeRank=gradePreference(rows,grade);
      const preferred = m => defaultTrim && compact(m.name).includes(defaultTrim) ? 1 : 0;
      const plainEditionRank=m=>variants.includes('powertrain:hybrid')
        ?catalogTrims.filter(word=>new RegExp('(?:^|\\s)'+word+'(?:版|型)?(?=[\\s(（]|$)')
          .test(normalize(m.name))).length:0;
      const useCatalogOrder=looseEngine || (!engine&&!gradeRank && variants.every(v=>group.some(h=>h.reverseTrim && h.variant===v)));

      rows.sort((a,b)=>+b.year-+a.year
        || (titlePass ? literal.get(b.id).count-literal.get(a.id).count : 0)
        || fits.get(b.id).score-fits.get(a.id).score
        || plainEditionRank(b)-plainEditionRank(a)
        || (gradeRank?gradeRank(b)-gradeRank(a):0)
        || preferred(b)-preferred(a)
        || (useCatalogOrder?a.catalog_order-b.catalog_order:0)
        || Number(/纪念|限量|特别/.test(a.name))-Number(/纪念|限量|特别/.test(b.name))
        || Number(/改款/.test(a.name))-Number(/改款/.test(b.name))
        || Number(a.id)-Number(b.id));
      const m=rows[0], matchedYear=+m.year;
      registration = quoteYear(m);
      const input={modelId:m.id,registration:registration+'-'+String(month).padStart(2,'0'),mileage:mileage.value,provinceId:city.provinceId,cityId:city.cityId};
      const reason=[
        '按品牌、车系、款式字符匹配选取',
        found.nearMatch?'型号近似匹配 '+found.key+' → '+found.nearMatch.alias+'（'+found.nearMatch.matched+'/'+found.nearMatch.length+' 字符）':'',
        evidenceTotal?'车型字符覆盖 '+found.coverage+'/'+evidenceTotal:'',
        found.catalogFamily||found.reverseTrim?'由配置名反查车系：'+series.name:'',
        discardedYear?discardedYear+' 年早于该车系目录范围，按无年份取最新可报价年款'
          :targetYear&&matchedYear!==targetYear?`${targetYear} 年没有满足条件的款式，按同车系配置取 ${matchedYear} 年款`
          :explicit?'指定年款':registrations.length?'同年款优先':'最新匹配年款',
        gradeRank && gradeRank(m)===0?'按目录指导价选'+grade:
          rows.length>1?'同年多配置，按固定顺序选取':'',
        looseEngine?'该年款目录未标明排量，按已确认的车系和年款选取':'',
        mileage.unresolved?'里程不明确，使用 10 万公里':mileage.defaulted?'未写里程，使用 10 万公里':'',
        defaultCity?(provMatches.length||cityMatches.length?'地区信息不明确，使用广东广州':'未写城市，使用广东广州'):''
      ].filter(Boolean).join('；');
      return {ok:true,...(written?{titleMatch:literal.get(m.id)}:{}),order:m.catalog_order,coverage:found.coverage,evidence:fits.get(m.id),yearGap:yearRank(m),modelYear:matchedYear,job:{id:comment.id,eventId:comment.eventId||'',name:comment.name||'直播观众',userId:comment.userId||'',room:comment.room||'',avatar:comment.avatarUrl||'',car:m.name,seriesName:series.name,city:city.name,province,input,reason}};
    }
  }
  return function parse(comment) {
    function confirmed(result){
      const join=/以及|还是|或者|对比|比较|和|与|跟|或|比(?!亚迪)/;
      if(!result.ok || !join.test(comment.text))return result;
      const makes=new Set();
      for(const part of maskPaint(normalize(comment.text)).split(join)){
        const clue=describeTitle(part,brands);
        // Leading make owns its series; “mini” inside “吉利熊猫mini” is
        // part of that title, not a second manufacturer.
        const leading=part.trimStart().replace(/^(?:\d{2}|\d{4})\s*(?:年款|款|年)\s*/,'');
        const maker=brands.find(b=>leading.startsWith(b))||clue?.known;
        if(maker)makes.add(maker);
        else if(clue && /^[a-z]{1,4}\d{2,3}$/.test(clue.name)){
          const owners=distinct(lookupModelCode(clue.name).map(row=>compact(row.brandName)));
          if(owners.length===1)makes.add(owners[0]);
        }
      }
      if(makes.size>1)return skip('AMBIGUOUS_SERIES','评论中分别提到了不同品牌的车');
      return result;
    }
    function chooseRanked(result,path){
      // Every recall path uses the same trim scorer. A complete written
      // family has already compared its eligible trims and competing families.
      // For a shorthand, consider expanded candidates even on a successful hit.
      if(!result.exactFamily){
        const expanded=explain(comment,true,true);
        const total=r=>r.matchEvidence.brand+r.matchEvidence.series+r.matchEvidence.model;
        if(expanded.ok && total(expanded)>total(result))
          return confirmed({...expanded,matchPath:'catalog-rescue'});
      }
      return confirmed({...result,matchPath:path});
    }
    const first=explain(comment);
    if(first.separateVehicles)return first;
    if(first.ok)return chooseRanked(first,'character-primary');
    const retryable=['NO_SERIES','AMBIGUOUS_SERIES','NO_TRIM','NO_YEAR_MATCH'];
    let diagnostic=first;
    if(first.checkName || !first.ignored && retryable.includes(first.code)){
      const retry=explain(comment,true);
      if(retry.ok)return chooseRanked(retry,'character-fallback');
      if(retry.separateVehicles)return first;
      if(!first.ignored && !retry.ignored){
        const recovered=explain(comment,true,true);
        if(recovered.ok)return confirmed({...recovered,matchPath:'catalog-rescue'});
        if(recovered.separateVehicles)return first;
        if(!recovered.ignored && first.code==='NO_SERIES' && recovered.code!=='NO_SERIES')diagnostic=recovered;
      }
    }
    const raw=maskPaint(normalize(comment?.text));
    const lookupQuery=version!==undefined && describeTitle(raw,brands);
    if(lookupQuery && (first.code==='NO_SERIES'||first.code==='CHAT'||first.code==='AMBIGUOUS_SERIES' && lookupQuery.all.reduce((n,t)=>n+t.length,0)>lookupQuery.length) &&
       (raw.search(vehicleYear)>=0 || raw.search(vehicleDistance)>=0 || quoteCue.test(raw)) &&
       !prefilterComment(raw,removeSeparators(raw))){
      const r=explain(comment,true,true,true);
      if(r.ok)return confirmed({...r,matchPath:'catalog-title-characters'});
      if(r.code==='AMBIGUOUS_SERIES'&&diagnostic.code==='NO_SERIES')return r;
    }
    const {checkName,...result}=diagnostic;
    return result;
  };
}
module.exports={makeParser,extractMileage};
