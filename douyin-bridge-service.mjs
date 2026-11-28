#!/usr/bin/env node
// 评论从直播间页面入队；用同一条直播消息的发送人头像回填，不让图片阻塞报价。
// node douyin-bridge-service.mjs [房间号] [WS端口]；独立运行时没有入队回执，不读头像。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startWSServer } from './bridge-ws.mjs';
import { RoomChatAvatars,roomWireTap } from './douyin-chat-avatars.mjs';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DATA_DIR = process.env.DOUYIN_BRIDGE_DATA_DIR || __dirname;
fs.mkdirSync(BRIDGE_DATA_DIR, { recursive: true });
const ROOM_FILE = path.join(BRIDGE_DATA_DIR, '.bridge-room');
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

// —— 纯解析函数（供测试） ——

export function parseChatLine(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Identify notices from their prefix/sender, not words inside a viewer's comment.
  if (/^(?:欢迎来到直播间|严禁|未成年人|网络诈骗|理性消费|新功能|三屏|点击体验)/.test(text)
      || /^(?:提示|公告|系统)\s*[：:]/.test(text)) return { kind: 'system', text };
  let m = text.match(/^(.{1,24}?)\s*[：:]\s*(.*)$/);
  if (m) {
    const name = m[1].trim(), body = m[2].trim();
    if (!name || isJunkName(name)) return null;
    const g = body.match(/^(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
    if (g && g[1].trim()) return { kind: 'gift', name, gift: g[1].trim(), count: g[2] ? +g[2] : 1 };
    if (/^(关注了主播|关注了直播间|成为新粉丝)/.test(body)) return { kind: 'follow', name };
    if (!body) return null;
    return { kind: 'comment', name, text: body };
  }
  m = text.match(/^(.{1,24}?)\s*(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
  if (m && m[2].trim() && !isJunkName(m[1].trim())) return { kind: 'gift', name: m[1].trim(), gift: m[2].trim(), count: m[3] ? +m[3] : 1 };
  m = text.match(/^(.{1,20}?)\s*来了$/);
  if (m) return { kind: 'join', name: m[1].trim() };
  m = text.match(/^(.{1,24}?)\s*(?:关注了主播|关注了直播间|成为新粉丝|推荐了直播)/);
  if (m) return { kind: 'follow', name: m[1].trim() };
  return null;
}

export function mapGift(name) {
  if (/啤酒/.test(name)) return 'beer';
  if (/棒棒糖/.test(name)) return 'lollipop';
  if (/爱心|红心|心心/.test(name)) return 'heart';
  return 'other';
}

// 垃圾名判定：feed卡标签、动作短语等不是观众昵称。
export function isJunkName(n) {
  if (!n) return true;
  const s = String(n);
  if (/充钻石|客户端|壁纸通知|消息投稿|互相关注|粉丝团|账号已在其他地方|进入直播间|扫码登录/.test(s)) return true;
  if (s.length < 1 || s.length > 24) return true;
  if (/^(送出了?|送了|来了|关注|粉丝|评论|分享|关注了.*)$/.test(s)) return true;
  if (/分享\[视频\]|前天分享|小时榜|人气榜|本场点赞|在线观众|贡献/.test(s)) return true;
  // Real viewers can have Unicode letters, digits or emoji, or a masked display name.
  if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s)) return false;
  if (/^[.．·…•*＊✱✳]+$/u.test(s) && (s.match(/[*＊✱✳]/gu) || []).length >= 2) return false;
  return true;
}

// A recycled notice can remain at the bottom of the list while new chat rows
// appear above it. A previously seen row isn't an end-of-batch marker.
const pendingRows = new WeakMap();
export function diffNew(lines, seen, cap = 80) {
  if(!pendingRows.has(seen))pendingRows.set(seen,[]);
  const pending=pendingRows.get(seen);
  for (const row of lines.slice(-600)) {
    const sig = typeof row === 'string' ? row : row.key;
    if (seen.delete(sig)) { seen.add(sig); continue; } // keep visible rows in the bounded buffer
    seen.add(sig);
    pending.push(row);
  }
  while (seen.size > 600) seen.delete(seen.values().next().value);
  // Do not mark a row seen then throw it away merely because a poll burst
  // exceeded the per-tick quota. Keep FIFO overflow even if its DOM disappears.
  return pending.splice(0,cap);
}

// —— 页面内采集脚本（不依赖混淆类名，按文本特征定位） ——

// Runs in the page as well as in fixture replays. Build messages bottom-up.
// A parent containing multiple events is a container, never a sender or a body.
export function collectChatRows(root, grants=[]) {
  if(!root)return [];
  const clean = s => String(s || '').replace(/\s+/g,' ').trim();
  const cue = /[：:]|来了|送出|送了|送给主播|关注了主播|推荐了直播/;
  function classify(line) {
    if (line.length>540) return null;
    const m=line.match(/^([^：:]{1,24})\s*[：:]\s*(.+)$/);
    if(m && !/\S\s+来了\s+\S/.test(m[1])) {
      const name=m[1].trim(), body=m[2].trim();
      if (name && body) return {line:name+'：'+body,body};
    }
    if(!/[：:]/.test(line) && (/^.{1,24}?\s*来了$/.test(line)
      || /^.{1,24}?(?:送出|送了|送给主播|关注了主播|推荐了直播).*/.test(line))) return {line};
    return null;
  }
  function visit(el) {
    const parts=[];
    let hasCue=false;
    if(el.hidden || /^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(el.tagName))return {hasCue,parts};
    for (const ch of el.childNodes) {
      if (ch.nodeType===3) { if(cue.test(ch.nodeValue)) hasCue=true; }
      else if (ch.nodeType===1) {
        const sub=visit(ch);
        if(sub.hasCue)hasCue=true;
        parts.push(...sub.parts);
      }
    }
    if (!hasCue || parts.length>1) return {hasCue,parts};
    const line=clean(el.innerText);
    const current=cue.test(line) && classify(line);
    let row=parts[0];
    if(current && current.line!==row?.line && (!row || current.body===row.line ||
        (current.body && row.body && line.startsWith(row.line)
          && (el.parentElement===root || el.getAttribute('data-e2e')==='chat-message')))) row=current;
    // Prefer a real message ID when exposed, but never use the ID of a shared list.
    if(row && current?.line===row.line && el!==root) {
      const id=el.getAttribute('data-message-id') || el.getAttribute('data-msg-id');
      if(id) row.id=id;
      // Do not inspect any images while discovering comments.
      if(grants.length && (id || el.parentElement===root || el.getAttribute('data-e2e')==='chat-message')) row.element=el;
    }
    return {hasCue,parts:row?[row]:[]};
  }
  const parts=visit(root).parts, allowed=new Map(grants.map(g=>[g.key,g]));
  const keyOf=r=>r.id?'id:'+r.id:'text:'+r.line;
  const counts=new Map();
  for(const r of parts){const k=keyOf(r);counts.set(k,(counts.get(k)||0)+1);}
  return parts.map(r=>{
    const key=keyOf(r), row={line:r.line,key}, g=allowed.get(key);
    if(counts.get(key)>1){row.ambiguous=true;return row;}
    if(!g || g.line!==r.line || !r.element)return row;
    // A text-only Douyin row can still have its own structured chat message.
    // Inspect only this admitted row's bound props, never a list, siblings or a profile.
    const rowName=r.line.slice(0,r.line.indexOf('：')), rowBody=r.line.slice(r.line.indexOf('：')+1);
    function boundMessage(props){
      const queue=[props], visited=new Set();
      for(let i=0;i<Math.min(queue.length,24);i++){
        const m=queue[i];
        if(!m || typeof m!=='object' || Array.isArray(m) || visited.has(m))continue;
        visited.add(m);
        const user=m.user||m.User, body=m.content??m.Content;
        if(user && typeof body==='string' && clean(body)===rowBody){
          const rawId=m.msg_id_str??m.msgIdStr??m.common?.msgId??m.common?.msg_id??m.msgId??m.msg_id;
          const id=(typeof rawId==='string' || Number.isSafeInteger(rawId)) && /^[1-9]\d*$/.test(String(rawId))?String(rawId):'';
          if((!r.id || !id || r.id===id) && (clean(user.nickname||user.nickName||user.NickName)===rowName || (id && id===r.id))){
            if(id)row.wireId=id;
            for(const img of [user.avatarThumb,user.avatar_thumb,user.AvatarThumb,user.avatarMedium,user.avatar_medium,user.avatarLarge,user.avatar_large]){
              const list=img?.urlList??img?.url_list??img?.urlListList;
              if(!Array.isArray(list))continue;
              for(const raw of list.slice(0,4)){try{
                const u=new URL(raw);
                if(u.protocol==='https:' && !u.username && !u.password && /(?:^|\.)(?:douyinpic\.com|byteimg\.com|douyinstatic\.com)$/.test(u.hostname)){row.avatar=u.href;return;}
              }catch{}}
            }
          }
        }
        for(const k of ['message','msg','item','data','payload','messageData','chatMessage','messageItem'])if(m[k])queue.push(m[k]);
      }
    }
    try {
      const el=r.element, keys=Object.keys(el);
      boundMessage(el[keys.find(k=>k.startsWith('__reactProps$'))]);
      let fiber=el[keys.find(k=>k.startsWith('__reactFiber$'))];
      for(let i=0;!row.avatar && fiber && i<8;i++,fiber=fiber.return){
        if(i && fiber.stateNode?.nodeType===1)break;
        boundMessage(fiber.memoizedProps);
      }
    } catch {} // Framework data may be stale; do not interrupt the comment poll.
    if(row.avatar)return row;
    // Existing loaded image only. No src assignment, navigation, fetch or scrolling.
    const urls=new Set();
    for(const img of r.element.querySelectorAll('img')){
      if(!img.complete || !img.naturalWidth || !img.getClientRects().length)continue;
      try {
        const u=new URL(img.currentSrc);
        if(u.protocol==='https:' && /(?:^|\.)(?:douyinpic\.com|byteimg\.com|douyinstatic\.com)$/.test(u.hostname)
          && /aweme-avatar|tos-cn-avt|sc=avatar/i.test(u.href))urls.add(u.href);
      } catch {}
    }
    if(urls.size===1)row.avatar=[...urls][0];
    return row;
  });
}

export function collectExpression(room,grants) {
  return String.raw`(() => {
  if(location.hostname!=='live.douyin.com'||location.pathname.split('/')[1]!==${JSON.stringify(room)})return null;
  const out={};
  const single = t => /^[^：:]{1,24}[：:]\s*\S/.test(t) || /^.{1,24}(送出|送了)\s*[^：:]{1,20}(\s*[xX×]\s*\d{1,3})?$/.test(t) || /^.{1,20}来了$/.test(t);
  const tick = (window.__scanTick = (window.__scanTick || 0) + 1);
  if (tick % 4 === 1 || !window.__chatRoot || !window.__chatRoot.isConnected) {
    let best = null, bestN = 0;
    for (const c of document.querySelectorAll('div')) {
      let n = 0;
      for (const k of c.children) { const t = (k.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 540 && single(t)) n++; }
      if (n > bestN) { bestN = n; best = c; }
    }
    window.__chatRoot = best;
  }
  const chatRoot = window.__chatRoot;
  out.rows = (${collectChatRows.toString()})(chatRoot || document.body, ${JSON.stringify(grants)});
  return out;
})()`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('浏览器接口 HTTP ' + res.statusCode));
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('浏览器接口请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function listPages(port) {
  const list = await getJson('http://127.0.0.1:' + port + '/json/list');
  return (Array.isArray(list) ? list : []).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

export function roomFromPage(url) {
  try {
    const page = new URL(url);
    return page.protocol === 'https:' && page.hostname === 'live.douyin.com'
      ? page.pathname.match(/^\/(\d+)\/?$/)?.[1] || '' : '';
  } catch { return '' }
}

export async function openTab(port, url, request = getJson) {
  try {
    // Chromium takes the URL itself as the first query component, not url=….
    // Use the returned target ID even if navigation has not committed yet.
    const page = await request('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), 'PUT');
    return page?.type === 'page' && page.id && page.webSocketDebuggerUrl ? page : null;
  } catch { return null }
}

export async function ensureRoomNavigation(target, room, rpc) {
  if (roomFromPage(target.url) === room) return false;
  const result = await rpc('Page.navigate', { url: 'https://live.douyin.com/' + room });
  if (result?.errorText) throw new Error('直播间页面打开失败：' + result.errorText);
  return true;
}

async function findTarget(room) {
  const roomUrl = 'https://live.douyin.com/' + room;
  for (const port of (process.env.PRINTER_CDP_PORT ? [Number(process.env.PRINTER_CDP_PORT)] : [9223, 9110, 9222])) {
    let pages;
    try { pages = await listPages(port) } catch { continue }
    let hit = pages.find(t => roomFromPage(t.url) === room);
    if (!hit && process.env.PRINTER_CDP_PORT) continue;
    if (!hit) {
      console.log('[' + stamp() + '] 在 :' + port + ' 没找到房间标签页，新开一个（不动你已开的页面）…');
      hit = await openTab(port, roomUrl);
      if (!hit) continue;
    }
    return { port, target: hit };
  }
  return null;
}

async function launchStandaloneChrome(room) {
  const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('没有可用的 CDP 浏览器，也未找到 Chrome/Edge 可执行文件');
  const dir = path.join(BRIDGE_DATA_DIR, '.bridge-profile');
  fs.mkdirSync(dir, { recursive: true });
  console.log('[' + stamp() + '] 弹出直播间窗口(:9223)…用于显示直播间');
  spawn(exe, [
    '--remote-debugging-port=9223', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    '--window-position=120,90', '--window-size=1180,800',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
    'https://live.douyin.com/' + room
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try { await getJson('http://127.0.0.1:9223/json/version'); return } catch { }
  }
  throw new Error('自建浏览器启动超时');
}

export function attachCDP(target,tap) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let mid = 0;
    const pend = new Map();
    const rpc = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++mid;
      pend.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
    ws.onopen = async () => {
      try {
        await rpc('Runtime.enable');
        if(tap)await tap.enable(rpc).catch(()=>{}); // DOM comments also work without network events.
        resolve({ ws, rpc });
      } catch (e) { reject(e) }
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result);
        return;
      }
      if(m.method)tap?.event(m,rpc);
    };
    ws.addEventListener('close',()=>{
      const err=new Error('CDP closed');
      for(const {rej} of pend.values())rej(err);
      pend.clear();reject(err);
    });
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
}

let currentRoom = '';
let hubRef=null,cdpRef=null,historySkipped=false;
let seen=new Set();
let captureRoom='',capturePhase='';
function reportCapture(phase) {
  if (captureRoom===currentRoom && capturePhase===phase) return;
  captureRoom=currentRoom;capturePhase=phase;
  if(process.connected)process.send({type:'capture-status',room:currentRoom,phase},()=>{});
}
// Only a parent-process admission can consume a recently emitted comment ticket.
export function avatarAdmissions() {
  const tickets=new Map(), accepted=new Map();
  return {
    issued(room,row,eventId) {
      tickets.set(eventId,{room,line:row.line,key:row.key,ambiguous:!!row.ambiguous,eventId,at:Date.now()});
      if(tickets.size>600)tickets.delete(tickets.keys().next().value);
    },
    accept(msg,room) {
      const t=tickets.get(msg?.eventId);
      if(!t || msg.type!=='queued-avatar' || msg.room!==room || t.room!==room || !Number.isSafeInteger(msg.id) || msg.id<=0)return;
      tickets.delete(msg.eventId);
      if(Date.now()-t.at<5000)accepted.set(t.eventId,{...t,id:msg.id});
    },
    take(room) {
      const batch=[...accepted.values()].filter(t=>t.room===room && Date.now()-t.at<5000);
      accepted.clear();return batch;
    },
    reset(){tickets.clear();accepted.clear();}
  };
}
const admissions=avatarAdmissions();
function resetRoomState(){seen=new Set();historySkipped=false;admissions.reset();cdpRef?.avatars.reset();}

async function run(hub) {
  hubRef = hub;
  reportCapture('opening');
  const room = currentRoom;
  let found = await findTarget(room);
  if (!found) {
    if (process.env.PRINTER_CDP_PORT) throw new Error('独立直播窗口未就绪，请完成登录后重新开始抓取');
    await launchStandaloneChrome(room);
    found = await findTarget(room);
  }
  if (!found) throw new Error('无法获得直播间页面（尝试过 :9110 :9222 :9223）');
  const { port, target } = found;
  console.log('[' + stamp() + '] 已挂接浏览器 :%d → %s', port, target.url);
  const avatars=new RoomChatAvatars();
  const tap=process.connected?roomWireTap(roomFromPage(target.url),()=>currentRoom,avatars,()=>admissions.reset()):null;
  const { ws, rpc } = await attachCDP(target,tap);
  try { await ensureRoomNavigation(target,currentRoom,rpc); }
  catch (error) { try { ws.close(); } catch {} throw error; }
  cdpRef = { ws, rpc, avatars };
  reportCapture('waiting-chat');
  console.log('['+stamp()+'] 已挂接直播间页面，等待评论区就绪。');
  let active=true,polling=false;
  const reconnect=()=>setTimeout(()=>run(hub).catch(e=>{console.error(e.message);reconnect();}),3000);
  const fail=err=>{
    if(!active)return;
    active=false;clearInterval(timer);clearInterval(watch);cdpRef=null;admissions.reset();avatars.reset();reportCapture('opening');
    console.log('['+stamp()+'] 评论桥连接断开：'+err.message);
    try{ws.close();}catch{}
    reconnect();
  };
  const timer=setInterval(async()=>{
    if(!active||polling||ws.readyState!==1)return;
    polling=true;
    const targetRoom=currentRoom, generation=tap?.generation;
    const grants=avatars.request(admissions.take(targetRoom));
    try{
      const r=await rpc('Runtime.evaluate',{expression:collectExpression(targetRoom,grants.map(({key,line})=>({key,line}))),returnByValue:true});
      const rows=r?.result?.value?.rows;
      if(!active||targetRoom!==currentRoom||generation!==tap?.generation)return;
      if(!Array.isArray(rows)){reportCapture('waiting-chat');return;}
      for(const result of avatars.resolve(grants,rows)){
        if(process.connected)process.send(result,()=>{});
      }
      if(!historySkipped && rows.length){
        historySkipped=true;diffNew(rows,seen,Infinity);
        reportCapture('listening');
        console.log('['+stamp()+'] 已读到直播数据，跳过挂接前已有消息');return;
      }
      if(historySkipped && rows.length)reportCapture('listening');
      for(const row of diffNew(rows,seen)){
        const ev=parseChatLine(row.line);
        if(!ev||ev.kind==='system')continue;
        if(ev.kind==='comment'){
          const eventId=randomUUID();admissions.issued(targetRoom,row,eventId);
          hub.broadcast({type:'comment',eventId,room:targetRoom,name:ev.name,text:ev.text});
        } else if(ev.kind==='gift')hub.broadcast({type:'gift',room:targetRoom,name:ev.name,raw:ev.gift,gift:mapGift(ev.gift),count:ev.count});
        else hub.broadcast({type:ev.kind,name:ev.name,room:targetRoom});
      }
    }catch(e){fail(e);}finally{polling=false;}
  },300);
  const watch=setInterval(()=>{if(hub.clientCount())hub.broadcast({type:'ping',room:currentRoom,ts:Date.now()});},2000);
  watch.unref?.();
  ws.onerror=()=>{};
  ws.onclose=()=>fail(new Error('CDP closed'));
}

// 切换房间（set-room 消息与 .bridge-room 文件变更共用）：重置状态、广播、导航新房间。
function applyRoom(room, persist) {
  if (room === currentRoom) {
    hubRef?.broadcast({ type: 'hello', room, people: [] });
    return;
  }
  currentRoom = room;
  if (persist) { try { fs.writeFileSync(ROOM_FILE, room) } catch { } }
  console.log('[' + stamp() + '] 📺 切换直播间 → ' + room);
  resetRoomState();
  reportCapture('opening');
  hubRef?.broadcast({ type: 'hello', room, people: [] });
  if (cdpRef) cdpRef.rpc('Page.navigate', { url: 'https://live.douyin.com/' + room }).catch(() => { });
}

async function main() {
  const argRoom = (process.argv[2] || '').replace(/\D/g, '');
  let fileRoom = '';
  try { fileRoom = ((fs.readFileSync(ROOM_FILE, 'utf8').match(/(\d{5,25})/)) || [])[1] || '' } catch { }
  currentRoom = argRoom || fileRoom || currentRoom;
  if (!currentRoom) { console.error('请提供直播间号：node douyin-bridge.mjs 房间号（也可写入 .bridge-room 文件，或在打印程序里切换房间）'); process.exit(1); }
  process.on('message',msg=>admissions.accept(msg,currentRoom));
  if(process.connected) process.once('disconnect',()=>process.exit(0));
  // 自动跟随 .bridge-room：应用重开别的直播窗口或手改文件，无需重启数据桥。
  setInterval(() => {
    let fileRoom = '';
    try { fileRoom = ((fs.readFileSync(ROOM_FILE, 'utf8').match(/(\d{5,25})/)) || [])[1] || '' } catch { }
    if (fileRoom && fileRoom !== currentRoom) applyRoom(fileRoom, false);
  }, 2000).unref?.();
  const wsPort = Number(process.argv[3]) || 8765;
  const hub = startWSServer(wsPort, {
    identity: __dirname, fallbackPorts: process.argv[3] ? 0 : 9,
    onStatus: p => console.log('[' + stamp() + '] ✅ 数据桥服务 ws://127.0.0.1:' + p + '（等待打印页面接入）'),
    onError: err => {
      console.error('[' + stamp() + '] ❌ 端口 ' + wsPort + ' 启动失败（' + err.code + '），可能有另一个数据桥在运行，本实例退出');
      process.exit(1);
    },
    onMessage: raw => {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type !== 'set-room') return;
      const id = String(m.room || '').match(/(\d{5,25})/);
      if (!id) return;
      applyRoom(id[1], true);
    }
  });
  console.log('房间号 ' + currentRoom + '。正在弹出直播间窗口（可在里面登录抖音）；来源优先级：自建窗口(:9223) → BrowserOS(:9110) → 调试Chromium(:9222)');
  try { await run(hub) } catch (e) {
    console.error('[' + stamp() + '] ❌ ' + e.message);
    console.error('提示：先打开 BrowserOS neo（会自动用 :9110），或重试本命令。');
    // 启动失败必须退进程，否则 WS 服务把事件循环吊住，变成占着 8765 端口的僵尸。
    process.exit(1);
  }
  process.on('SIGINT', () => process.exit());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
