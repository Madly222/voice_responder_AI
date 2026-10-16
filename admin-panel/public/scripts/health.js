// -------- МОНИТОРИНГ --------
let lastHealth = {};

const CONTAINERS = ['faq-server','network-diag','avr-asterisk','avr-sts-ultravox','avr-sts-ultravox-ru','avr-core','avr-core-ru','avr-ami','admin-panel'];
const SVC_HELP = {
  'faq-server': 'Сервис вопросов-ответов: даёт боту все инструменты (FAQ, поиск клиента, диагностика). Рестарт — если завис. Пересобрать — после правок кода или смены .env.',
  'network-diag': 'SSH-диагностика свитчей (порт/MAC клиента). Рестарт — если завис. Пересобрать — после правок кода или смены сетевых кредов.',
  'avr-asterisk': 'Телефония (Asterisk): звонки, диалплан, SIP. Рестарт — применить правки конфигов (pjsip/extensions), НО рвёт активные звонки. Пересобирать нужно редко.',
  'avr-sts-ultravox': 'Мост к облаку Ultravox (голос агента). Рестарт — если завис. Пересобрать — после смены ULTRAVOX_* в .env.',
  'avr-core': 'Ядро avr: принимает аудио из Asterisk и гоняет в облако. Рестарт — если завис.',
  'avr-sts-ultravox-ru': 'Мост к облаку Ultravox для русского агента. Рестарт — если завис.',
  'avr-core-ru': 'Ядро avr для русского агента. Рестарт — если завис.',
  'avr-ami': 'Мост событий Asterisk (AMI). Рестарт — если завис.',
  'admin-panel': 'Эта панель. Рестарт — просто перезапуск. Пересобрать — применить обновление панели из архива (в фоне, панель ненадолго уйдёт).',
};

async function loadHealth() {
  const el = $('#tab-health');
  const rb = $('#refresh');
  if (rb && !rb.dataset.bound) {
    rb.dataset.bound = '1';
    rb.onclick = async () => {
      rb.disabled = true; rb.textContent = 'Обновляю…';
      $('#hts').textContent = 'опрашиваю сервисы…';
      try { await loadHealth(); } finally { rb.disabled = false; rb.textContent = 'Обновить'; }
    };
  }
  api('/api/settings').then(s => { $('#notifyMode').value = s.notifyMode || 'problems'; }).catch(()=>{});
  $('#notifyMode').onchange = async (e) => {
    try { await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({notifyMode:e.target.value})});
      toast(e.target.value==='always' ? 'Уведомления: всегда' : 'Уведомления: только при проблемах'); }
    catch(err){ toast('Ошибка: '+err.message); }
  };
  $('#checkNow').onclick = async () => {
    $('#checkNow').textContent='Проверяю…';
    try { const d = await api('/api/check-now',{method:'POST'}); toast('Проверка отправлена в Telegram');
      render(d, await status()); }
    catch(e){ toast('Ошибка: '+e.message); }
    $('#checkNow').textContent='Проверить сейчас';
  };
  const status = async () => { try { return (await api('/api/status')).status||{}; } catch(_){ return {}; } };
  try {
    const [d, st] = await Promise.all([ api('/api/health'), status() ]);
    render(d, st);
  } catch(e){ $('#hlist').innerHTML='<span class="bad-txt">'+e.message+'</span>'; }

  function helpIcon(text){ return text ? '<span class="help">?<span class="bubble">'+text.replace(/</g,'&lt;')+'</span></span>' : ''; }
  function row(dotOk, name, help, uptime, detail, svc, badDetail){
    return '<div class="hitem"><span class="dot '+(dotOk==='na'?'na':(dotOk?'ok':'bad'))+'"></span>'
      + '<span class="lbl">'+name+(uptime?' <small class="hint">('+uptime+')</small>':'')+helpIcon(help)+'</span>'
      + '<span class="det '+(badDetail?'bad-txt':'')+'">'+(detail||'')+'</span>'
      + (svc ? '<button class="ghost" data-restart="'+svc+'" style="flex:0 0 auto;padding:5px 11px;font-size:12px">Рестарт</button>'
             + '<button class="act" data-rebuild="'+svc+'" style="flex:0 0 auto;padding:5px 11px;font-size:12px">Пересобрать</button>' : '')
      + '</div>';
  }
  function render(d, st) {
    st = st || {};
    lastHealth = d;
    $('#hts').textContent = 'обновлено: ' + new Date(d.ts).toLocaleString('ru');
    const byId = {}; d.results.forEach(r => byId[r.id]=r);

    let html = '<div class="grp" style="display:flex;align-items:center">Сервисы (можно перезапускать)'
      + '<span class="help">?<span class="bubble"><b>Рестарт</b> — быстро передёргивает контейнер (пара секунд): '
      + 'применяет правки примонтированных конфигов (например Asterisk) или оживляет зависший сервис. '
      + 'Новый код и .env НЕ подхватывает.<br><br>'
      + '<b>Пересобрать</b> — заново собирает образ и пересоздаёт (дольше): подхватывает новый код и .env. '
      + 'Нужно после доработок, которые я присылаю архивом.</span></span></div>';

    html += CONTAINERS.map(svc => {
      const h = byId[svc]; const up = st[svc];
      const dotOk = h ? h.ok : /^Up/.test(up||'');
      const help = (h && h.help) || SVC_HELP[svc];
      const name = (h && h.label) || svc;
      return row(dotOk, name, help, up, h ? h.detail : '', svc, h ? !h.ok : false);
    }).join('');

    const ext = d.results.filter(r => !CONTAINERS.includes(r.id));
    if (ext.length) {
      html += '<div class="grp" style="margin-top:20px">Внешние интеграции (статус)</div>';
      html += ext.map(r => row(r.off ? 'na' : r.ok, r.label, r.help, '', r.detail, null, !r.ok)).join('');
    }

    $('#hlist').innerHTML = html;
    loadAudit();

    $('#hlist').querySelectorAll('[data-restart],[data-rebuild]').forEach(b => b.onclick = async () => {
      const rebuild = b.hasAttribute('data-rebuild');
      const svc = rebuild ? b.dataset.rebuild : b.dataset.restart;
      const verb = rebuild ? 'пересобрать' : 'перезапустить';
      if (!(await Dialog.confirm('Точно '+verb+' '+svc+'?' + (svc==='admin-panel' ? '\nПанель перезапустится, сессия ненадолго прервётся.' : ''), 'Подтверждение', true, rebuild ? 'Пересобрать' : 'Перезапустить'))) return;
      b.textContent='…'; b.disabled=true;
      try {
        const r = await api('/api/'+(rebuild?'rebuild':'restart')+'/'+svc,{method:'POST'});
        if (r.background) {
          el.innerHTML = '<div class="card"><div class="grp">'+svc+'</div><p>Операция «'+verb
          +'» запущена в фоне. Панель перезапускается — подожди и обнови страницу (Ctrl+Shift+R).</p></div>';
          return;
        }
        toast(svc+': '+verb+' — готово'); await loadHealth();
      } catch(e){ toast('Ошибка: '+e.message); b.disabled=false; b.textContent = rebuild?'Пересобрать':'Рестарт'; }
    });
  }
}

// Журнал действий в панели: кто, откуда, когда, что (значения не пишутся).
async function loadAudit() {
  const box = $('#auditList'); if (!box) return;
  try {
    const d = await api('/api/audit?limit=50');
    const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    box.innerHTML = d.entries.length ? '<table class="g-table"><thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Подробно</th></tr></thead><tbody>'
      + d.entries.map(e => '<tr><td>'+esc(new Date(e.ts).toLocaleString())+'</td><td>'+esc(e.user)+'<br><small class="hint">'+esc(e.ip)+'</small></td>'
        + '<td class="'+(e.result && e.result!=='ok' || /неверный|заблокирован/.test(e.action) ? 'bad-txt' : '')+'">'+esc(e.action)+(e.result && e.result!=='ok' ? ' ('+esc(e.result)+')' : '')+'</td>'
        + '<td>'+esc(e.detail || '')+'</td></tr>').join('') + '</tbody></table>'
      : '<span class="hint">Пока пусто.</span>';
  } catch (e) { box.textContent = 'Журнал недоступен: '+e.message; }
}

loadHealth();
