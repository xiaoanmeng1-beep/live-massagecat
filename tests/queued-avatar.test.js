'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {QuoteBoard,attemptLiveMatch}=require('../live-board');
const {normalizeBridgeEvent}=require('../douyin-bridge');

const avatar='https://p3.douyinpic.com/aweme-avatar/example.jpg';
function fixture(lines,images){
  const reads=lines.map(()=>0);
  const root={nodeType:1,get innerText(){return lines.join('\n');},getAttribute:()=>null};
  root.childNodes=lines.map((line,i)=>({
    nodeType:1,innerText:line,childNodes:[{nodeType:3,nodeValue:line}],parentElement:root,
    getAttribute:()=>null,querySelectorAll(selector){
      assert.equal(selector,'img');reads[i]++;return images[i]?[{complete:true,naturalWidth:40,currentSrc:images[i],getClientRects:()=>[{}]}]:[];
    }
  }));
  return {root,reads};
}
test('先入队再查看消息行：闲聊、重复事件和普通扫描都不读头像，报价不等待图片',async()=>{
  const {collectChatRows,avatarAdmissions}=await import('../douyin-bridge-service.mjs');
  const {root,reads}=fixture(['小张：路过','小张：19年思域6万公里'],[avatar,avatar]);
  const tickets=avatarAdmissions(),room='123456';
  const rows=collectChatRows(root);
  rows.forEach((r,i)=>tickets.issued(room,r,'e'+i));
  const board=new QuoteBoard({quote:async()=>({ok:true,prices:{good:{low:1,high:2}}}),pause:async()=>{}});
  const parse=e=>e.id===2?{ok:true,job:{...e,input:{}}}:{ok:false,code:'CHAT',reason:'非询价'};
  let grants=0;
  const accept=e=>{grants++;tickets.accept({type:'queued-avatar',...e},room);};
  for(const i of [0,1,1])attemptLiveMatch(parse,board,{id:i+1,eventId:'e'+i,room},accept);
  assert.equal(grants,1);
  assert.deepEqual(reads,[0,0]);
  await new Promise(setImmediate);
  assert.equal(board.history.length,1);
  const batch=tickets.take(room);
  const withAvatar=collectChatRows(root,batch);
  assert.deepEqual(reads,[0,1]);assert.equal(withAvatar[0].avatar,undefined);
  assert.equal(board.setQueuedAvatar({...batch[0],room:'other',avatar}),false);
  assert.equal(board.setQueuedAvatar({...batch[0],avatar:withAvatar[1].avatar}),true);
  assert.equal(board.history[0].avatar,avatar);
  accept({id:2,eventId:'e1',room});
  collectChatRows(root,tickets.take(room));
  assert.deepEqual(reads,[0,1]);
});
test('头像缺失、同名同文、消息行已变和换房不补取',async()=>{
  const {collectChatRows,avatarAdmissions}=await import('../douyin-bridge-service.mjs');
  const {root,reads}=fixture(['甲：原文','乙：其他'],['https://example.com/aweme-avatar/fake.jpg',null]);
  const g=collectChatRows(root)[0];
  assert.equal(collectChatRows(root,[g])[0].avatar,undefined);
  assert.deepEqual(reads,[1,0]);
  const duplicate=fixture([g.line,g.line],[avatar,avatar]);
  collectChatRows(duplicate.root,[g]);assert.deepEqual(duplicate.reads,[0,0]);
  collectChatRows(root,[{key:g.key,line:'更改的文字'}]);assert.deepEqual(reads,[1,0]);
  const a=avatarAdmissions();a.issued('room1',g,'x');
  a.accept({type:'queued-avatar',room:'room2',eventId:'x',id:3},'room2');
  a.reset();a.accept({type:'queued-avatar',room:'room1',eventId:'x',id:3},'room1');
  assert.deepEqual(a.take('room1'),[]);
  assert.doesNotThrow(()=>normalizeBridgeEvent({text:'路过',get avatarUrl(){throw Error('不应提前读取');}}));
});
