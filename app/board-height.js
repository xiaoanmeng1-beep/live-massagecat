'use strict';
(() => {
  const pane = document.getElementById('boardViewport');
  const column = pane.closest('.valuation-column');
  const content = document.getElementById('boardContent');
  const grip = document.getElementById('boardHeightDivider');
  const key = 'live-board-height';
  let preferred = null, drag = null;
  let frame = 0, zoom = 1, lastFit = null;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch {}

  function limits() {
    // Use the column's available height, not the board's moving screen position.
    const style = getComputedStyle(column);
    const max = Math.max(1, Math.floor(column.clientHeight - parseFloat(style.paddingTop)
      - parseFloat(style.paddingBottom) - grip.offsetHeight));
    return { min: Math.min(180, max), max };
  }
  function syncLabel() {
    const height = Math.round(pane.getBoundingClientRect().height);
    grip.setAttribute('aria-valuenow', String(height));
    grip.setAttribute('aria-valuetext', (preferred === null ? '自动高度，' : '') + height + ' 像素');
  }
  function applyZoom(value) {
    if (zoom !== value) {
      zoom = value;
      content.style.setProperty('--board-zoom', String(value));
    }
  }
  function fit() {
    frame = 0;
    const max = limits().max;
    const target = preferred === null ? max : pane.clientHeight;
    const width = pane.clientWidth;
    if (!width || !target) return;
    const cap = preferred === null ? 1 : 1.65;
    const measure = () => content.getBoundingClientRect().height;
    const fits = h => h <= target && content.scrollWidth <= content.clientWidth + 1;
    const initial = measure();
    if (lastFit && lastFit.target === target && lastFit.width === width &&
        lastFit.cap === cap && lastFit.height === initial && fits(initial)) return;
    // Word wrapping makes the required height nonlinear. Measure actual layout,
    // including multi-line model names, rather than stretching the bitmap.
    applyZoom(cap);
    if (!fits(measure())) {
      let lo = 0.05, hi = cap;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        applyZoom(mid);
        if (fits(measure())) lo = mid; else hi = mid;
      }
      applyZoom(lo);
    }
    lastFit = {target, width, cap, height:measure()};
    syncLabel();
  }
  function scheduleFit() {
    if (!frame) frame = requestAnimationFrame(fit);
  }
  // A different title can wrap onto another line. Resolve the new zoom before
  // the renderer measures the destination; a deferred fit would move its edges mid-flight.
  content.addEventListener('board-before-handoff',()=>{cancelAnimationFrame(frame);fit();});
  function layout() {
    const {min, max} = limits();
    pane.style.setProperty('--board-max-height', max + 'px');
    pane.toggleAttribute('data-sized', preferred !== null);
    if (preferred === null) pane.style.removeProperty('--board-height');
    else pane.style.setProperty('--board-height', Math.max(min, Math.min(max, preferred)) + 'px');
    grip.setAttribute('aria-valuemin', String(Math.min(min, Math.round(pane.getBoundingClientRect().height))));
    grip.setAttribute('aria-valuemax', String(max));
    syncLabel();
    scheduleFit();
  }
  function save() {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch {}
  }
  function setHeight(value) {
    const {min, max} = limits();
    preferred = Math.round(Math.max(min, Math.min(max, value)));
    layout();
  }
  function reset() { preferred = null; pane.scrollTop = 0; layout(); save(); }
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    grip.focus({preventScroll:true});
    drag = {id:event.pointerId, y:event.clientY, height:pane.getBoundingClientRect().height, moved:false};
    grip.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-board-height');
  });
  grip.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const delta = event.clientY - drag.y;
    if (!drag.moved && Math.abs(delta) < 2) return;
    drag.moved = true;
    setHeight(drag.height + delta);
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) save();
    drag = null;
    document.body.classList.remove('resizing-board-height');
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  }
  for (const name of ['pointerup','pointercancel','lostpointercapture']) grip.addEventListener(name,finish);
  grip.addEventListener('dblclick',reset);
  grip.addEventListener('keydown', event => {
    const {min,max} = limits(), h = pane.getBoundingClientRect().height;
    if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
    const target = {ArrowUp:h-20, ArrowDown:h+20, Home:min, End:max}[event.key];
    if (!Number.isFinite(target)) return;
    event.preventDefault();
    setHeight(target); save();
  });
  window.addEventListener('resize',layout);
  new ResizeObserver(() => { syncLabel(); scheduleFit(); }).observe(pane);
  new MutationObserver(scheduleFit).observe(content,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
  document.fonts?.ready.then(scheduleFit);
  layout();
})();
