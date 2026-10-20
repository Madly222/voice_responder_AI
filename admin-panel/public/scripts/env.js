// -------- ENV --------
// Groups and descriptions come from the server (from .env.example). Secrets are masked:
// a field showing "••••" is left alone and keeps its current value.
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

function envField(it) {
  const id = 'env-' + it.key;
  let input;
  if (it.choices) {
    const cur = (it.value || '').toLowerCase();
    input = '<select id="'+id+'" data-key="'+it.key+'" data-orig="'+escAttr(it.value)+'">'
      + '<option value=""'+(cur===''?' selected':'')+'>— не задано'+(it.def?' ('+escAttr(it.def)+')':'')+' —</option>'
      + it.choices.map(c => '<option value="'+c+'"'+(cur===c?' selected':'')+'>'+c+'</option>').join('')
      + '</select>';
  } else {
    input = '<input id="'+id+'" data-key="'+it.key+'" data-orig="'+escAttr(it.value)+'" value="'+escAttr(it.value)+'"'
      + (it.secret ? ' type="password" autocomplete="new-password"' : '')
      + ' placeholder="'+escAttr(it.def ? 'по умолчанию: '+it.def : '')+'">';
  }
  return '<div class="row env-row" data-row="'+it.key+'">'
    + '<label for="'+id+'" title="'+it.key+'">'+it.key+(it.secret?' <small class="hint">секрет</small>':'')+'</label>'
    + '<div class="env-field">'+input
    + (it.desc ? '<small class="hint env-desc">'+escAttr(it.desc)+'</small>' : '')
    + '<small class="bad-txt env-err"></small></div></div>';
}

async function loadEnv() {
  const d = await api('/api/env');
  $('#paUser').value = d.panelUser || '';

  $('#envrows').innerHTML = d.groups.map(g => {
    let sub = null, html = '<div class="grp env-grp">'+escAttr(g.name)+'</div>';
    for (const it of g.items) {
      if (it.sub && it.sub !== sub) { sub = it.sub; html += '<div class="env-sub">'+escAttr(sub)+'</div>'; }
      html += envField(it);
    }
    return '<div class="env-block">'+html+'</div>';
  }).join('');

  $('#paSave').onclick = async () => {
    const user = $('#paUser').value.trim(); const pass = $('#paPass').value;
    if (pass.length < 8) { toast('Пароль минимум 8 символов'); return; }
    if (!(await Dialog.confirm('Сменить доступ к панели? Панель перезапустится, текущая сессия прервётся.', 'Смена пароля', true, 'Сменить'))) return;
    const b = $('#paSave'); b.textContent='Меняю…'; b.disabled=true;
    try {
      await api('/api/panel-auth',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user, pass})});
      $('#tab-env').innerHTML = '<div class="card"><div class="grp">Доступ к панели</div>'
        + '<p>Доступ изменён. Панель перезапускается (10–20 секунд).<br><br>'
        + '<b>Закрой это окно браузера полностью</b> и открой панель заново — тогда браузер спросит новый логин и пароль. '
        + 'Если просто обновить страницу, останется кэшированный старый пароль.</p></div>';
    } catch(e){ toast('Ошибка: '+e.message); b.textContent='Сменить доступ и перезапустить панель'; b.disabled=false; }
  };

  $('#saveEnv').onclick = async () => {
    const updates = {};
    document.querySelectorAll('#envrows [data-key]').forEach(i => {
      if (i.value !== i.dataset.orig) updates[i.dataset.key] = i.value;   // send only what changed
    });
    document.querySelectorAll('#envrows .env-err').forEach(e => e.textContent = '');
    document.querySelectorAll('#envrows .env-row').forEach(r => r.classList.remove('has-err'));
    if (!Object.keys(updates).length) { toast('Нет изменений'); return; }
    const r = await fetch('/api/env', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({updates})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errs = j.errors || {};
      Object.entries(errs).forEach(([k, m]) => {
        const row = document.querySelector('[data-row="'+k+'"]');
        if (row) { row.classList.add('has-err'); row.querySelector('.env-err').textContent = m; }
      });
      const first = document.querySelector('.env-row.has-err'); if (first) first.scrollIntoView({block:'center'});
      toast('Не сохранено: '+(Object.keys(errs).length ? 'ошибок '+Object.keys(errs).length : (j.error || r.statusText)));
      return;
    }
    toast('Сохранено: '+(j.changed.length+j.added.length)+'. Чтобы сервисы увидели изменения — «Применить».');
    showPending();
    loadEnv();
  };

  $('#applyEnv').onclick = applyEnvPlan;
  showPending();
}

// What is pending: services with stale values, Ultravox tools, prompt warnings.
function planText(p) {
  const L = [];
  p.services.forEach(s => L.push('• перезапустить '+s.service
    + (s.notRunning ? ' (не запущен)' : ': '+s.vars.join(', '))
    + (s.dropsCalls ? '  ⚠ оборвёт идущие звонки' : '')
    + (s.self ? '  (панель перезапустится, страницу нужно будет обновить)' : '')));
  if (p.tools.needed) p.tools.plan.forEach(x => L.push('• тулзы Ultravox: '+x));
  if (p.tools.error) L.push('• тулзы Ultravox: проверить не удалось — '+p.tools.error);
  (p.promptWarnings || []).forEach(a => a.warnings.forEach(w => L.push('⚠ промпт '+a.lang.toUpperCase()+': '+w)));
  return L.join('\n');
}
const planEmpty = (p) => !p.services.length && !p.tools.needed;

async function showPending() {
  const el = $('#envPending'); if (!el) return;
  el.textContent = 'Проверяю, что ждёт применения…';
  try {
    const p = await api('/api/apply/plan');
    el.innerHTML = planEmpty(p) ? '<span class="ok-txt">✓ Все сервисы и тулзы работают с текущими значениями .env</span>'
      : '<span class="bad-txt">Ждут применения: '+[...p.services.map(s => s.service), ...(p.tools.needed ? ['тулзы Ultravox'] : [])].join(', ')+'</span>';
  } catch (e) { el.textContent = 'Не удалось проверить: '+e.message; }
}

async function applyEnvPlan() {
  const b = $('#applyEnv');
  let p;
  try { p = await api('/api/apply/plan'); } catch (e) { toast('Ошибка: '+e.message); return; }
  if (planEmpty(p)) {
    const w = planText(p);
    await Dialog.alert('Всё уже применено: сервисы и тулзы работают с текущими значениями.' + (w ? '\n\n'+w : ''), 'Применение настроек');
    return;
  }
  if (!(await Dialog.confirm(planText(p), 'Применить настройки .env', p.services.some(s => s.dropsCalls), 'Применить'))) return;
  b.textContent = 'Применяю…'; b.disabled = true;
  try {
    const r = await api('/api/apply', { method: 'POST' });
    const parts = [];
    if (r.restarted.length) parts.push('перезапущены: '+r.restarted.join(', '));
    if (r.tools) parts.push('тулзы синхронизированы');
    if (r.panelRestarting) parts.push('панель перезапускается — обновите страницу через 15–20 с');
    if (r.tools && r.tools.problems && r.tools.problems.length) await Dialog.alert('Остались расхождения тулзов:\n'+r.tools.problems.join('\n'), 'Проверьте тулзы');
    toast('Готово: '+(parts.join('; ') || 'нечего делать'));
  } catch (e) { await Dialog.alert(e.message, 'Применить не удалось'); }
  b.textContent = 'Применить'; b.disabled = false;
  showPending();
}
