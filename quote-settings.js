'use strict';

const DEFAULT_INTERVAL_SECONDS = 7;
const KEY = 'live.quoteIntervalSeconds';

function validInterval(value) {
  return (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
    && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 3600;
}

function readQuoteInterval(store) {
  const value = store.getSetting(KEY, DEFAULT_INTERVAL_SECONDS);
  return validInterval(value) ? Number(value) : DEFAULT_INTERVAL_SECONDS;
}

function registerQuoteSettingsIpc(ipc, store, board) {
  ipc.handle('live:quote-settings', () => ({ intervalSeconds:board.holdMs / 1000 }));
  ipc.handle('live:set-quote-interval', (_event, value) => {
    if (!validInterval(value)) return { ok:false, message:'请输入 1～3600 的整数秒数' };
    const intervalSeconds = Number(value);
    try {
      store.setSetting(KEY, intervalSeconds);
      board.setHoldMs(intervalSeconds * 1000);
      return { ok:true, intervalSeconds };
    } catch (error) {
      return { ok:false, message:'报价间隔保存失败：' + error.message };
    }
  });
}

module.exports = { readQuoteInterval, registerQuoteSettingsIpc };
