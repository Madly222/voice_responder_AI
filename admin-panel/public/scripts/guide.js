// -------- GUIDE: first-run checklist + guide.md text --------
const gEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function openTab(tab) {
  const b = document.querySelector('.tabs button[data-tab="' + tab + '"]');
  if (b) { b.click(); window.scrollTo(0, 0); }
}

async function loadGuide() {
  loadGuideChecklist();
  try {
    const d = await api('/api/guide');
    $('#guideText').innerHTML = renderMarkdown(d.markdown);
    buildGuideToc();
  } catch (e) { $('#guideText').innerHTML = '<span class="bad-txt">' + gEsc(e.message) + '</span>'; }
}

async function loadGuideChecklist() {
  const box = $('#guideCheck');
  box.innerHTML = '<div class="grp">Первый запуск</div>Проверяю, что уже настроено…';
  let d;
  try { d = await api('/api/guide/status'); }
  catch (e) { box.innerHTML = '<div class="grp">Первый запуск</div><span class="bad-txt">' + gEsc(e.message) + '</span>'; return; }
  box.innerHTML = '<div class="grp">Первый запуск</div>'
    + '<div class="bar"><span class="' + (d.need ? 'bad-txt' : 'ok-txt') + '">'
    + (d.need ? 'Осталось настроить: ' + d.need : '✓ Всё настроено') + '</span>'
    + '<button class="ghost" id="guideRecheck">Проверить ещё раз</button></div>'
    + d.items.map((i) => '<div class="g-item">'
      + '<span class="dot ' + (i.ok === null ? 'na' : i.ok ? 'ok' : 'bad') + '"></span>'
      + '<span class="g-title">' + gEsc(i.title) + '</span>'
      + '<span class="g-detail ' + (i.ok === false ? 'bad-txt' : 'hint') + '">' + gEsc(i.detail || '')
      + (i.ok === false && i.hint ? '<br><small class="hint">' + gEsc(i.hint) + '</small>' : '') + '</span>'
      + (i.tab ? '<button class="ghost g-open" data-open="' + i.tab + '">Открыть</button>' : '')
      + '</div>').join('');
  $('#guideRecheck').onclick = loadGuideChecklist;
  box.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openTab(b.dataset.open));
}

// Table of contents from level 1 and 2 headings.
function buildGuideToc() {
  const hs = [...document.querySelectorAll('#guideText h1, #guideText h2')];
  hs.forEach((h, i) => { h.id = 'g-sec-' + i; });
  $('#guideToc').innerHTML = hs.map((h) => '<a href="#' + h.id + '" class="' + (h.tagName === 'H2' ? 'sub' : '') + '">'
    + gEsc(h.textContent) + '</a>').join('');
}

// Minimal Markdown parser: headings, paragraphs, lists, tables, code blocks, **bold**, `code`, links.
function renderMarkdown(md) {
  const inline = (s) => gEsc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push('<pre class="g-pre">' + gEsc(buf.join('\n')) + '</pre>');
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, ...rest] = rows.filter((r) => !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(r));   // without the |---|---| row
      out.push('<table class="g-table"><thead><tr>' + cells(head).map((c) => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>' + rest.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    if (/^\s*(-|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && (/^\s*(-|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i])); i++) {
        if (/^\s*(-|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*(-|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
      }
      out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\||\s*(-|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
    out.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  return out.join('\n');
}
