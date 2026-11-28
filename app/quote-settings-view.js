'use strict';
(() => {
  const input = document.getElementById('quoteIntervalInput');
  const message = document.getElementById('quoteIntervalMessage');
  let timer, revision = 0;
  function valid() { return /^\d+$/.test(input.value) && Number(input.value) >= 1 && Number(input.value) <= 3600; }
  async function save() {
    clearTimeout(timer);
    const run = ++revision;
    if (!valid()) { message.textContent = '请输入 1～3600 的整数秒数'; return; }
    message.textContent = '保存中…';
    try {
      const result = await window.desktop.setQuoteInterval(Number(input.value));
      if (run !== revision) return;
      message.textContent = result?.ok ? '已保存，间隔 ' + result.intervalSeconds + ' 秒' : result?.message || '保存失败，请重新修改';
    } catch (error) { if (run === revision) message.textContent = '保存失败：' + error.message; }
  }
  input.addEventListener('input', () => {
    revision++; clearTimeout(timer);
    if (!valid()) { message.textContent = '请输入 1～3600 的整数秒数'; return; }
    message.textContent = '待保存…';
    timer = setTimeout(save, 300);
  });
  input.addEventListener('change', save);
  window.desktop.getQuoteSettings().then(settings => {
    input.value = String(settings.intervalSeconds);
  }).catch(error => { message.textContent = '读取设置失败：' + error.message; })
    .finally(() => { input.disabled = false; });
})();
