'use strict';
(() => {
  const byId=id=>document.getElementById(id);
  const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
  function person(job){
    const wrap=node('span','board-person'), face=node('span','board-avatar',job?Array.from(job.name||'观')[0]:'');
    if(/^https:\/\//i.test(job?.avatar||'')){
      const img=document.createElement('img');img.alt='';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.remove(),{once:true});img.src=job.avatar;face.append(img);
    }
    wrap.append(face,node('span','board-name',job?.name));return wrap;
  }
  const studioReady=import('./quote-studio-photo.mjs').then(m=>m.studioCutout).catch(()=>null);
  const cutouts=new Map();
  // Only use app-owned pixels. Keep the original src for fallbacks, palette extraction and handoff.
  async function prepareStudioImage(img){
    const cut=await studioReady;
    if(!cut||!img.isConnected)return;
    const key=img.src;
    try{
      if(!cutouts.has(key)){
        const result=cut(img);
        cutouts.set(key,result?.toDataURL('image/png')||null);
        if(cutouts.size>10)cutouts.delete(cutouts.keys().next().value);
      }
      const prepared=cutouts.get(key);
      if(prepared&&img.isConnected&&img.src===key)img.srcset=prepared;
    }catch{/* Unreadable/non-studio photos keep their original pixels. */}
  }
  function vehiclePicture(src,samplePhoto){
    const wrap=node('span','board-vehicle-photo');
    const valid=typeof src==='string' && (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(src) || /^https:\/\/[^/]+\.che300\.com\//i.test(src));
    const img=node('img');img.alt='车型参考图';img.referrerPolicy='no-referrer';
    img.addEventListener('load',()=>{
      img.setAttribute('data-ready','');
      if(samplePhoto||valid&&src.startsWith('data:image/'))void prepareStudioImage(img);
    },{once:true});
    img.addEventListener('error',()=>{img.src='./car-silhouette.svg';},{once:true});
    img.src=samplePhoto||(valid?src:'./car-silhouette.svg');wrap.append(img);
    return wrap;
  }
  function details(job){return [job.province===job.city?job.city:(job.province||'')+job.city,job.input.registration+' 上牌',job.input.mileage+' 万公里'].join(' · ');}
  // Presentation-only fallback. Never send these rows through the quote service
  // or include them in previousCards: the first live result has no old hero to archive.
  const samples=[
    ['阿杰','威驰','1.5L 自动挡','2017-05',12,4.20,4.80,'vios.jpg'],
    ['小林','朗逸','230TSI 手动舒适版','2018-06',9,1.77,2.30,'lavida.jpg'],
    ['岩语','奥迪A3','Sportback','2019-08',8,7.50,8.10,'audi-a3.jpg'],
    ['小周','奥迪A4L','舒适型','2018-10',10,8.30,9.20,'audi-a4l.jpg'],
    ['晨光','奔驰A级','A 200 L','2020-07',6,5.27,6.02,'mercedes-a.png']
  ];
  function sampleCard(index,featured){
    const [name,seriesName,trim,registration,mileage,low,high,photo]=samples[index];
    return quoteCard({name,seriesName,car:seriesName+' '+trim,input:{registration,mileage},low,high},featured,'./quote-samples/'+photo);
  }
  function quoteCard(job,featured,samplePhoto){
    const card=node(featured?'article':'li','quote-card'+(featured?' featured-quote':'')+(samplePhoto?' sample-quote':''));
    const info=node('div','card-info'), model=job.car.replace(/^\s*\d{4}\s*款\s*/, '');
    const who=person(job);
    const year=String(job.input.registration||'').match(/^\d{4}/)?.[0];
    const title=node('strong','car-name',model);
    if(featured){
      who.querySelector('.board-name').title=job.name||'';
      // Do not split names such as "Model 3" on the first space. Use the catalog
      // series only if it matches the actual quoted model, incl. provider overrides.
      const series=job.seriesName?.trim();
      if(series&&model.startsWith(series)&&/^\s/.test(model.slice(series.length))){
        const trim=node('span','car-trim');
        for(const word of model.slice(series.length).trim().split(/\s+/)){
          if(trim.firstChild)trim.append(' ');
          trim.append(node('span','trim-word',word));
        }
        title.replaceChildren(node('span','car-series',series),' ',trim);
      }
      card.append(who);
    }else info.append(who);
    const context=node('small','quote-context',job.input.mileage+' 万公里');
    if(year)context.replaceChildren(node('span','',year+' 年'),' · ',node('span','',job.input.mileage+' 万公里'));
    info.append(title,context);
    const price=node('div','card-price');
    if(featured)price.append(node('span','price-label','收车参考价'));
    const amount=job.low===job.high?job.low.toFixed(2):job.low.toFixed(2)+'～'+job.high.toFixed(2);
    const number=featured?node('span','quote-amount'):price;
    number.append(node('b','',amount),node('small','','万'));
    if(featured)price.append(number);
    const photo=vehiclePicture(job.photo,samplePhoto);
    if(featured)card.append(info,photo,price);
    else card.append(photo,info,price);
    return card;
  }
  const queue=byId('boardQueue'), current=byId('boardCurrent'), history=byId('boardHistory');
  const historySlots=4;
  const edgeHost=byId('quoteEdge');
  // The visual is optional. Render results immediately, even if WebGL or the module fails.
  const edgeReady=import('./quote-edge.mjs').then(m=>m.createQuoteEdge(edgeHost)).catch(()=>null);
  let rev=-1, waiting=[], queueSlots=4, previousCards=[];
  const key=j=>j&&JSON.stringify([j.room||'',j.eventId||j.id]);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const handoffMs=1650;
  let rows=new Map(),flight=null;
  const motion=new Set();
  function animate(el,frames,options,done){
    const a=el.animate(frames,options);motion.add(a);
    const finish=()=>{motion.delete(a);done?.();};a.finished.then(finish,finish);
  }
  function settle(){for(const a of motion)a.cancel();motion.clear();flight?.remove();flight=null;}
  reduced.addEventListener('change',()=>{if(reduced.matches)settle();});
  function revealFeatured(){
    // Keep both the glass panel and its pinned light edge in place. Only
    // the content fades in once the departing card starts exposing it.
    for(const part of current.firstElementChild.children)animate(part,[
      {opacity:.28},
      {opacity:.28,offset:.06,easing:'cubic-bezier(.4,0,.2,1)'},
      {opacity:1,offset:.59},
      {opacity:1}
    ],{duration:handoffMs});
  }
  const sharedParts={photo:'.board-vehicle-photo',viewer:'.board-person',model:'.car-name',context:'.quote-context',amount:'.card-price'};
  function measureCard(el,hero){
    const parts={};
    for(const [key,selector] of Object.entries(sharedParts)){
      const part=el.querySelector(hero&&key==='amount'?'.quote-amount':selector);
      parts[key]={el:part,rect:part.getBoundingClientRect(),font:parseFloat(getComputedStyle(part).fontSize)};
    }
    return {rect:el.getBoundingClientRect(),radius:getComputedStyle(el).borderRadius,parts};
  }
  function handoff(old,source,target,retained,reusePhoto){
    // Commit real quotes first. Only the travelling surface and the outgoing
    // two-line copy are decorative; the moving photo, price and viewer belong
    // to the actual first history row throughout.
    byId('boardContent').dispatchEvent(new Event('board-before-handoff'));
    const dest=measureCard(target,false),from=source.rect,to=dest.rect;
    if(!from.width||!from.height||!to.width||!to.height)return;
    const layer=node('div','active-box quote-flight-layer');layer.inert=true;
    layer.setAttribute('aria-hidden','true');byId('liveBoard').append(layer);flight=layer;
    const area=layer.getBoundingClientRect(),zoom=area.width/parseFloat(getComputedStyle(layer).width)||1;
    const px=n=>n/zoom+'px',translate=(x,y)=>'translate('+px(x)+','+px(y)+')';
    const timing={duration:handoffMs,easing:'cubic-bezier(.42,0,.58,1)'};
    // Match the two rounded surfaces in screen coordinates but never animate
    // their layout or paint parameters. Text and photos stay outside both shells.
    const place=(el,r,radius)=>Object.assign(el.style,{
      left:px(r.left-area.left),top:px(r.top-area.top),width:px(r.width),height:px(r.height),borderRadius:radius
    });
    const surface=node('div','quote-flight-surface');
    const landing=node('div','quote-flight-surface quote-flight-landing');
    place(landing,to,dest.radius);place(surface,from,source.radius);place(old,from,source.radius);
    const tint=edgeHost.hasAttribute('data-active')&&edgeHost.style.getPropertyValue('--edge-body');
    if(tint)surface.style.boxShadow='0 0 6px 1px '+tint;
    layer.append(landing,surface,old);
    const sx=to.width/from.width,sy=to.height/from.height,dx=to.left-from.left,dy=to.top-from.top;
    const transform=(x,y,w,h)=>translate(x,y)+' scale('+w+','+h+')';
    animate(landing,[{transform:transform(-dx,-dy,1/sx,1/sy)},{transform:transform(0,0,1,1)}],timing);
    animate(surface,[{transform:transform(0,0,1,1)},{transform:transform(dx,dy,sx,sy)}],timing,()=>{
      layer.remove();if(flight===layer)flight=null;
    });
    animate(surface,[{opacity:1},{opacity:1,offset:.54},{opacity:0,offset:.88},{opacity:0}],timing);
    const image=source.parts.photo.el.firstElementChild;
    if(reusePhoto&&image?.naturalWidth)dest.parts.photo.el.replaceChildren(image);
    for(const key of Object.keys(sharedParts)){
      const a=source.parts[key],b=dest.parts[key],s=a.rect,d=b.rect;
      if(!d.width||!d.height||!s.width||!s.height)continue;
      const anchor=key==='photo'?0.5:key==='amount'?1:0;
      const dx=s.left+s.width*anchor-d.left-d.width*anchor,dy=s.top+s.height/2-d.top-d.height/2;
      // Match the painted car (object-fit:contain), not the aspect ratio of its slot.
      const aspect=image?.naturalWidth/image?.naturalHeight||d.width/d.height;
      const scale=key==='photo'?Math.min(s.width,s.height*aspect)/Math.min(d.width,d.height*aspect):a.font/b.font;
      const origin=(anchor*100)+'% 50%';
      const travel=(el,start,end)=>animate(el,[{transform:start,transformOrigin:origin},{transform:end,transformOrigin:origin}],timing);
      const initial=translate(dx,dy)+' scale('+scale+')';
      if(key==='photo'){
        // Pass underneath the changing title, then rise into the left thumbnail.
        // Use the interpolated card bounds so the route also fits zoomed layouts.
        const lane=(offset,x,depth,factor)=>{
          const top=from.top+(to.top-from.top)*offset,height=from.height+(to.height-from.height)*offset;
          const size=1+(scale-1)*factor;
          const halfPhoto=Math.min(d.height,d.width/aspect)*size/2;
          const center=Math.min(top+height*depth,top+height-halfPhoto-2*zoom);
          return {offset,transform:translate(dx*x,center-d.top-d.height/2)+' scale('+size+')',transformOrigin:origin};
        };
        animate(b.el,[{transform:initial,transformOrigin:origin},
          lane(.26,.50,.72,.64),lane(.50,.08,.83,.36),lane(.68,0,.64,.18),
          {transform:'none',transformOrigin:origin}],timing);
      }else travel(b.el,initial,'none');
      if(key==='model'||key==='context'){
        // Crossfade the two layouts at the same moving anchor. Neither the
        // vehicle name nor its context should disappear between layouts.
        travel(a.el,'none',translate(-dx,-dy)+' scale('+(1/scale)+')');
        animate(a.el,[{opacity:1},{opacity:1,offset:.51},{opacity:0,offset:.59},{opacity:0}],timing);
        animate(b.el,[{opacity:0},{opacity:0,offset:.51},{opacity:1,offset:.59},{opacity:1}],timing);
      }
    }
    const label=old.querySelector('.card-price');
    animate(label,[{opacity:1,transform:'none'},{opacity:0,offset:.24,transform:translate(0,(to.top-from.top)*.18)},{opacity:0}],timing);
    for(const [el,top] of retained){
      const delta=(top-el.getBoundingClientRect().top)/zoom;
      if(Math.abs(delta)>1)animate(el,[{transform:'translateY('+delta+'px)'},{transform:'none'}],timing);
    }
  }
  function renderCards(cards){
    const job=cards[0],prev=previousCards[0],old=current.firstElementChild;
    const changed=key(job)!==key(prev);
    // A late avatar/name update must not cut the quote's running transition.
    if(old&&job&&prev&&!changed&&sameCard({...prev,name:job.name,avatar:job.avatar},job)
      &&cards.length===previousCards.length&&cards.slice(1).every((j,i)=>sameCard(j,previousCards[i+1]))){
      const who=person(job);who.querySelector('.board-name').title=job.name||'';
      old.querySelector('.board-person').replaceWith(who);return;
    }
    if(changed||flight)settle();
    const moving=old&&job&&prev&&changed&&key(cards[1])===key(prev)&&!reduced.matches;
    const from=moving&&measureCard(old,true),tops=new Map(),retained=[];
    if(moving)for(const {el} of rows.values())tops.set(el,el.getBoundingClientRect().top);
    if(!old||((job||prev)&&!sameCard(job,prev))){
      const card=job?quoteCard(job,true):sampleCard(0,true);current.replaceChildren(card);
      edgeReady.then(edge=>{if(current.firstChild===card)edge?.select(card,job);});
    }
    const next=new Map();
    for(let i=0;i<historySlots;i++){
      const j=cards[i+1],k=key(j)||'sample:'+i,was=rows.get(k);
      const el=was&&(!j||sameCard(j,was.job))?was.el:j?quoteCard(j,false):sampleCard(i+1,false);
      next.set(k,{el,job:j});
      if(j&&tops.has(el))retained.push([el,tops.get(el)]);
      if(history.children[i]!==el)history.insertBefore(el,history.children[i]||null);
    }
    for(const [k,{el}] of rows)if(next.get(k)?.el!==el)el.remove();
    rows=next;
    if(moving){
      handoff(old,from,history.firstElementChild,retained,prev.photo===cards[1].photo);
      revealFeatured();
    }
  }
  renderCards([]);
  function drawQueue(){
    const visible=waiting.slice(0,queueSlots);
    const items=visible.map(job=>{const li=node('li','queue-item');li.append(person(job));return li;});
    if(waiting.length>visible.length){
      const more=node('li','queue-more','...');
      more.setAttribute('aria-label','另有'+(waiting.length-visible.length)+'位观众排队');
      items.push(more);
    }
    queue.replaceChildren(...items);
    byId('queueCount').textContent=waiting.length+'人';
    byId('queueEmpty').hidden=!!waiting.length;
    queue.hidden=!waiting.length;
  }
  new ResizeObserver(([entry])=>{
    const w=entry.contentRect.width;
    const slots=w<300?1:w<440?2:w<560?3:4;
    if(slots!==queueSlots){queueSlots=slots;drawQueue();}
  }).observe(document.querySelector('.valuation-column'));
  function sameCard(a,b){
    return a&&b&&key(a)===key(b)&&a.id===b.id&&a.name===b.name&&a.avatar===b.avatar&&a.car===b.car&&a.seriesName===b.seriesName&&a.photo===b.photo
      &&a.input.mileage===b.input.mileage&&a.input.registration===b.input.registration&&a.low===b.low&&a.high===b.high;
  }
  function draw(s){
    if(!s||s.rev<=rev)return;
    const first=rev<0;rev=s.rev;
    const people=new Map();
    for(const job of s.pending){const key=job.userId||job.name;if(!people.has(key))people.set(key,job);}
    const nextWaiting=[...people.values()];
    if(first||waiting.length!==nextWaiting.length||nextWaiting.some((v,i)=>v.name!==waiting[i].name||v.avatar!==waiting[i].avatar)){
      waiting=nextWaiting;drawQueue();
    }
    byId('resumeLiveQuotes').hidden=!s.blocked;
    const cards=s.history;
    if(cards.length!==previousCards.length||!cards.every((j,i)=>sameCard(j,previousCards[i]))){
      renderCards(cards);
      previousCards=cards;
    }
  }
  const input=byId('commentTestInput'),match=byId('commentTestMatch'),quote=byId('commentTestQuote');
  const result=byId('commentTestResult'),price=byId('commentTestPrice');
  let revision=0,ticket=null,fetching=false;
  window.addEventListener('quote-provider-changed',()=>{
    revision++;ticket=null;quote.disabled=true;match.disabled=false;result.replaceChildren();price.replaceChildren();
  });
  input.addEventListener('input',()=>{
    revision++;ticket=null;quote.disabled=true;match.disabled=false;
    result.replaceChildren();price.replaceChildren();
  });
  match.onclick=async()=>{
    const run=++revision;ticket=null;quote.disabled=true;match.disabled=true;price.replaceChildren();
    result.textContent='匹配中…';
    try{
      const r=await window.desktop.testCommentMatch(input.value);
      if(run!==revision)return;
      if(!r.ok){result.textContent=(r.ignored?'已忽略：':'未入队：')+r.reason;return;}
      ticket=r.ticket;const j=r.job;
      result.replaceChildren(node('strong','',j.car),node('p','',details(j)+' · ID '+j.input.modelId),node('p','',j.reason));
      quote.disabled=fetching;
    }catch(e){if(run===revision)result.textContent='匹配失败：'+e.message;}
    finally{if(run===revision)match.disabled=false;}
  };
  quote.onclick=async()=>{
    if(!ticket||fetching)return;
    const run=revision;fetching=true;quote.disabled=true;price.textContent='查价中…';
    try{
      const r=await window.desktop.testCommentQuote(ticket);
      if(run!==revision)return;
      const p=r?.prices?.good;
      if(!r?.ok||!Number.isFinite(p?.low)||!Number.isFinite(p?.high)||p.low<=0||p.high<p.low){price.textContent=r?.message||'本次未取得有效报价';return;}
      const amount=p.low===p.high?p.low.toFixed(2):p.low.toFixed(2)+'～'+p.high.toFixed(2);
      price.replaceChildren(node('strong','','收车参考价 '+amount+' 万'),vehiclePicture(r.vehicle?.imageData||r.vehicle?.imageUrl));
    }catch(e){if(run===revision)price.textContent='查价失败：'+e.message;}
    finally{fetching=false;quote.disabled=!ticket;}
  };
  byId('resumeLiveQuotes').onclick=()=>window.desktop.resumeQuotes();
  window.desktop.onQuoteBoard(draw);
  window.desktop.getQuoteBoard().then(draw).catch(()=>{if(rev<0)console.warn('暂未取得报价队列状态');});
})();
