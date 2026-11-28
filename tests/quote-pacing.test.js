'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuoteBoard } = require('../live-board');
const flush = () => new Promise(setImmediate);
const good = { ok:true, prices:{ good:{ low:1, high:2 } } };
const job = id => ({ id, input:{ id } });

function clock() {
  let time = 0;
  const timers = new Set();
  return {
    now:() => time,
    pause:(ms, signal) => new Promise(resolve => {
      const entry = { deadline:time + ms, finish:() => {
        timers.delete(entry); signal.removeEventListener('abort', entry.finish); resolve();
      } };
      timers.add(entry); signal.addEventListener('abort', entry.finish, { once:true });
      if (signal.aborted) entry.finish();
    }),
    advance:async ms => {
      time += ms;
      for (const timer of [...timers]) if (timer.deadline <= time) timer.finish();
      await flush();
    },
    deadlines:() => [...timers].map(timer => timer.deadline)
  };
}

test('缓存成功、连续失败、超时和抛错，均从完成后等 5 秒再处理队首', async () => {
  const c = clock(), trace = [], failures = [];
  const board = new QuoteBoard({ ...c, log:(id, reason) => failures.push([id, reason]), quote:async ({ id }) => {
    trace.push([id, c.now()]);
    if (id === 2) return { ok:false, code:'TIMEOUT' };
    if (id === 3) return { ok:false, code:'REQUEST_FAILED' };
    if (id === 4) throw Error('network');
    return { ...good, cached:true };
  } });
  for (let id = 1; id <= 5; id++) board.add(job(id));
  await flush();
  for (let id = 2; id <= 5; id++) {
    assert.equal(board.pending[0].id, id);
    await c.advance(6999); assert.equal(trace.length, id - 1);
    await c.advance(1); assert.equal(trace.length, id);
  }
  assert.deepEqual(trace, [[1,0],[2,7000],[3,14000],[4,21000],[5,28000]]);
  assert.deepEqual(failures, [[2,'TIMEOUT'],[3,'REQUEST_FAILED'],[4,'network']]);
  assert.deepEqual(board.history.map(item => item.id), [5,1]);
});

test('等待中加长和缩短间隔，基于上次完成时间重算，保持 FIFO 且无遗留定时器', async () => {
  const c = clock(), trace = [];
  const board = new QuoteBoard({ ...c, quote:async ({id}) => { trace.push([id,c.now()]); return good; } });
  [1,2,3].forEach(id => board.add(job(id)));
  await flush(); await c.advance(3000);
  board.setHoldMs(10000); await flush();
  assert.deepEqual(c.deadlines(), [10000]);
  await c.advance(6999); assert.equal(trace.length,1);
  await c.advance(1); assert.deepEqual(trace,[[1,0],[2,10000]]);
  await c.advance(3000);
  board.setHoldMs(2000); await flush();
  assert.deepEqual(trace,[[1,0],[2,10000],[3,13000]]);
  assert.deepEqual(c.deadlines(),[]);
});

test('无排队时保留上次完成时间，新评论遵守剩余等待；正在请求的车不被改设置打断', async () => {
  const c = clock(), trace = [];
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const board = new QuoteBoard({ ...c, quote:async ({id}) => {
    trace.push([id,c.now()]); return id === 1 ? first : good;
  } });
  board.add(job(1)); await flush();
  await c.advance(6000); board.setHoldMs(5000); board.add(job(2)); await flush();
  assert.equal(trace.length,1);
  resolveFirst(good); await flush();
  assert.deepEqual(c.deadlines(),[11000]);
  await c.advance(5000); assert.deepEqual(trace,[[1,0],[2,11000]]);
  await c.advance(1000); board.add(job(3)); await flush();
  await c.advance(3999); assert.equal(trace.length,2);
  await c.advance(1); assert.deepEqual(trace,[[1,0],[2,11000],[3,16000]]);
  await c.advance(6000); board.add(job(4)); await flush();
  assert.deepEqual(trace[3],[4,22000]);
});

test('限频或登录阻断保留全部排队，不循环重试，恢复时仍按间隔', async () => {
  for (const code of ['RATE_LIMITED','AUTH_REQUIRED','NO_ACCOUNT']) {
    const c = clock(), trace = []; let ready = false;
    const board = new QuoteBoard({ ...c, quote:async ({id}) => {
      trace.push([id,c.now()]); return ready ? good : { ok:false, code };
    } });
    board.add(job(1)); board.add(job(2)); await flush();
    await c.advance(7000);
    assert.equal(trace.length,1); assert.equal(board.blocked,code);
    assert.deepEqual(board.pending.map(item => item.id),[1,2]);
    ready = true; board.resume(); await flush();
    assert.deepEqual(trace,[[1,0],[1,7000]]);
    await c.advance(7000); assert.deepEqual(trace[2],[2,14000]);
  }
});

test('真实定时器在调整时被取消而非叠加', async () => {
  const trace = [];
  const board = new QuoteBoard({ holdMs:60000, quote:async ({id}) => { trace.push(id); return good; } });
  board.add(job(1)); board.add(job(2)); await flush();
  assert.equal(board.waitController.signal.aborted,false);
  const old = board.waitController;
  board.setHoldMs(0); await flush();
  assert.equal(old.signal.aborted,true);
  assert.deepEqual(trace,[1,2]);
  assert.equal(board.waitController,null);
});
