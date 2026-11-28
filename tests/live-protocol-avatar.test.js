'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const {QuoteBoard,attemptLiveMatch}=require('../live-board');
const A='https://p3-pc-sign.douyinpic.com/avatar/fixture.webp', B=A+'?b';
const room='123456', text='19年思域6万公里', name='小张', line=name+'：'+text;
function vi(x){
  x=BigInt(x);const buf=[];
  while(x>127n){buf.push(Number(x&127n)|128);x>>=7n;}buf.push(Number(x));return Buffer.from(buf);
}
function b(n,s){s=Buffer.from(s);return Buffer.concat([vi(n*8+2),vi(s.length),s]);}
const i=(n,s)=>Buffer.concat([vi(n*8),vi(s)]), cat=(...x)=>Buffer.concat(x);
function packet({id=9123456789012345678n,nick=name,body=text,url=A,method='WebcastChatMessage',noId=false}={}){
 const sender=cat(i(1,990000000000000000n),b(3,nick),b(9,b(1,url)));
 const chat=cat(b(1,i(2,id)),b(2,sender),b(3,body),b(5,b(1,B)));
 return b(1,cat(b(1,method),b(2,chat),...(noId?[]:[i(3,id)])));
}
const load=()=>import('../douyin-chat-avatars.mjs');
const g=(at,extra={})=>({room,eventId:'e1',id:1,line,key:'text:'+line,at,...extra});

test('限定到评论发送人字段：64位ID、gzip PushFrame/裸 Response、非头像的 URL 不取',async()=>{
 const {decodeChatFrame:decode}=await load();
 const batch=cat(packet({noId:true}),packet({method:'WebcastGiftMessage'}),packet({id:18,url:'https://evil.test/'+A}),packet({id:19,url:''}));
 const expected=[{id:'9123456789012345678',name,text,avatar:A},{id:'18',name,text,avatar:''},{id:'19',name,text,avatar:''}];
 for(const data of [batch,b(8,batch),b(8,gzipSync(batch)),gzipSync(batch)])assert.deepEqual(decode(data),expected);
 for(const bad of [Buffer.from([0]),Buffer.from([0x1f,0x8b]),Buffer.alloc(1048577),b(8,gzipSync(Buffer.alloc(4194305)))])assert.deepEqual(decode(bad),[]);
});
test('同一房间、同一条评论才补头像；不同正文、重复同名同文、过期和换房都不套用',async()=>{
 const {RoomChatAvatars,decodeChatFrame}=await load(), f=new RoomChatAvatars();
 const t=10000;f.ingest(decodeChatFrame(cat(packet(),packet({id:22,url:B}))),t);
 const resolve=(grant,rows=[],now=t)=>f.resolve(f.request([grant],now),rows,now);
 assert.deepEqual(resolve(g(t)),[]); // no DOM id and nonunique
 const byId=g(t,{key:'id:22'});assert.equal(resolve(byId)[0].avatar,B);
 assert.deepEqual(resolve({...byId,line:name+'：不同车型'}),[]);
 assert.deepEqual(resolve(g(t,{key:'id:99'})),[]);
 f.reset();f.ingest(decodeChatFrame(packet()),t);assert.deepEqual(resolve(g(t),[{key:g(t).key,line,ambiguous:true}]),[]);
 assert.deepEqual(resolve(g(t),[],t+5000),[]);
 f.reset();assert.deepEqual(resolve(g(t)),[]);
});
test('实桥的 CDP 通知回放：worker 先/后到、DOM无图片或行已滚走，报价仍只执行一次且历史卡补回头像',async()=>{
 const {RoomChatAvatars,roomWireTap}=await load();
 const {avatarAdmissions,collectChatRows,parseChatLine,diffNew}=await import('../douyin-bridge-service.mjs');
 for(const early of [true,false]){
  let current=room,quotes=0,calls=[];
  const f=new RoomChatAvatars(), a=avatarAdmissions(), tap=roomWireTap(room,()=>current,f,()=>a.reset());
  const rpc=async(...args)=>calls.push(args);
  const ev=(method,params,sessionId)=>tap.event({method,params,sessionId},rpc);
  await tap.enable(rpc);
  ev('Target.attachedToTarget',{sessionId:'w',targetInfo:{type:'worker'}});
  assert.ok(calls.some(([m,,s])=>m==='Network.enable' && s==='w'));
  const frame={requestId:'1',response:{opcode:2,payloadData:b(8,gzipSync(packet())).toString('base64')}};
  const send=()=>ev('Network.webSocketFrameReceived',frame,'w');
  ev('Network.webSocketCreated',{requestId:'1',url:'wss://example.org/webcast/im/push/'},'w');send();assert.equal(f.frames.size,0);
  ev('Network.webSocketCreated',{requestId:'1',url:'wss://webcast5-ws-web-hl.douyin.com/webcast/im/push/v2/'},'w');
  if(early){send();send();}
  const root={nodeType:1,innerText:line,getAttribute:()=>null};
  root.childNodes=[{nodeType:1,innerText:line,parentElement:root,childNodes:[{nodeType:3,nodeValue:line}],getAttribute:()=>null,querySelectorAll:()=>[]}];
  const board=new QuoteBoard({quote:async()=>{quotes++;return {ok:true,prices:{good:{low:1,high:2}}};},pause:async()=>{}});
  const [row]=diffNew(collectChatRows(root),new Set());
  a.issued(room,row,'e1');
  const msg={...parseChatLine(row.line),room,id:1,eventId:'e1'};
  attemptLiveMatch(e=>({ok:true,job:{...e,input:{}}}),board,msg,e=>a.accept({...e,type:'queued-avatar'},room));
  await new Promise(setImmediate);
  assert.equal(board.history.length,1);
  const accepted=f.request(a.take(room));
  if(!early){assert.deepEqual(f.resolve(accepted,collectChatRows(root,accepted)),[]);send();}
  const [result]=f.resolve(f.request([]),[]);
  assert.equal(board.setQueuedAvatar(result),true);assert.equal(board.history[0].avatar,A);assert.equal(quotes,1);
  assert.deepEqual(f.resolve(f.request([]),[]),[]);
  current='987654';ev('Page.frameNavigated',{frame:{url:'https://live.douyin.com/'+current}});
  send();assert.equal(f.frames.size,0);assert.equal(f.pending.size,0);
 }
});
test('没有 img 的询价行：只读该条绑定的发送人；无关消息、坏域名与非入队行不读图',async()=>{
 const {collectChatRows}=await import('../douyin-bridge-service.mjs');
 const root={nodeType:1,innerText:line,getAttribute:()=>null};
 const el={nodeType:1,parentElement:root,innerText:line,childNodes:[{nodeType:3,nodeValue:line}],getAttribute:()=>null,querySelectorAll:()=>[]};
 root.childNodes=[el];
 let reads=0;
 const user={nickname:name,get avatar_thumb(){reads++;return {url_list:['https://bad.invalid/avt',A]};}};
 const msg={content:text,msg_id_str:'9123456789012345678',user};
 el.__reactProps$local={item:{payload:msg}};
 const [row]=collectChatRows(root);
 assert.equal(reads,0);assert.equal(row.avatar,undefined);
 assert.deepEqual(collectChatRows(root,[row])[0],{...row,wireId:msg.msg_id_str,avatar:A});
 msg.content='别人问的车';assert.equal(collectChatRows(root,[row])[0].avatar,undefined);
 msg.content=text;user.nickname='同名中的另一位';assert.equal(collectChatRows(root,[row])[0].avatar,undefined);
});
