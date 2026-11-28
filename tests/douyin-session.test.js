'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DouyinBridgeProcess,DouyinBridgeSession}=require('../douyin-bridge-process');
const {DouyinBridgeClient}=require('../douyin-bridge');

test('复用 Chrome 开标签以 PUT 直接传地址；空白返回值只导航新标签，不等全页轮询',async()=>{
  const {openTab,ensureRoomNavigation,roomFromPage}=await import('../douyin-bridge-service.mjs');
  const room='442416535474', url='https://live.douyin.com/'+room;
  const target={id:'new-tab',type:'page',url:'about:blank',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/new-tab'};
  const calls=[];
  const tab=await openTab(9223,url,async (address,method)=>{
    calls.push({address,method});return target;
  });
  assert.deepEqual(calls,[{address:'http://127.0.0.1:9223/json/new?'+encodeURIComponent(url),method:'PUT'}]);
  assert.equal(tab,target);
  assert.equal(await ensureRoomNavigation(tab,room,async(method,params)=>calls.push({id:tab.id,method,params})),true);
  assert.deepEqual(calls[1],{id:'new-tab',method:'Page.navigate',params:{url}});
  assert.equal(await ensureRoomNavigation({...tab,url},room,()=>assert.fail('同一房间不重复导航')),false);
  assert.equal(roomFromPage('https://live.douyin.com.example/'+room),'');
  assert.equal(await openTab(9223,url,async()=>({type:'service_worker',id:'other'})),null);
  await assert.rejects(ensureRoomNavigation(tab,room,async()=>({errorText:'failed'})),/直播间页面打开失败/);
});

test('有已保存房间仍以断开状态启动，打开界面查询状态不连接',()=>{
  const process=new DouyinBridgeProcess({dataDirectory:'/unused-test-fixture'});
  process.readRoom=()=> '442416535474';
  process.start=()=>assert.fail('启动应用不应启动桥进程');
  const client=new DouyinBridgeClient();
  client.connect=()=>assert.fail('启动应用不应连接 WebSocket');
  for(let restart=0;restart<2;restart++){
    const session=new DouyinBridgeSession(process,client);
    const status=session.snapshot();
    assert.equal(status.room,'442416535474');
    assert.equal(status.state,'closed');
    assert.equal(status.connected,false);
    assert.equal(status.process.pid,0);
    assert.equal(client.socket,null);
    assert.equal(client.reconnectTimer,null);
  }
});

test('手动连接启动桥，启动途中点断开后迟到的就绪回执也不会重新连接',async()=>{
  let ready, room='442416535474', state='idle', connected=false;
  const calls=[];
  const process={
    snapshot:()=>({room,state,pid:state==='idle'||state==='stopped'?0:1}),
    start(r){room=r;state='starting';calls.push('start');},
    waitUntilReady:()=>new Promise(resolve=>{ready=resolve;}),
    stop(){state='stopped';calls.push('stop');}
  };
  const client={
    snapshot:()=>({room,state:connected?'connected':'closed',connected}),
    setRoom(r){room=r;},
    connect(){connected=true;calls.push('connect');},
    close(){connected=false;calls.push('close');}
  };
  const session=new DouyinBridgeSession(process,client);
  const first=session.connect(room);
  assert.deepEqual(calls,['start']);
  session.disconnect();ready();
  assert.equal((await first).connected,false);
  assert.deepEqual(calls,['start','close','stop']);
  const second=session.connect(room);
  state='running';ready();
  assert.equal((await second).connected,true);
  assert.deepEqual(calls,['start','close','stop','start','connect']);
});

test('本地 WS 连通、评论区准备、采集就绪分别呈现；旧房间回报不误亮绿灯',()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const src=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
  const dom={douyinBridgeBadge:{},douyinRoomInput:{},douyinProcessStatus:{},douyinConnectionStatus:{},document:{},setDouyinBridgeMessage(text){dom.text=text;}};
  vm.runInNewContext(src.slice(src.indexOf('function renderDouyinBridgeStatus'),src.indexOf('async function connectDouyinBridgeFromForm')),dom);
  function render(phase,room='12345',state='connected'){
    dom.renderDouyinBridgeStatus({room:'12345',state,process:{state:'running',capture:{room,phase}}});
    return dom.douyinBridgeBadge.textContent;
  }
  assert.equal(render('opening'),'准备采集');assert.match(dom.text,/本地桥/);
  assert.equal(render('waiting-chat'),'准备采集');assert.match(dom.text,/评论区/);
  assert.equal(render('listening','54321'),'准备采集');
  assert.equal(render('listening'),'采集中');
  assert.notEqual(render('listening','12345','disconnected'),'采集中');
});
