// -------- ULTRAVOX: RO / RU agents --------
// Agent editing in Ultravox. "Check" shows what will change; "Apply" saves a copy of the
// agent (history, rollback) and sends the changes. Tools are view-only for now.
const UV = { agents: [], lang: null, voices: null, models: [] };
const END_LABELS = { '': 'только сообщение', END_BEHAVIOR_HANG_UP_SOFT: 'сообщение и положить трубку (можно перебить)',
  END_BEHAVIOR_HANG_UP_STRICT: 'сообщение и положить трубку (нельзя перебить)' };
const uvEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function loadUltravox() {
  $('#uvbody').innerHTML = 'Загрузка агентов из Ultravox…';
  try {
    const d = await api('/api/ultravox/agents');
    UV.agents = d.agents; UV.models = d.models || [];
  } catch (e) { $('#uvbody').innerHTML = '<span class="bad-txt">'+uvEsc(e.message)+'</span>'; return; }
  if (!UV.lang || !UV.agents.some(a => a.lang === UV.lang)) UV.lang = UV.agents[0] && UV.agents[0].lang;
  $('#uvlangs').innerHTML = UV.agents.map(a =>
    '<button class="'+(a.lang===UV.lang?'act':'ghost')+'" data-lang="'+a.lang+'">'+uvEsc(a.label)+'</button>').join('');
  $('#uvlangs').querySelectorAll('button').forEach(b => b.onclick = () => { UV.lang = b.dataset.lang; loadUltravox(); });
  renderAgent();
}

function uvCurrent() { return UV.agents.find(a => a.lang === UV.lang); }

async function uvVoices() {
  if (!UV.voices) UV.voices = (await api('/api/ultravox/voices')).voices;
  return UV.voices;
}

function renderAgent() {
  const a = uvCurrent();
  if (!a) { $('#uvbody').innerHTML = 'Нет агентов'; return; }
  if (a.error) {
    $('#uvbody').innerHTML = '<span class="bad-txt">'+uvEsc(a.label)+': '+uvEsc(a.error)+'</span>'
      + (a.agentId ? '' : '<p class="hint">Агента для этого языка ещё нет. Панель может создать его в вашем аккаунте Ultravox '
        + '(том, чей ключ в ULTRAVOX_API_KEY; оплата разговоров — там же) по образцу: промпт из ultravox/prompts/'+a.lang+'.md, '
        + 'голос этого языка, приветствие и фразы при молчании. Всё это потом можно поменять здесь же.</p>'
        + '<button class="act" id="uvCreate">Создать агента из образца</button>');
    const cb = $('#uvCreate');
    if (cb) cb.onclick = async () => {
      if (!(await Dialog.confirm('Создать агента '+a.label+' в аккаунте Ultravox? Его ID запишется в '+a.envKey+'.', 'Создание агента', false, 'Создать'))) return;
      cb.disabled = true; cb.textContent = 'Создаю…';
      try {
        const r = await uvPost('/api/ultravox/agents/'+a.lang+'/create', {});
        await Dialog.alert('Агент '+r.name+' создан (модель '+r.model+', голос '+r.voice+'), ID записан в '+r.envKey+'.\n\n'
          + 'Дальше:\n1. Переменные (.env) → «Применить» — чтобы звонки пошли к новому агенту.\n'
          + '2. Здесь, блок «Тулзы» → «Синхронизировать с Ultravox» — чтобы подключить тулзы.', 'Агент создан');
        loadUltravox(); loadUvTools();
      } catch (e) { toast('Ошибка: '+e.message); cb.disabled = false; cb.textContent = 'Создать агента из образца'; }
    };
    return;
  }
  const f = a.fields;
  const row = (key, label, input, hint) => '<div class="row env-row" data-row="'+key+'"><label>'+label+'</label>'
    + '<div class="env-field">'+input+(hint?'<small class="hint env-desc">'+hint+'</small>':'')
    + '<small class="bad-txt env-err"></small></div></div>';
  const inp = (key, val, ph) => '<input data-uv="'+key+'" value="'+uvEsc(val)+'" placeholder="'+uvEsc(ph||'')+'">';
  const vad = f.vadSettings || {};
  const inact = (f.inactivityMessages || []).map((m, i) => inactRow(m, i)).join('');

  const warn = (a.warnings || []).length
    ? '<div class="uv-problems"><b>Промпт и включённые функции расходятся:</b><ul>'+a.warnings.map(w => '<li>'+uvEsc(w)+'</li>').join('')+'</ul></div>' : '';
  $('#uvbody').innerHTML = warn +
    '<div class="hint" style="margin-bottom:10px">Агент <b>'+uvEsc(f.name)+'</b> · ID <code>'+uvEsc(a.agentId)+'</code> ('+a.envKey+')'
    + (a.calls != null ? ' · звонков: '+a.calls : '')+'</div>'
    + '<div class="grp">Голос и язык</div>'
    + row('voice', 'Голос', '<div class="uv-voice"><select data-uv="voice"><option value="'+uvEsc(f.voice)+'">загрузка списка…</option></select>'
        + '<label class="uv-inline"><input type="checkbox" id="uvAllVoices"> все языки</label>'
        + '<button class="ghost" id="uvPreview" type="button">▶ прослушать</button></div>', 'Список голосов Ultravox; по умолчанию — только языка агента.')
    + row('languageHint', 'Язык распознавания', inp('languageHint', f.languageHint, 'ro'), 'Код языка речи клиента: ro, ru …')
    + '<div class="grp">Разговор</div>'
    + row('greeting', 'Приветствие', '<textarea data-uv="greeting" rows="2">'+uvEsc(f.greeting)+'</textarea>'
        + '<label class="uv-inline"><input type="checkbox" data-uv="greetingUninterruptible"'+(f.greetingUninterruptible?' checked':'')+'> клиент не может перебить приветствие</label>',
        'Первая фраза агента в начале звонка.')
    + row('inactivityMessages', 'Если клиент молчит', '<div id="uvInact">'+inact+'</div>'
        + '<button class="ghost" id="uvAddInact" type="button">+ добавить сообщение</button>',
        'Время отсчитывается от последней фразы. Первое сообщение без «положить трубку» — иначе звонок оборвётся, пока агент ждёт тулз.')
    + row('maxDuration', 'Макс. длительность', inp('maxDuration', f.maxDuration, '300s'), 'В секундах, напр. 300s.')
    + '<div class="grp">Промпт</div>'
    + row('systemPrompt', 'Системный промпт', '<textarea data-uv="systemPrompt" class="uv-prompt" spellcheck="false">'+uvEsc(f.systemPrompt)+'</textarea>',
        'Инструкции агенту. Логику держать одинаковой в RO и RU.')
    + '<details class="uv-adv"><summary class="grp">Дополнительно</summary>'
    + row('name', 'Имя агента', inp('name', f.name), 'Латиница, цифры, _ и -.')
    + row('model', 'Модель', '<select data-uv="model">'+UV.models.concat(UV.models.includes(f.model)?[]:[f.model])
        .map(m => '<option'+(m===f.model?' selected':'')+'>'+uvEsc(m)+'</option>').join('')+'</select>')
    + row('vadSettings', 'Паузы (VAD)',
        ['turnEndpointDelay','minimumTurnDuration','minimumInterruptionDuration','frameActivationThreshold'].map(k =>
          '<div class="uv-vad"><span class="hint">'+k+'</span><input data-vad="'+k+'" value="'+uvEsc(vad[k] == null ? '' : vad[k])+'"></div>').join(''),
        'Секунды вида 0.500s; порог — число 0…1. Пусто — значение Ultravox по умолчанию.')
    + '</details>'
    + '<div class="grp">Тулзы агента</div><div class="hint">'
    + (a.tools || []).map(t => '<code>'+uvEsc(t.name)+'</code>').join(' ') + ' — настройка в блоке «Тулзы» ниже.</div>'
    + '<div class="grp">История изменений</div><div id="uvHistory" class="hint">Загрузка…</div>';

  fillVoices(f.voice, f.languageHint);
  $('#uvAllVoices').onchange = () => fillVoices($('[data-uv="voice"]').value, f.languageHint);
  $('#uvPreview').onclick = playVoice;
  $('#uvAddInact').onclick = () => {
    const box = $('#uvInact');
    box.insertAdjacentHTML('beforeend', inactRow({ duration: '', message: '', endBehavior: '' }, box.children.length));
    bindInact();
  };
  bindInact();
  loadHistory();
}

function inactRow(m, i) {
  return '<div class="uv-inact"><input class="uv-dur" data-in="duration" value="'+uvEsc(m.duration)+'" placeholder="45s">'
    + '<input data-in="message" value="'+uvEsc(m.message)+'" placeholder="текст сообщения">'
    + '<select data-in="endBehavior">'+Object.entries(END_LABELS).map(([v, l]) =>
        '<option value="'+v+'"'+((m.endBehavior||'')===v?' selected':'')+'>'+l+'</option>').join('')+'</select>'
    + '<button class="ghost" data-del type="button" title="убрать">✕</button></div>';
}
function bindInact() {
  document.querySelectorAll('#uvInact [data-del]').forEach(b => b.onclick = () => b.parentElement.remove());
}

async function fillVoices(current, langHint) {
  const sel = $('[data-uv="voice"]');
  try {
    const all = await uvVoices();
    const lang = (langHint || '').slice(0, 2).toLowerCase();
    const showAll = $('#uvAllVoices') && $('#uvAllVoices').checked;
    let list = showAll || !lang ? all : all.filter(v => (v.language || '').toLowerCase().startsWith(lang));
    if (!list.some(v => v.voiceId === current)) list = all.filter(v => v.voiceId === current).concat(list);
    sel.innerHTML = list.map(v => '<option value="'+uvEsc(v.voiceId)+'"'+(v.voiceId===current?' selected':'')+' data-preview="'+uvEsc(v.previewUrl)+'">'
      + uvEsc(v.name)+' · '+uvEsc(v.languageLabel || v.language)+(v.provider?' · '+uvEsc(v.provider):'')
      +(v.external?' · нужен свой ключ провайдера':'')+'</option>').join('')
      || '<option value="'+uvEsc(current)+'">'+uvEsc(current)+'</option>';
  } catch (e) { sel.innerHTML = '<option value="'+uvEsc(current)+'">'+uvEsc(current)+' (список не загрузился)</option>'; }
}

let uvAudio = null;
function playVoice() {
  const o = $('[data-uv="voice"]').selectedOptions[0];
  const url = o && o.dataset.preview;
  if (!url) { toast('У этого голоса нет образца'); return; }
  if (uvAudio) uvAudio.pause();
  uvAudio = new Audio(url); uvAudio.play().catch(() => toast('Не удалось воспроизвести'));
}

function collectChanges() {
  const c = {};
  document.querySelectorAll('#uvbody [data-uv]').forEach(el => {
    c[el.dataset.uv] = el.type === 'checkbox' ? el.checked : el.value;
  });
  c.inactivityMessages = [...document.querySelectorAll('#uvInact .uv-inact')].map(r => ({
    duration: r.querySelector('[data-in="duration"]').value,
    message: r.querySelector('[data-in="message"]').value,
    endBehavior: r.querySelector('[data-in="endBehavior"]').value,
  }));
  c.vadSettings = {};
  document.querySelectorAll('#uvbody [data-vad]').forEach(el => { c.vadSettings[el.dataset.vad] = el.value; });
  return c;
}

async function uvPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.errors = j.errors; throw e; }
  return j;
}

function showErrors(errors) {
  document.querySelectorAll('#uvbody .env-err').forEach(e => e.textContent = '');
  document.querySelectorAll('#uvbody .env-row').forEach(r => r.classList.remove('has-err'));
  Object.entries(errors || {}).forEach(([k, m]) => {
    const row = document.querySelector('#uvbody [data-row="'+k+'"]');
    if (row) { row.classList.add('has-err'); row.querySelector('.env-err').textContent = m; }
    const adv = row && row.closest('details'); if (adv) adv.open = true;
  });
  const first = document.querySelector('#uvbody .env-row.has-err'); if (first) first.scrollIntoView({ block: 'center' });
}

function summaryText(summary) {
  return summary.map(s => s.text ? '• '+s.field+': '+s.text : '• '+s.field+': '+s.before+'  →  '+s.after).join('\n');
}

async function uvApply(dryRunOnly) {
  const a = uvCurrent(); if (!a || a.error) return;
  const changes = collectChanges();
  let preview;
  try { preview = await uvPost('/api/ultravox/agents/'+a.lang+'/preview', { changes }); showErrors({}); }
  catch (e) { showErrors(e.errors); toast('Ошибка: '+e.message); return; }
  if (!preview.summary.length) { toast('Изменений нет'); return; }
  const text = summaryText(preview.summary)
    + ((preview.warnings || []).length ? '\n\n⚠ Промпт и включённые функции расходятся:\n'+preview.warnings.map(w => '• '+w).join('\n') : '');
  if (dryRunOnly) { await Dialog.alert(text, 'Что изменится в агенте '+a.fields.name); return; }
  if (!(await Dialog.confirm(text+'\n\nПеред отправкой сохраняется копия агента — можно откатить.',
      'Применить в Ultravox: '+a.fields.name, false, 'Применить'))) return;
  const b = $('#uvApply'); b.disabled = true; b.textContent = 'Отправляю…';
  try {
    const r = await uvPost('/api/ultravox/agents/'+a.lang+'/apply', { changes });
    let msg = 'Применено: '+r.changed.join(', ');
    if (r.mismatch && r.mismatch.length) msg += '. ВНИМАНИЕ: не совпало после сохранения: '+r.mismatch.join(', ');
    if (r.untouched && r.untouched.length) msg += '. ВНИМАНИЕ: изменились и другие поля: '+r.untouched.join(', ');
    if ((r.mismatch && r.mismatch.length) || (r.untouched && r.untouched.length)) await Dialog.alert(msg, 'Проверьте агента');
    else toast(msg);
    await loadUltravox();
  } catch (e) { showErrors(e.errors); toast('Ошибка: '+e.message); }
  b.disabled = false; b.textContent = 'Применить в Ultravox';
}

async function loadHistory() {
  const a = uvCurrent();
  try {
    const d = await api('/api/ultravox/agents/'+a.lang+'/history');
    const list = d.history.filter(f => f.endsWith('-before.json')).slice(0, 15);
    $('#uvHistory').innerHTML = list.length
      ? '<div class="hint" style="margin-bottom:6px">Копии агента перед каждым изменением (хранятся на сервере в instance/ultravox/history/'+a.lang+'/).</div>'
        + list.map(f => '<div class="uv-hist"><span>'+uvEsc(histDate(f))+'</span>'
          + '<button class="ghost" data-restore="'+uvEsc(f)+'" type="button">Откатить к этой версии</button></div>').join('')
      : 'Изменений из панели ещё не было.';
    document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => uvRestore(b.dataset.restore));
  } catch (e) { $('#uvHistory').textContent = 'История недоступна: '+e.message; }
}

function histDate(f) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? new Date(m[1]+'T'+m[2]+':'+m[3]+':'+m[4]+'Z').toLocaleString() : f;
}

async function uvRestore(file) {
  const a = uvCurrent();
  let preview;
  try { preview = await uvPost('/api/ultravox/agents/'+a.lang+'/restore', { file, dryRun: true }); }
  catch (e) { toast('Ошибка: '+e.message); return; }
  if (!preview.summary.length) { toast('Агент уже совпадает с этой версией'); return; }
  if (!(await Dialog.confirm(summaryText(preview.summary), 'Откатить к версии '+histDate(file)+'?', true, 'Откатить'))) return;
  try { const r = await uvPost('/api/ultravox/agents/'+a.lang+'/restore', { file }); toast('Откат выполнен: '+r.changed.join(', ')); await loadUltravox(); }
  catch (e) { toast('Ошибка: '+e.message); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#uvApply').onclick = () => uvApply(false);
  $('#uvCheck').onclick = () => uvApply(true);
  $('#uvReload').onclick = () => { UV.voices = null; loadUltravox(); loadUvTools(); };
});

// -------- ULTRAVOX: tools (shared by RO and RU) --------
const REQ_LABEL = { billing: 'биллинг', network: 'учёт сети' };

async function loadUvTools() {
  const box = $('#uvtools');
  box.innerHTML = '<div class="grp">Тулзы (общие для всех агентов)</div>Проверяю тулзы в Ultravox…';
  let d;
  try { d = await api('/api/ultravox/tools'); }
  catch (e) { box.innerHTML = '<div class="grp">Тулзы</div><span class="bad-txt">'+uvEsc(e.message)+'</span>'; return; }
  const ok = !d.problems.length;
  box.innerHTML = '<div class="grp">Тулзы (общие для всех агентов)</div>'
    + '<div class="bar">'
    + '<button class="ghost" id="uvtCheck">Проверить</button>'
    + '<button class="act" id="uvtSync"'+(ok?' disabled':'')+'>Синхронизировать с Ultravox</button>'
    + '<small class="hint">Адрес — из TOOLS_PUBLIC_URL, ключ — из TOOLS_API_KEY, выключенные функции (биллинг, учёт сети) отключаются от агентов.</small></div>'
    + (ok ? '<div class="ok-txt" style="margin-bottom:10px">✓ Тулзы в Ultravox совпадают с настройками</div>'
          : '<div class="uv-problems"><b>Расхождения ('+d.problems.length+'):</b><ul>'+d.problems.map(p => '<li>'+uvEsc(p)+'</li>').join('')+'</ul></div>')
    + d.tools.map(t => toolRow(t, d.agents)).join('');
  $('#uvtCheck').onclick = loadUvTools;
  $('#uvtSync').onclick = syncUvTools;
  document.querySelectorAll('[data-tsave]').forEach(b => b.onclick = () => saveTool(b.dataset.tsave, false));
  document.querySelectorAll('[data-treset]').forEach(b => b.onclick = () => saveTool(b.dataset.treset, true));
}

function toolRow(t, agents) {
  const badge = t.requires
    ? '<span class="uv-badge '+(t.enabled?'on':'off')+'">'+REQ_LABEL[t.requires]+(t.enabled?'':' — выключено')+'</span>' : '';
  const att = agents.map(a => {
    const x = t.attached[a.lang] || {};
    return '<span class="uv-badge '+(x.on?'on':'off')+'">'+a.lang.toUpperCase()+(x.on?' ✓':' —')+'</span>';
  }).join(' ');
  const state = t.diffs.length ? '<span class="bad-txt">'+t.diffs.length+' расх.</span>' : '<span class="ok-txt">✓</span>';
  return '<details class="uv-tool"><summary><code>'+uvEsc(t.name)+'</code> '+badge+' '+att+' '+state
    + (t.overridden.length ? ' <small class="hint">изменён для этой установки</small>' : '')+'</summary>'
    + '<div class="uv-tool-body" data-tool="'+uvEsc(t.name)+'">'
    + '<div class="hint">Адрес: <code>'+uvEsc(t.url)+'</code></div>'
    + (t.diffs.length ? '<ul class="bad-txt">'+t.diffs.map(x => '<li>'+uvEsc(x.text)+'</li>').join('')+'</ul>' : '')
    + '<div class="row env-row" data-row="description"><label>Описание</label><div class="env-field">'
    + '<textarea data-t="description" rows="7" spellcheck="false">'+uvEsc(t.description)+'</textarea>'
    + '<small class="hint env-desc">Агент решает по описанию, когда и как вызывать тулз. Подстановки {COMPANY_NAME}, {CLIENT_ID_LABEL}, {CLIENT_ID_FORMAT} берутся из .env.</small>'
    + '<small class="bad-txt env-err"></small></div></div>'
    + '<div class="row env-row" data-row="timeout"><label>Таймаут</label><div class="env-field">'
    + '<input data-t="timeout" value="'+uvEsc(t.timeout)+'" placeholder="'+uvEsc(t.template.timeout)+'">'
    + '<small class="hint env-desc">Сколько Ultravox ждёт ответа, напр. 15s. Шаблон: '+uvEsc(t.template.timeout)+'.</small>'
    + '<small class="bad-txt env-err"></small></div></div>'
    + '<div class="bar"><button class="ghost" data-tsave="'+uvEsc(t.name)+'">Сохранить для этой установки</button>'
    + (t.overridden.length ? '<button class="ghost" data-treset="'+uvEsc(t.name)+'">Вернуть шаблон</button>' : '')
    + '<small class="hint">Сохраняется на сервере; в Ultravox уходит кнопкой «Синхронизировать».</small></div>'
    + '</div></details>';
}

async function saveTool(name, reset) {
  const body = document.querySelector('.uv-tool-body[data-tool="'+name+'"]');
  const payload = reset ? { description: '', timeout: '' } : {
    description: body.querySelector('[data-t="description"]').value,
    timeout: body.querySelector('[data-t="timeout"]').value,
  };
  try { await uvPost('/api/ultravox/tools/'+encodeURIComponent(name), payload); toast(reset ? 'Возвращён шаблон' : 'Сохранено. Отправить в Ultravox — «Синхронизировать».'); loadUvTools(); }
  catch (e) {
    Object.entries(e.errors || {}).forEach(([k, m]) => { const r = body.querySelector('[data-row="'+k+'"]'); if (r) { r.classList.add('has-err'); r.querySelector('.env-err').textContent = m; } });
    toast('Ошибка: '+e.message);
  }
}

async function syncUvTools() {
  let plan;
  try { plan = await uvPost('/api/ultravox/tools/sync', { dryRun: true }); }
  catch (e) { toast('Ошибка: '+e.message); return; }
  if (!plan.plan.length) { toast('Всё уже совпадает'); return; }
  if (!(await Dialog.confirm(plan.plan.map(p => '• '+p).join('\n')
      + '\n\nНа время обновления тулзы отвязываются от агентов и сразу подключаются обратно. Копия прежних тулзов сохраняется на сервере.',
      'Синхронизировать тулзы с Ultravox', false, 'Синхронизировать'))) return;
  const b = $('#uvtSync'); b.disabled = true; b.textContent = 'Синхронизирую…';
  try {
    const r = await uvPost('/api/ultravox/tools/sync', {});
    if (r.problems && r.problems.length) await Dialog.alert('Сделано, но остались расхождения:\n'+r.problems.join('\n'), 'Проверьте тулзы');
    else toast('Тулзы синхронизированы');
  } catch (e) { await Dialog.alert(e.message, 'Синхронизация не удалась'); }
  loadUvTools();
  loadUltravox();
}
