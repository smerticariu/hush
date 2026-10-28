// Picker: choose an element on the page and hide it on this site for good.
// Injected on demand from the popup or the context menu.

(() => {
  if (globalThis.__hushPicker) { globalThis.__hushPicker.focus(); return; }

  const host = document.createElement('hush-picker');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #f97316;
        background: rgba(249, 115, 22, .18); border-radius: 3px; transition: all .05s; display: none; }
      .layer { position: fixed; inset: 0; z-index: 2147483645; cursor: crosshair; }
      .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 360px; max-width: calc(100vw - 32px);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827;
        background: #fff; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.25); padding: 14px; }
      .panel h1 { font-size: 14px; margin: 0 0 6px; }
      .panel p { margin: 0 0 10px; color: #4b5563; }
      textarea { width: 100%; box-sizing: border-box; height: 64px; font: 12px ui-monospace, Menlo, monospace;
        border: 1px solid #d1d5db; border-radius: 8px; padding: 6px; resize: vertical; }
      .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
      .row label { flex: 1; color: #4b5563; }
      input[type=range] { width: 100%; }
      button { font: inherit; border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
      .primary { background: #f97316; color: #fff; font-weight: 600; }
      .primary:disabled { opacity: .5; cursor: default; }
      .ghost { background: #f3f4f6; color: #111827; }
      .count { color: #6b7280; font-size: 12px; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #1f2937; color: #f9fafb; }
        .panel p, .row label, .count { color: #9ca3af; }
        textarea { background: #111827; color: #f9fafb; border-color: #374151; }
        .ghost { background: #374151; color: #f9fafb; }
      }
    </style>
    <div class="layer"></div>
    <div class="box"></div>
    <div class="panel">
      <h1>Hide an element</h1>
      <p class="hint">Click the thing you want gone. Press Esc to cancel.</p>
      <textarea spellcheck="false" placeholder="CSS selector"></textarea>
      <div class="row"><label>More precise ↔ wider</label><span class="count"></span></div>
      <input type="range" min="0" max="0" value="0">
      <div class="row" style="justify-content:flex-end">
        <button class="ghost cancel">Cancel</button>
        <button class="primary ok" disabled>Hide it</button>
      </div>
    </div>`;
  const $ = (s) => shadow.querySelector(s);
  const layer = $('.layer'), box = $('.box'), text = $('textarea'), range = $('input'), ok = $('.ok'), count = $('.count'), hint = $('.hint');

  let picked = null;      // the chosen element
  let chain = [];         // its ancestors, from it upwards
  let preview = [];

  function elementAt(x, y) {
    layer.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    layer.style.pointerEvents = '';
    return el && el !== host ? el : null;
  }

  function highlight(el) {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  const goodClass = (c) => /^[a-z_-][\w-]{1,40}$/i.test(c) && !/\d{4,}|^(css|sc|jsx|svelte)-[a-z0-9]{5,}$/i.test(c);

  function selectorFor(el) {
    if (el.id && /^[a-z][\w-]*$/i.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      let part = cur.localName;
      if (cur.id && /^[a-z][\w-]*$/i.test(cur.id)) { parts.unshift(`${part}#${CSS.escape(cur.id)}`); break; }
      const classes = [...cur.classList].filter(goodClass).slice(0, 3);
      if (classes.length) part += classes.map((c) => '.' + CSS.escape(c)).join('');
      else if (cur.parentElement) {
        const same = [...cur.parentElement.children].filter((c) => c.localName === cur.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { }
      if (parts.length >= 5) return sel;
    }
    return parts.join(' > ');
  }

  function setPreview(sel) {
    for (const el of preview) el.style.removeProperty('outline');
    preview = [];
    let n = 0;
    try {
      preview = [...document.querySelectorAll(sel)].filter((e) => !host.contains(e));
      n = preview.length;
    } catch { n = -1; }
    for (const el of preview) el.style.setProperty('outline', '2px dashed #f97316', 'important');
    count.textContent = n < 0 ? 'invalid selector' : n === 1 ? '1 element' : `${n} elements`;
    ok.disabled = n <= 0;
  }

  function choose(el) {
    picked = el;
    chain = [];
    for (let cur = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) chain.push(cur);
    range.max = String(Math.max(0, chain.length - 1));
    range.value = '0';
    hint.textContent = 'Drag the slider to hide a bigger block around it.';
    update();
  }

  function update() {
    const el = chain[+range.value] || picked;
    highlight(el);
    text.value = selectorFor(el);
    setPreview(text.value);
  }

  function close() {
    setPreview('');
    for (const el of preview) el.style.removeProperty('outline');
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    delete globalThis.__hushPicker;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }

  layer.addEventListener('mousemove', (e) => { if (!picked) highlight(elementAt(e.clientX, e.clientY)); });
  layer.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = elementAt(e.clientX, e.clientY);
    if (el) { choose(el); layer.style.cursor = 'default'; }
  });
  range.addEventListener('input', update);
  text.addEventListener('input', () => setPreview(text.value.trim()));
  $('.cancel').addEventListener('click', close);
  ok.addEventListener('click', async () => {
    const selector = text.value.trim();
    if (!selector) return;
    ok.disabled = true;
    await chrome.runtime.sendMessage({ type: 'picker:add', selector });
    close();
  });
  document.addEventListener('keydown', onKey, true);

  (document.body || document.documentElement).appendChild(host);
  globalThis.__hushPicker = { focus: () => text.focus() };
})();
