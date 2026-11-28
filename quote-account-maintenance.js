'use strict';

const PREFLIGHT_AT = 15;
const ROTATE_AT = 20;
const blockedStates = new Set(['cooldown', 'signed-out', 'expired', 'login-required', 'deleting']);

function createAccountMaintenance({ getAccount, getActiveId, findBackup, serialize, activate, log, now = Date.now }) {
  function eligible(account) {
    return account && !account.deleting && !blockedStates.has(account.status)
      && !(account.cooldownUntil > now());
  }
  return function schedule(id) {
    const account = getAccount(id);
    if (!eligible(account) || getActiveId() !== id) return;
    if (account.requests !== PREFLIGHT_AT && account.requests < ROTATE_AT) return;
    const rotate = account.requests >= ROTATE_AT;
    const pending = rotate ? 'rotationTask' : 'preflightTask';
    if (account[pending]) return account[pending];
    const isActive = () => getActiveId() === id && getAccount(id) === account && eligible(account);
    const ready = backup => backup && backup.id !== id && getAccount(backup.id) === backup
      && eligible(backup) && backup.status === 'authenticated';
    const check = async () => {
      if (!isActive()) return;
      let backup = rotate && account.preflightTask ? await account.preflightTask : null;
      if (!isActive()) return;
      if (!ready(backup)) backup = await findBackup();
      if (!isActive()) return;
      if (!ready(backup)) {
        log('暂无可切换的已验证备用账号', { account: account.label });
        return;
      }
      if (rotate && account.requests >= ROTATE_AT) {
        activate(backup.id, true);
        log('下一次估价使用备用账号', { from: account.label, to: backup.label });
      } else if (!rotate) {
        log('备用账号登录预检查通过', { account: account.label, backup: backup.label });
      }
      return backup;
    };
    // Reserve the next slot immediately. A live board may enqueue another
    // quote as soon as this one returns; it must not beat the account switch.
    const task = rotate ? serialize(check) : Promise.resolve().then(check);
    account[pending] = task.catch(error => log('账号轮换检查失败', { message: error.message }))
      .finally(() => { account[pending] = null; });
    return account[pending];
  };
}

module.exports = { createAccountMaintenance };
