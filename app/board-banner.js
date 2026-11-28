'use strict';
(() => {
  const toolbar = document.querySelector('.banner-format-tools');
  const hint = document.querySelector('#bannerCopyHint');
  const storageKey = 'valuation-banner-delta-v2';
  const formats = ['header','font','size','bold','italic','underline','strike','color','background','align','list'];
  const size = Quill.import('attributors/style/size');
  // Presets are shortcuts; pasted or custom whole-pixel sizes work as well.
  size.whitelist = Array.from({length:137}, (_, i) => (i + 8) + 'px');
  Quill.register(size, true);

  // A broadcast document contains formatted text only. Strip external resources before
  // Quill parses rich clipboard data, including HTML from the previous editor.
  const Clipboard = Quill.import('modules/clipboard');
  class TextClipboard extends Clipboard {
    convert(data, active) {
      if (!data.html) return super.convert(data, active);
      const source = document.createElement('template');
      source.innerHTML = data.html;
      const clean = document.createElement('div');
      const tags = new Set('p div br h1 h2 h3 h4 h5 h6 strong b em i u s strike del span font ol ul li'.split(' '));
      const skip = new Set('script style noscript template svg math object embed iframe img video audio'.split(' '));
      function copy(parent, into) {
        for (const n of parent.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) { into.append(n.data); continue; }
          if (n.nodeType !== Node.ELEMENT_NODE || skip.has(n.localName)) continue;
          if (!tags.has(n.localName)) { copy(n, into); continue; }
          const el = document.createElement(n.localName === 'font' ? 'span' : n.localName);
          for (const k of ['fontSize','fontWeight','fontStyle','fontFamily','color','backgroundColor','textAlign','textDecoration'])
            if (n.style[k]) el.style[k] = n.style[k];
          if (n.localName === 'font' && n.hasAttribute('color')) el.style.color = n.getAttribute('color');
          for (const c of n.classList) if (/^ql-(font-(serif|monospace)|align-(right|center|justify))$/.test(c)) el.classList.add(c);
          if (n.localName === 'li' && ['bullet','ordered'].includes(n.dataset.list)) el.dataset.list = n.dataset.list;
          into.append(el);
          copy(n, el);
        }
      }
      copy(source.content, clean);
      return super.convert({...data, html:clean.innerHTML}, active);
    }
  }
  Quill.register('modules/clipboard', TextClipboard, true);
  const editor = new Quill('#bannerRichInput', {
    theme:'snow', formats, placeholder:'在这里输入直播文案',
    modules:{toolbar, history:{delay:400, userOnly:true}, uploader:{handler() {}}}
  });
  editor.root.setAttribute('role','textbox');
  editor.root.setAttribute('aria-label','公屏文案');
  editor.root.setAttribute('aria-multiline','true');
  editor.root.setAttribute('aria-describedby','bannerCopyHint');

  // The same document and the same layout engine on both sides. No HTML serializer
  // dropping format attributes, and no replacement of the active editable DOM/selection.
  const display = new Quill('#valuationBanner', {formats, readOnly:true, modules:{toolbar:false,history:{userOnly:true}}});
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(editor.getContents()));
      if (hint.dataset.failed) {hint.textContent = hint.dataset.normal;delete hint.dataset.failed;}
    } catch {
      if (!hint.dataset.failed) hint.dataset.normal = hint.textContent;
      hint.dataset.failed = 'true';
      hint.textContent = '左侧已更新，本次文案未保存到本机。';
    }
  }
  function restore() {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) {
      const doc = JSON.parse(saved);
      if (!Array.isArray(doc?.ops) || !doc.ops.every(op => typeof op?.insert === 'string')) throw Error('invalid document');
      editor.setContents(doc, 'silent');
      return;
    }
    let html = localStorage.getItem('valuation-banner-rich-text-v1');
    if (html === null) {
      const old = JSON.parse(localStorage.getItem('valuation-banner-copy'));
      if (!old) return;
      const box = document.createElement('div');
      for (const [tag, value] of [['h2',old.primary],['p',old.ticker]]) {
        if (typeof value !== 'string' || !value) continue;
        const block = document.createElement(tag);
        block.textContent = value;
        box.append(block);
      }
      html = box.innerHTML;
    }
    editor.setContents(editor.clipboard.convert({html}), 'silent');
    save(); // leave both previous versions untouched
  }
  try {restore();} catch { hint.textContent = '原文案读取失败，旧存档仍保留。'; }
  editor.history.clear();
  display.setContents(editor.getContents(), 'silent');
  editor.on('text-change', delta => {
    display.updateContents(delta, 'silent');
    save();
  });

  // Keep the real selection (and pending caret styles) while operating the toolbar.
  // Do not remove/re-add a DOM Range: Chromium drops pending marks when that happens.
  toolbar.addEventListener('pointerdown', () => {
    if (editor.hasFocus()) editor.getSelection();
    editor.history.cutoff();
  }, true);
  toolbar.addEventListener('mousedown', e => {
    if (e.target.closest('button')) e.preventDefault();
  });
  for (const btn of toolbar.querySelectorAll('[data-history]'))
    btn.addEventListener('click', () => { editor.focus(); editor.history[btn.dataset.history](); });
  const sizePicker = toolbar.querySelector('.ql-picker.ql-size');
  const sizeLabel = sizePicker.querySelector('.ql-picker-label');
  const sizeForm = document.createElement('form');
  sizeForm.className = 'banner-custom-size';
  sizeForm.innerHTML = '<input type="number" min="8" max="144" step="1" required placeholder="字号" aria-label="自定义字号（8 至 144 像素）"><button type="submit" aria-label="应用字号">确定</button>';
  sizePicker.querySelector('.ql-picker-options').append(sizeForm);
  sizeForm.addEventListener('submit', e => {
    e.preventDefault();
    if (!sizeForm.reportValidity()) return;
    editor.focus();
    editor.format('size', sizeForm.elements[0].valueAsNumber+'px', 'user');
    editor.theme.pickers.find(p => p.container === sizePicker).close();
    syncSize();
  });
  function syncSize() {
    const range = editor.getSelection();
    if (!range) return;
    const value = editor.getFormat(range).size;
    sizeLabel.dataset.label = Array.isArray(value) ? '混合字号' : value ? value.replace('px',' px') : '自动字号';
  }
  editor.on('editor-change', syncSize);
  for (const picker of toolbar.querySelectorAll('.ql-picker')) {
    picker.querySelector('.ql-picker-label').setAttribute('aria-label', picker.title);
    if (!picker.classList.contains('ql-color-picker')) continue;
    const format = picker.classList.contains('ql-color') ? 'color' : 'background';
    const label = document.createElement('label');
    label.className = 'custom-ink';
    label.textContent = '自定义';
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label','自定义'+picker.title);
    label.prepend(input);
    picker.querySelector('.ql-picker-options').append(label);
    input.addEventListener('change', () => {
      editor.focus();
      editor.format(format, input.value, 'user');
      editor.theme.pickers.find(p => p.container === picker)?.close();
    });
  }
})();
