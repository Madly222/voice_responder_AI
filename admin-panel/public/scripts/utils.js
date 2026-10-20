const $ = (s, r=document) => r.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(((await r.json().catch(()=>({}))).error || r.statusText) + ' (HTTP '+r.status+')');
  return r.json();
};
const toast = (m) => { const t=$('#toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); };

const Dialog = {
    overlay: null, title: null, message: null, input: null, footer: null, closeBtn: null, resolvePromise: null,
    init() {
        this.overlay = document.getElementById('customDialogOverlay');
        this.title = document.getElementById('customDialogTitle');
        this.message = document.getElementById('customDialogMessage');
        this.input = document.getElementById('customDialogInput');
        this.footer = document.getElementById('customDialogFooter');
        this.closeBtn = document.getElementById('customDialogCloseBtn');
        this.closeBtn.addEventListener('click', () => this.close(this.input.classList.contains('hidden') ? false : null));
    },
    show(options) {
        if (!this.overlay) this.init();
        this.title.textContent = options.title || 'Уведомление';
        this.message.textContent = options.message || '';
        this.footer.innerHTML = '';
        this.input.value = options.defaultValue || '';

        if (options.type === 'prompt') {
            this.input.classList.remove('hidden');
            setTimeout(() => this.input.focus(), 100);
        } else {
            this.input.classList.add('hidden');
        }

        const btnContainer = document.createElement('div');
        btnContainer.className = 'dialog-buttons';

        if (options.type === 'confirm' || options.type === 'prompt') {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = 'Отмена';
            cancelBtn.onclick = () => this.close(options.type === 'prompt' ? null : false);
            btnContainer.appendChild(cancelBtn);
        }

        const okBtn = document.createElement('button');
        okBtn.className = options.type === 'confirm' && options.danger ? 'btn btn-danger' : 'btn btn-primary';
        okBtn.textContent = options.okText || (options.danger ? 'Удалить' : 'OK');
        okBtn.onclick = () => {
            const result = options.type === 'prompt' ? this.input.value : true;
            this.close(result);
        };
        btnContainer.appendChild(okBtn);

        this.footer.appendChild(btnContainer);
        this.overlay.classList.add('active');

        if (options.type === 'prompt') {
            this.input.onkeydown = (e) => {
                if (e.key === 'Enter') okBtn.click();
            };
        }

        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    },
    close(value) {
        this.overlay.classList.remove('active');
        if (this.resolvePromise) {
            this.resolvePromise(value);
            this.resolvePromise = null;
        }
    },
    async alert(message, title = 'Сообщение') { return this.show({ type: 'alert', message, title }); },
    async confirm(message, title = 'Подтверждение', danger = false, okText = '') { return this.show({ type: 'confirm', message, title, danger, okText }); },
    async prompt(message, defaultValue = '', title = 'Ввод данных') { return this.show({ type: 'prompt', message, defaultValue, title }); }
};

// -------- Custom dropdowns --------
// Chrome on Windows draws the native list with a white background, so every <select> is hidden
// and a custom list is shown instead. The <select> stays the source of the value: code reads .value,
// listens to 'change' and rebuilds options, and the custom list follows.
const SELECT_PROTO = HTMLSelectElement.prototype;
const SEL_VALUE = Object.getOwnPropertyDescriptor(SELECT_PROTO, 'value');
const SEL_INDEX = Object.getOwnPropertyDescriptor(SELECT_PROTO, 'selectedIndex');

function enhanceSelect(sel) {
  if (sel.dataset.csel) return;
  sel.dataset.csel = '1';
  const wrap = document.createElement('div');
  wrap.className = 'csel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  const list = document.createElement('div');
  list.className = 'csel-list';
  list.hidden = true;
  wrap.append(btn, list);
  sel.after(wrap);
  sel.classList.add('csel-native');

  const render = () => {
    const o = sel.options[SEL_INDEX.get.call(sel)];
    btn.textContent = o ? o.textContent : '';
    btn.disabled = sel.disabled;
  };
  const pick = (i) => {
    if (i === SEL_INDEX.get.call(sel)) return;
    SEL_INDEX.set.call(sel, i);
    render();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  function close() {
    list.hidden = true;
    wrap.classList.remove('open');
    document.removeEventListener('mousedown', outside, true);
  }
  function open() {
    list.innerHTML = '';
    [...sel.options].forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'csel-opt' + (o.selected ? ' sel' : '') + (o.disabled ? ' dis' : '');
      d.textContent = o.textContent;
      if (!o.disabled) d.onclick = () => { pick(i); close(); btn.focus(); };
      list.append(d);
    });
    list.hidden = false;
    wrap.classList.add('open');
    const s = list.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
    document.addEventListener('mousedown', outside, true);
  }

  btn.onclick = () => (list.hidden ? open() : close());
  btn.onkeydown = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = sel.options.length;
      let i = SEL_INDEX.get.call(sel);
      do { i += e.key === 'ArrowDown' ? 1 : -1; } while (i >= 0 && i < n && sel.options[i].disabled);
      if (i >= 0 && i < n) { pick(i); if (!list.hidden) open(); }
    }
  };

  // setting the value from code (sel.value = ...) also updates the button
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return SEL_VALUE.get.call(this); },
    set(v) { SEL_VALUE.set.call(this, v); render(); },
  });
  Object.defineProperty(sel, 'selectedIndex', {
    configurable: true,
    get() { return SEL_INDEX.get.call(this); },
    set(v) { SEL_INDEX.set.call(this, v); render(); },
  });
  new MutationObserver(render).observe(sel, { childList: true, subtree: true, attributes: true });
  sel.addEventListener('change', render);
  render();
}

function enhanceSelectsIn(node) {
  if (node.nodeType !== 1) return;
  if (node.tagName === 'SELECT') enhanceSelect(node);
  else node.querySelectorAll('select').forEach(enhanceSelect);
}
document.addEventListener('DOMContentLoaded', () => {
  enhanceSelectsIn(document.body);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(enhanceSelectsIn)))
    .observe(document.body, { childList: true, subtree: true });
});

// -------- Light / dark theme --------
// The current theme is set in <head> (index.html) before first paint; this is the header toggle and remembering the choice.
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = document.getElementById('themeToggle');
  if (b) {
    b.textContent = t === 'light' ? '🌙' : '☀️';
    b.title = t === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему';
  }
}
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  const b = document.getElementById('themeToggle');
  if (b) b.onclick = () => {
    const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(t);
    try { localStorage.setItem('panel-theme', t); } catch (e) {}
  };
});
