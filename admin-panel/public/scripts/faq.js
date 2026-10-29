// -------- FAQ --------
let faqData = { faq: [] };
async function loadFaq() {
  const cfg = await api('/api/config').catch(()=>({ultravoxUrl:'https://app.ultravox.ai'}));
  $('#ultravoxLink').href = cfg.ultravoxUrl;

  faqData = await api('/api/faq');
  renderFaq();

  $('#addFaq').onclick = () => {
    faqData.faq.push({ id:'', title:'', keywords:{ru:[],ro:[]}, answers:{ru:'',ro:''}, requires_client_id:false, _collapsed: false });
    renderFaq();

    toast('Новая запись добавлена в конец списка');
    setTimeout(() => {
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth'
      });
    }, 50);
  };
  $('#saveFaq').onclick = saveFaq;

  function renderFaq() {
    $('#faqlist').innerHTML = faqData.faq.map((e, i) =>
      '<div class="card '+(e._collapsed ? 'collapsed' : '')+'" style="background:var(--field);margin-top:22px;border-top:2px solid var(--acc);padding-top:18px">'
      + '<div style="display:flex;gap:12px;align-items:flex-start">'
      + '<button class="faq-toggle" data-toggle="'+i+'" title="Свернуть/Развернуть">▼</button>'
      + '<div style="flex:1">'
      + '<input class="faq-title" data-i="'+i+'" data-f="title" value="'+(e.title||'').replace(/"/g,'&quot;')+'" '
      + 'placeholder="Название сценария (напр. Pachete internet)">'
      + '<div class="faq-id">ID: <code>'+(e.id||'—')+'</code>'
      + '<label style="display:inline-flex;align-items:center;gap:5px;color:var(--tx)">'
      + '<input type="checkbox" data-i="'+i+'" data-f="requires_client_id" '+(e.requires_client_id?'checked':'')+'> Требуется ID клиента'
      + '<span class="help">?<span class="bubble"><b>Требуется ID клиента</b> — включи, если по этому вопросу '
      + 'бот должен запросить ID клиента и увести в диагностику (проблемы с подключением). '
      + 'Для справочных вопросов (цены, график) — выключено.</span></span></label>'
      + '</div></div>'
      + '<button class="faq-del" data-del="'+i+'">Удалить</button>'
      + '</div>'
      + '<div class="faq-body">'
      + '<div class="faq-grid">'
      + '  <div class="faq-col-ro">'
      + '    <div class="lang-head">🇷🇴 Română</div>'
      + '    <div class="fld">Ключевые слова <small>по одной фразе на строку</small></div>'
      + '    <textarea class="kw" data-i="'+i+'" data-f="kro">'+(e.keywords.ro||[]).join('\n')+'</textarea>'
      + '    <div class="fld">Ответ бота <small>что бот скажет пользователю</small></div>'
      + '    <textarea class="answer" data-i="'+i+'" data-f="aro">'+(e.answers.ro||'')+'</textarea>'
      + '  </div>'
      + '  <div class="faq-col-ru">'
      + '    <div class="lang-head">🇷🇺 Русский</div>'
      + '    <div class="fld">Ключевые слова <small>по одной фразе на строку</small></div>'
      + '    <textarea class="kw" data-i="'+i+'" data-f="kru">'+(e.keywords.ru||[]).join('\n')+'</textarea>'
      + '    <div class="fld">Ответ бота <small>что бот скажет пользователю</small></div>'
      + '    <textarea class="answer" data-i="'+i+'" data-f="aru">'+(e.answers.ru||'')+'</textarea>'
      + '  </div>'
      + '</div>'
      + '</div>'
      + '</div>'
    ).join('') || '<small class="hint">Пусто. Нажми «Добавить запись».</small>';

    $('#faqlist').querySelectorAll('textarea.answer').forEach(t => {
      const grow = () => { t.style.height='auto'; t.style.height=(t.scrollHeight+2)+'px'; };
      grow(); t.addEventListener('input', grow);
    });

    $('#faqlist').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const e = faqData.faq[+b.dataset.del];
      const name = e.title || e.id || 'без названия';
      if (!(await Dialog.confirm('Удалить сценарий «'+name+'»? Это действие нельзя отменить.', 'Удаление записи', true))) return;

      collect();
      faqData.faq.splice(+b.dataset.del, 1);
      renderFaq();
      toast('Запись «' + name + '» удалена');
    });

    $('#faqlist').querySelectorAll('[data-toggle]').forEach(b => b.onclick = (ev) => {
      const idx = +b.dataset.toggle;
      faqData.faq[idx]._collapsed = !faqData.faq[idx]._collapsed;
      const card = ev.target.closest('.card');
      card.classList.toggle('collapsed');
    });
  }

  function collect() {
    $('#faqlist').querySelectorAll('[data-i]').forEach(el => {
      const e = faqData.faq[+el.dataset.i]; const f = el.dataset.f;
      if (f==='id') e.id = el.value.trim();
      else if (f==='title') e.title = el.value.trim();
      else if (f==='requires_client_id') e.requires_client_id = el.checked;
      else if (f==='kru') e.keywords.ru = el.value.split('\n');
      else if (f==='kro') e.keywords.ro = el.value.split('\n');
      else if (f==='aru') e.answers.ru = el.value;
      else if (f==='aro') e.answers.ro = el.value;
    });
  }

  async function saveFaq() {
    collect();
    try { const r = await api('/api/faq',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(faqData)});
      toast('Сохранено: '+r.count+' записей'); }
    catch(e){ toast('Ошибка: '+e.message); }
  }
}
