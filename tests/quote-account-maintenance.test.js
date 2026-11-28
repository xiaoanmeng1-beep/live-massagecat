'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAccountMaintenance } = require('../quote-account-maintenance');

function fixture(check, start = 0) {
  const a = { id: 'a', label: 'A', status: 'authenticated', requests: start };
  const b = { id: 'b', label: 'B', status: 'authenticated', requests: 9 };
  const trace = [];
  let active = a.id, queue = Promise.resolve();
  const serialize = task => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const schedule = createAccountMaintenance({
    getAccount: id => [a,b].find(account => account.id === id),
    getActiveId: () => active,
    findBackup: () => { trace.push('probe'); return check(b); },
    serialize,
    activate: (id, reset) => { active = id; if (reset) b.requests = 0; trace.push('switch'); },
    log: () => {},
    now: () => 100
  });
  const quote = (kind = 'online') => serialize(() => {
    const account = active === a.id ? a : b;
    if (kind === 'cache') return active;
    account.requests++;
    if (kind === 'limited') { account.status = 'cooldown'; account.cooldownUntil = 200; }
    if (kind === 'expired') account.status = 'expired';
    schedule(account.id);
    return active;
  });
  return { a, b, trace, quote, schedule, serialize };
}

test('15 次只预查；第 20 次完成后，即使预查仍在跑，下一笔也排在切换后', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(b => waiting.then(() => b));
  for (let i = 1; i <= 20; i++) {
    assert.equal(await f.quote(), 'a');
    if (i === 15) {
      assert.equal(await f.quote('cache'), 'a');
      assert.equal(f.a.requests, 15);
      assert.deepEqual(f.trace, ['probe']);
    }
  }
  const next = f.quote();
  finish();
  assert.equal(await next, 'b');
  assert.deepEqual(f.trace, ['probe', 'switch']);
  assert.equal(f.a.requests, 20);
  assert.equal(f.b.requests, 1);
});

test('无已验证备用号不切；达到阈值且触发限频或登录失效也不切', async () => {
  for (const kind of ['limited', 'expired']) {
    const f = fixture(b => b, 19);
    assert.equal(await f.quote(kind), 'a');
    await f.serialize(()=>{});
    assert.deepEqual(f.trace, []);
  }
  for (const check of [() => null, b => { b.cooldownUntil = 200; return b; }]) {
    const f = fixture(check, 19);
    assert.equal(await f.quote(), 'a');
    assert.equal(await f.quote(), 'a');
    await f.serialize(()=>{});
    assert.ok(!f.trace.includes('switch'));
  }
});
