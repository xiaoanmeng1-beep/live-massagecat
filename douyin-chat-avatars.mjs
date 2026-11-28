// Read only the sender of WebcastChatMessage, never badges, gifts, or a roster.
import {gunzipSync} from 'node:zlib';

const MAX_FRAME=1024*1024, MAX_INFLATED=4*MAX_FRAME;
export const AVATAR_WINDOW=5000;
const clean=s=>s.replace(/\s+/g,' ').trim();
function* fields(b) {
  let i=0;
  function varint() {
    let v=0n;
    for(let shift=0n;shift<70n && i<b.length;shift+=7n){
      const c=b[i++];v|=BigInt(c&127)<<shift;
      if(c<128)return v;
    }
    throw Error('bad varint');
  }
  for(let count=0;i<b.length;){
    if(++count>16000)throw Error('too many fields');
    const tag=Number(varint()), n=tag>>>3, w=tag&7;
    if(!n || tag>0xffffffff)throw Error('bad tag');
    if(w===0){yield [n,varint()];continue;}
    const size=w===2?Number(varint()):w===1?8:w===5?4:-1;
    if(size<0 || size>b.length-i)throw Error('bad size');
    const start=i;i+=size;
    if(w===2)yield [n,b.subarray(start,i)];
  }
}
const bytes=(f,n)=>f.find(([k,v])=>k===n && Buffer.isBuffer(v))?.[1];
const integer=(f,n)=>String(f.find(([k,v])=>k===n && typeof v==='bigint' && v>0n)?.[1]??'');
function senderAvatar(user){
  for(const kind of [9,10,11]){
    const img=bytes(user,kind);
    if(!img)continue;
    for(const [k,v] of fields(img)){
      if(k!==1 || !Buffer.isBuffer(v) || v.length>4096)continue;
      try {
        const u=new URL(v.toString());
        if(u.protocol==='https:' && !u.username && !u.password && /(?:^|\.)(douyinpic\.com|douyinstatic\.com|byteimg\.com)$/.test(u.hostname))return u.href;
      } catch {}
    }
  }
  return '';
}
const gzip=b=>b[0]===0x1f && b[1]===0x8b;
export function decodeChatFrame(input) {
  const chats=[];
  if(!input?.length || input.length>MAX_FRAME)return chats;
  try {
    // PushFrame.payload -> Response.messagesList -> Message.payload -> ChatMessage.
    let b=input;
    if(!gzip(b))b=bytes([...fields(b)],8)??b;
    if(gzip(b))b=gunzipSync(b,{maxOutputLength:MAX_INFLATED});
    for(const [k,v] of fields(b)){
      if(k!==1 || !Buffer.isBuffer(v))continue;
      try {
        const envelope=[...fields(v)];
        if(bytes(envelope,1)?.toString()!=='WebcastChatMessage')continue;
        const chat=[...fields(bytes(envelope,2))], body=bytes(chat,3);
        if(!body?.length || body.length>4096)continue;
        const sender=[...fields(bytes(chat,2))], name=bytes(sender,3);
        if(!name?.length || name.length>256)continue;
        const common=bytes(chat,1);
        const id=integer(envelope,3) || (common?integer([...fields(common)],2):'');
        if(id)chats.push({id,name:clean(name.toString()),text:clean(body.toString()),avatar:senderAvatar(sender)});
      } catch {} // One malformed message must not discard its neighbours.
    }
  } catch {}
  return chats;
}

export class RoomChatAvatars {
  constructor(){this.reset();}
  reset(){this.frames=new Map();this.pending=new Map();}
  ingest(chats,now=Date.now()){
    this.prune(now);
    for(const chat of chats){
      // Retransmission on the worker and page is the same message, not two viewers.
      if(this.frames.has(chat.id) && !chat.avatar)continue;
      this.frames.set(chat.id,{...chat,at:now});
      if(this.frames.size>600)this.frames.delete(this.frames.keys().next().value);
    }
  }
  prune(now){
    for(const [id,c] of this.frames)if(now-c.at>2*AVATAR_WINDOW)this.frames.delete(id);
    for(const [id,g] of this.pending)if(now-g.at>=AVATAR_WINDOW)this.pending.delete(id);
  }
  request(grants,now=Date.now()){
    for(const g of grants)this.pending.set(g.eventId,g);
    this.prune(now);
    return [...this.pending.values()];
  }
  resolve(grants, rows,now=Date.now()){
    const results=[];
    for(const g of grants){
      if(this.pending.get(g.eventId)!==g || now-g.at>=AVATAR_WINDOW)continue;
      const visible=rows.filter(r=>r.key===g.key && r.line===g.line);
      if(g.ambiguous || visible.length>1 || visible[0]?.ambiguous){this.pending.delete(g.eventId);continue;}
      const row=visible[0];
      if(row?.wireId)g.wireId=row.wireId; // Keep it if the DOM row scrolls away before the frame.
      const id=g.wireId || (g.key.startsWith('id:')?g.key.slice(3):'');
      const body=g.line.slice(g.line.indexOf('：')+1);
      let hit;
      if(id){
        const f=this.frames.get(id);
        if(f?.text===body)hit=f;
      }else{
        const exact=[...this.frames.values()].filter(f=>Math.abs(f.at-g.at)<AVATAR_WINDOW && f.name+'：'+f.text===g.line);
        if(exact.length===1)hit=exact[0];
      }
      const avatar=row?.avatar || hit?.avatar;
      if(!avatar)continue;
      this.pending.delete(g.eventId);
      results.push({type:'queued-avatar-result',room:g.room,id:g.id,eventId:g.eventId,avatar});
    }
    return results;
  }
}

// Attach to the selected page and its dedicated workers, not a browser-wide session.
export function roomWireTap(initialRoom,expectedRoom,avatars,onNavigation=()=>{}){
  let pageRoom=initialRoom, generation=0;
  const sockets=new Map(), workers=new Map();
  const rid=url=>{try{const u=new URL(url);return u.origin==='https://live.douyin.com' && /^\/\d+\/?$/.test(u.pathname)?u.pathname.split('/')[1]:'';}catch{return '';}};
  const webcast=url=>{try{const u=new URL(url);return u.protocol==='wss:' && /(?:^|\.)(douyin\.com|amemv\.com)$/.test(u.hostname) && /^\/webcast\/im\/push(?:\/|$)/.test(u.pathname);}catch{return false;}};
  function navigate(url){
    generation++;pageRoom=rid(url);sockets.clear();avatars.reset();onNavigation();
  }
  const autoAttach={autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'worker'},{exclude:true}]};
  async function enable(rpc){
    await rpc('Page.enable');
    await Promise.allSettled([rpc('Network.enable'),rpc('Target.setAutoAttach',autoAttach)]);
  }
  function event(m,rpc){
    const p=m.params||{},sid=m.sessionId||'';
    if(!sid && m.method==='Page.frameNavigated' && !p.frame.parentId){navigate(p.frame.url);return;}
    if(!sid && m.method==='Page.navigatedWithinDocument' && rid(p.url)!==pageRoom){
      // Check this is the top frame; iframe navigation does not change the room.
      rpc('Page.getFrameTree').then(t=>{if(t.frameTree.frame.id===p.frameId && rid(t.frameTree.frame.url)!==pageRoom)navigate(t.frameTree.frame.url);}).catch(()=>{});return;
    }
    if(m.method==='Target.detachedFromTarget'){workers.delete(p.sessionId);return;}
    if(m.method==='Target.attachedToTarget' && p.targetInfo?.type==='worker'){
      if(sid && workers.get(sid)!==generation)return;
      workers.set(p.sessionId,generation);
      rpc('Network.enable',{},p.sessionId).catch(()=>{});return;
    }
    if(!pageRoom || pageRoom!==expectedRoom() || (sid && workers.get(sid)!==generation))return;
    const key=sid+':'+p.requestId;
    if(m.method==='Network.webSocketCreated'){
      sockets.set(key,webcast(p.url));
      if(sockets.size>256)sockets.delete(sockets.keys().next().value);
    }else if(m.method==='Network.webSocketClosed'){sockets.delete(key);}
    else if(m.method==='Network.webSocketFrameReceived' && p.response?.opcode===2){
      // Chrome may not replay Created for sockets already open at initial attach.
      // After navigation, require a newly observed webcast socket in the new room.
      if(!(sockets.get(key)??(generation===0)) || typeof p.response.payloadData!=='string'
        || p.response.payloadData.length>Math.ceil(MAX_FRAME/3)*4)return;
      avatars.ingest(decodeChatFrame(Buffer.from(p.response.payloadData,'base64')));
    }
  }
  return {enable,event,get generation(){return generation;}};
}
