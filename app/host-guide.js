'use strict';
(() => {
  const guide = document.getElementById('hostGuide');
  const input = document.getElementById('hostGuideInput');
  const lead = guide.querySelector('.host-guide-lead');
  const detail = guide.querySelector('.host-guide-detail');
  const radios = [...document.querySelectorAll('input[name="hostGuideSkin"]')];
  const status = document.getElementById('hostGuideStatus');
  const key = 'board-host-guide-v1';
  // Keep the platform overlay and the operator's separate Quill document untouched.
  let text = [lead.textContent, detail.textContent].join('\n');
  let skin = guide.dataset.skin;
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    if (typeof stored?.text === 'string') text = stored.text.slice(0,input.maxLength);
    if (radios.some(r => r.value === stored?.skin)) skin = stored.skin;
  } catch { /* Missing or unreadable settings use the original markup. */ }
  input.value = text;
  for (const r of radios) r.checked = r.value === skin;
  function render() {
    const [first, ...rest] = input.value.trim().split('\n');
    lead.textContent = first;
    detail.textContent = rest.join('\n');
    detail.hidden = !rest.length;
    guide.hidden = !first;
    guide.dataset.skin = skin;
  }
  function save() {
    try {
      localStorage.setItem(key,JSON.stringify({text:input.value,skin}));
      status.hidden = true;
    } catch {
      status.textContent = '左侧已更新，本次设置未保存到本机。';
      status.hidden = false;
    }
  }
  input.addEventListener('input', event => {render();if (!event.isComposing) save();});
  input.addEventListener('compositionend', () => {render();save();});
  for (const r of radios) r.addEventListener('change', () => {
    if (!r.checked) return;
    skin = r.value;render();save();
  });
  render();
})();
