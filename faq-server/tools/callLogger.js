const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const transcript = require('./ultravoxTranscript');

const CALLS_FILE = path.join(__dirname, '../data/calls.txt');

let activeCalls = {};
let callCounter = 0;
// Фразы клиента, пришедшие до startCall (агент может вызвать searchFAQ раньше).
let pendingRequests = [];

// P-02: какой звонок обслуживает текущий запрос тулза.
// server.js кладёт сюда { uvCallId, callId } на время запроса; все 'latest' внутри
// тулзов (findByOSMP, getNetworkData, diagnoseClient, updateCall) пишут в этот звонок.
const callContext = new AsyncLocalStorage();

function runInCall(ctx, fn) {
  return callContext.run(ctx, fn);
}

// 'latest' / пусто → звонок текущего запроса; без контекста (Asterisk, Test tool) — последний открытый.
function resolveCallId(call_id) {
  if (call_id && call_id !== 'latest') return activeCalls[call_id] ? call_id : null;
  const ctx = callContext.getStore();
  if (ctx && ctx.uvCallId) {
    // звонок Ultravox известен: пишем только в свой звонок, иначе никуда
    return ctx.callId && activeCalls[ctx.callId] ? ctx.callId : null;
  }
  const keys = Object.keys(activeCalls);
  return keys.length ? keys[keys.length - 1] : null;
}

// Выбор нашего звонка для нового звонка Ultravox, когда свободных несколько:
// тот же язык (агент) и ближайшее время начала.
function chooseCandidate(ids, info) {
  let list = ids;
  if (info && info.lang) {
    const same = ids.filter((id) => !activeCalls[id].lang || activeCalls[id].lang === info.lang);
    if (same.length) list = same;
  }
  if (info && info.created) {
    const t = new Date(info.created).getTime();
    return list.slice().sort((a, b) =>
      Math.abs(new Date(activeCalls[a].start_time).getTime() - t)
      - Math.abs(new Date(activeCalls[b].start_time).getTime() - t))[0];
  }
  return list[list.length - 1];
}

async function doBind(uvCallId) {
  const ids = Object.keys(activeCalls);
  const bound = ids.find((id) => activeCalls[id].uv_call_id === uvCallId);
  if (bound) return bound;
  const free = ids.filter((id) => !activeCalls[id].uv_call_id);
  if (!free.length) {
    console.warn(`[CallLogger] Звонок Ultravox ${uvCallId}: нет свободного открытого звонка — данные не сохраняются`);
    return null;
  }
  let pick = free[0];
  let how = 'единственный открытый';
  if (free.length > 1) {
    const info = await transcript.getCallInfo(uvCallId);
    pick = chooseCandidate(free, info);
    how = info ? `по языку/времени из Ultravox (${info.lang || '-'}, ${info.created || '-'})`
      : 'последний открытый (Ultravox не ответил)';
  }
  activeCalls[pick].uv_call_id = uvCallId;
  console.log(`[CallLogger] Звонок Ultravox ${uvCallId} → call ${activeCalls[pick].number} (${how}, свободных: ${free.length})`);
  return pick;
}

// Привязки идут по одной, чтобы два звонка не забрали один и тот же call.
let bindQueue = Promise.resolve();
function bindUltravoxCall(uvCallId) {
  const run = bindQueue.then(() => doBind(uvCallId));
  bindQueue = run.catch(() => {});
  return run;
}

function init() {
  try {
    if (fs.existsSync(CALLS_FILE)) {
      const content = fs.readFileSync(CALLS_FILE, 'utf8');
      const matches = content.match(/Call: (\d+)/g);
      if (matches && matches.length > 0) {
        const numbers = matches.map(m => parseInt(m.replace('Call: ', '')));
        callCounter = Math.max(...numbers);
      }
    }
  } catch (err) {
    console.error('[CallLogger] Init error:', err.message);
  }
  console.log(`[CallLogger] Initialized, last call: ${callCounter}`);
}

init();

// Время в отчётах — в часовом поясе компании (контейнер живёт в UTC; P-24). Летнее/зимнее — само.
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const DATE_FMT = (() => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (e) {
    console.error(`[CallLogger] TIMEZONE=${TIMEZONE} не распознан, время в UTC:`, e.message);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
})();

function formatDate(date) {
  const p = Object.fromEntries(DATE_FMT.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

function startCall(params) {
  callCounter++;
  const callId = `call_${callCounter}`;

  activeCalls[callId] = {
    number: callCounter,
    start_time: new Date().toISOString(),
    phone: params.phone || params.caller_id || null,
    channel: params.channel || null,  // канал Asterisk: по нему endCall закрывает именно этот звонок
    uv_call_id: null,                 // ID звонка Ultravox (привязывается при первом вызове тулза)
    lang: ['ro', 'ru'].includes(params.lang) ? params.lang : null,  // из меню Asterisk
    client_name: null,
    client_type: null,
    osmp_id: null,
    client_ip: null,
    address: null,
    client_id: null,          // id клиента в WHMCS (для ссылки)
    netbox_ip_id: null,       // id записи IP в NetBox (для ссылки)
    netbox_device_id: null,   // id устройства в NetBox (для ссылки)
    request_summary: null,     // суть обращения одной фразой (присылает агент в updateCall)
    resolution: null,          // что агент сказал/посоветовал клиенту
    user_request: null,        // что сказал клиент (первый запрос в searchFAQ)
    user_requests: [],         // все запросы клиента за звонок
    faq_matched: [],           // какие записи FAQ совпали
    is_active: null,
    is_paid: null,
    mac_address: null,
    switch_name: null,
    switch_ip: null,
    port: null,
    pop: null,
    port_status: null,
    mac_found: null,
    diagnosis: null,
    has_power: null,
    router_rebooted: null,
    possible_issue: null,
    needs_callback: false,
    callback_reason: null,
    // Error tracking
    whmcs_error: null,
    netbox_error: null,
    diag_error: null
  };

  const fresh = pendingRequests.filter((p) => Date.now() - p.ts < 180000);
  pendingRequests = [];
  for (const p of fresh) {
    if (p.q && !activeCalls[callId].user_requests.includes(p.q)) {
      activeCalls[callId].user_requests.push(p.q);
      if (!activeCalls[callId].user_request) activeCalls[callId].user_request = p.q;
    }
  }
  if (fresh.length) console.log(`[CallLogger] Перенёс ${fresh.length} фраз(ы) клиента в call ${callCounter}`);

  console.log(`[CallLogger] Started call ${callCounter}, phone: ${activeCalls[callId].phone}, lang: ${activeCalls[callId].lang || '-'}`);

  return {
    error: false,
    data: {
      call_id: callId,
      call_number: callCounter,
      message: 'Call started'
    }
  };
}

function updateCall(params) {
  if (Object.keys(activeCalls).length === 0) {
    return { error: true, message: 'No active calls' };
  }
  const call_id = resolveCallId(params.call_id);
  if (!call_id) {
    return { error: true, message: 'Call not found' };
  }

  const fields = [
    'client_name', 'client_type', 'phone', 'caller_id',
    'osmp_id', 'client_ip', 'address', 'is_active', 'is_paid',
    'user_request', 'request_summary', 'resolution', 'client_id', 'netbox_ip_id', 'netbox_device_id',
    'mac_address', 'switch_name', 'switch_ip', 'port', 'pop',
    'port_status', 'mac_found', 'diagnosis',
    'has_power', 'router_rebooted',
    'possible_issue',
    'needs_callback', 'callback_reason',
    'whmcs_error', 'netbox_error', 'diag_error'
  ];

  let updated = [];

  for (const field of fields) {
    if (params[field] !== undefined) {
      if (field === 'caller_id') {
        activeCalls[call_id].phone = params[field];
        updated.push('phone');
      } else {
        activeCalls[call_id][field] = params[field];
        updated.push(field);
      }
    }
  }

  console.log(`[CallLogger] Updated call ${call_id}: ${updated.join(', ')}`);

  return {
    error: false,
    data: {
      call_id: call_id,
      updated_fields: updated,
      message: 'Call updated'
    }
  };
}

// Запоминает фразу клиента: её присылает Ultravox в searchFAQ как query.
// Это дословно то, что сказал клиент — ни LLM, ни лишних запросов не нужно.
function noteUserRequest(query, faqId) {
  if (!query) return false;
  if (!Object.keys(activeCalls).length) {
    // звонок ещё не начат — придержим фразу, startCall её заберёт
    pendingRequests.push({ q: String(query).trim().slice(0, 300), ts: Date.now() });
    if (pendingRequests.length > 10) pendingRequests.shift();
    return false;
  }
  const call_id = resolveCallId('latest');
  if (!call_id) return false;
  const call = activeCalls[call_id];
  const q = String(query).trim().slice(0, 300);
  if (!q) return false;
  if (!Array.isArray(call.user_requests)) call.user_requests = [];
  if (!call.user_requests.includes(q)) call.user_requests.push(q);
  if (!call.user_request) call.user_request = q;
  if (faqId) {
    if (!Array.isArray(call.faq_matched)) call.faq_matched = [];
    if (!call.faq_matched.includes(faqId)) call.faq_matched.push(faqId);
  }
  return true;
}

function endCall(params) {
  const { channel } = params || {};

  if (Object.keys(activeCalls).length === 0) {
    return { error: true, message: 'No active calls' };
  }
  // Asterisk присылает свой канал — закрываем именно этот звонок, а не последний открытый.
  const call_id = channel
    ? Object.keys(activeCalls).find((id) => activeCalls[id].channel === channel)
    : resolveCallId((params || {}).call_id);
  const call = call_id && activeCalls[call_id];
  if (!call) {
    console.warn(`[CallLogger] endCall: звонок не найден (channel ${channel || '-'})`);
    return { error: true, message: 'Call not found' };
  }

  call.end_time = new Date().toISOString();

  if (!call.possible_issue) {
    call.possible_issue = generatePossibleIssue(call);
  }

  const textEntry = formatCallForFile(call);

  try {
    let existingContent = '';
    if (fs.existsSync(CALLS_FILE)) {
      existingContent = fs.readFileSync(CALLS_FILE, 'utf8');
    }
    fs.writeFileSync(CALLS_FILE, textEntry + existingContent, 'utf8');
    console.log(`[CallLogger] Saved call ${call.number} to file`);
  } catch (err) {
    console.error('[CallLogger] Error saving:', err.message);
  }

  const chatbotData = formatCallForChatbot(call);
  chatbotData.start_time = call.start_time;
  chatbotData.end_time = call.end_time;
  // снимок звонка — если фразу клиента дотянем из стенограммы, пересоберём текст
  chatbotData._call = JSON.parse(JSON.stringify(call));
  delete activeCalls[call_id];

  return {
    error: false,
    data: {
      call_id: call_id,
      call_number: call.number,
      message: 'Call ended and saved',
      chatbot_data: chatbotData
    }
  };
}

// ============== NEW FUNCTION ==============
function checkRecentCall(params) {
  const { phone, within_minutes = 60 } = params;
  
  if (!phone) {
    return { error: true, message: 'Phone number required' };
  }
  
  // Normalize phone (remove spaces, dashes, +)
  const normalizedPhone = phone.replace(/[\s\-\+\(\)]/g, '');
  
  try {
    if (!fs.existsSync(CALLS_FILE)) {
      return { 
        error: false, 
        data: { 
          recent_call: false, 
          phone: normalizedPhone,
          message: 'No call history' 
        } 
      };
    }
    
    const content = fs.readFileSync(CALLS_FILE, 'utf8');
    const calls = content.split(/(?=Call: \d+)/);
    
    const cutoffTime = new Date(Date.now() - within_minutes * 60 * 1000);
    
    for (const callBlock of calls) {
      if (!callBlock.trim()) continue;
      
      // Extract phone
      const phoneMatch = callBlock.match(/Phone:\s*(\S+)/);
      if (!phoneMatch) continue;
      
      const callPhone = phoneMatch[1].replace(/[\s\-\+\(\)]/g, '');
      if (callPhone === '-') continue;
      
      // Check if phone matches (compare last 6-10 digits for flexibility)
      const phoneMatches = 
        callPhone === normalizedPhone ||
        (callPhone.length >= 6 && normalizedPhone.endsWith(callPhone.slice(-6))) ||
        (normalizedPhone.length >= 6 && callPhone.endsWith(normalizedPhone.slice(-6)));
      
      if (!phoneMatches) continue;
      
      // Extract date - format: DD.MM.YYYY HH:MM
      const dateMatch = callBlock.match(/Date:\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
      if (!dateMatch) continue;
      
      const [, day, month, year, hours, minutes] = dateMatch;
      const callDate = new Date(year, month - 1, day, hours, minutes);
      
      if (callDate >= cutoffTime) {
        // Found recent call!
        const minutesAgo = Math.round((Date.now() - callDate.getTime()) / 60000);
        
        console.log(`[CallLogger] Recent call found for ${normalizedPhone}: ${minutesAgo} minutes ago`);
        
        return {
          error: false,
          data: {
            recent_call: true,
            phone: normalizedPhone,
            minutes_ago: minutesAgo,
            call_date: callDate.toISOString(),
            message: `Found call from ${minutesAgo} minutes ago`
          }
        };
      }
    }
    
    console.log(`[CallLogger] No recent calls for ${normalizedPhone} within ${within_minutes} minutes`);
    
    return {
      error: false,
      data: {
        recent_call: false,
        phone: normalizedPhone,
        within_minutes: within_minutes,
        message: 'No recent calls found'
      }
    };
    
  } catch (err) {
    console.error('[CallLogger] checkRecentCall error:', err.message);
    return { error: true, message: err.message };
  }
}
// ==========================================

function formatCallForFile(call) {
  let entry = `Call: ${call.number}\n`;
  entry += `Date: ${formatDate(call.start_time)}\n`;
  if (call.needs_callback) {
    entry += `    CALLBACK NEEDED: YES\n`;
    entry += `    Callback reason: ${call.callback_reason || 'Client requested operator'}\n`;
  }
  entry += `    Phone: ${call.phone || '-'}\n`;
  entry += `    Lang: ${call.lang || '-'}\n`;
  entry += `    ${providers().CLIENT_ID_LABEL}: ${call.osmp_id || '-'}\n`;
  entry += `    Client: ${call.client_name || '-'}\n`;
  entry += `    Type: ${call.client_type || '-'}\n`;
  entry += `    IP: ${call.client_ip || '-'}\n`;
  entry += `    Address: ${call.address || '-'}\n`;
  entry += `    Switch: ${call.switch_name || '-'} / ${call.switch_ip || '-'} / ${call.port || '-'}\n`;
  entry += `    Request: ${call.request_summary || (call.user_requests || []).join(' | ') || call.user_request || '-'}\n`;
  entry += `    MAC: ${call.mac_address || '-'}\n`;
  entry += `    Active: ${formatBool(call.is_active)}\n`;
  entry += `    Paid: ${formatBool(call.is_paid)}\n`;
  entry += `    MAC on switch: ${formatBool(call.mac_found, 'Found', 'Not found')}\n`;
  entry += `    Port status: ${call.port_status === 'up' ? 'Up' : call.port_status === 'down' ? 'Down' : '-'}\n`;
  entry += `    Has power: ${formatBool(call.has_power)}\n`;
  entry += `    Router rebooted: ${formatBool(call.router_rebooted)}\n`;
  entry += `    Resolution: ${call.resolution || '-'}\n`;
  entry += `    Possible issue: ${call.possible_issue || '-'}\n`;
  entry += `\n`;
  return entry;
}

// Ссылки на биллинг и учёт сети строят переходники (providers.js), шаблоны можно задать в .env.
// require внутри функций: providers.js сам подключает этот модуль.
const providers = () => require('./providers');

function link(url, text) {
  return url ? '<a href="' + url + '">' + text + '</a>' : text;
}

const whmcsClientUrl = (call) => providers().clientUrl(call);
const netboxIpUrl = (call) => providers().ipUrl(call);
const netboxDeviceUrl = (call) => providers().deviceUrl(call);

// Отсеивает подтверждения и продиктованные цифры: «Da», «Da, 1-9-6-1-6», «алло».
const JUNK_RE = /^(da|nu|ok|bine|alo|salut|corect|mul[tț]umesc|multumesc|bun[aă]|да|нет|ага|алло|хорошо|спасибо|ясно)[\s.,!?-]*$/i;

function isUsefulPhrase(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return false;
  if (JUNK_RE.test(t)) return false;
  // убираем цифры и пунктуацию — если букв почти не осталось, это диктовка кода
  const letters = t.replace(/[\d\s.,!?:;()\/-]/g, '');
  if (letters.length < 12) return false;
  // обрывки вроде «la internet.» — слишком мало слов, чтобы что-то значить
  const words = t.split(/\s+/).filter((w) => /[a-z\u00e0-\u024f\u0400-\u04ff]{2,}/i.test(w));
  if (words.length < 4) return false;
  // «Da, e corect», «Da, 1-9-6-1-6» — первое слово-подтверждение и дальше почти ничего
  const rest = t.replace(/^(da|nu|ok|bine|да|нет)[\s,.]+/i, '');
  if (rest !== t && rest.replace(/[\d\s.,!?:;()\/-]/g, '').length < 10) return false;
  return true;
}

function esc(v) {
  return String(v == null ? '-' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Проблемы КЛИЕНТА — всё, что реально мешает ему пользоваться услугой.
// Долг сюда НЕ попадает: при неоплате мы не отключаем сразу.
function generateProblems(call) {
  const out = [];
  if (call.is_active === false) out.push('Contract not active - service disconnected');
  if (call.port_status === 'down') out.push('Port on switch is DOWN - technician required');
  if (call.mac_found === false) {
    out.push(call.has_power === false
      ? 'No power at client location - equipment is off'
      : 'MAC not found on switch - equipment off or disconnected');
  }
  if (call.has_power === false && call.mac_found !== false) out.push('No power at client location');
  if (call.mac_found === true && call.port_status === 'up') {
    out.push(call.router_rebooted === false
      ? 'Line OK on our side - router not rebooted yet (client-side issue)'
      : 'Line OK on our side - issue is on client side');
  }
  if (call.port_match === false) out.push('MAC found on a different port than NetBox says - check documentation');
  return out;
}

// Ошибки НАШЕЙ системы — это не проблема клиента, а то, что чинить нам.
function generateSystemErrors(call) {
  const out = [];
  if (call.whmcs_error) out.push(providers().billingLabel() + ': ' + call.whmcs_error);
  if (call.netbox_error) out.push(providers().networkLabel() + ': ' + call.netbox_error);
  if (call.diag_error) out.push('Diagnostics: ' + call.diag_error);
  if (call.client_ip && !call.mac_address && !call.switch_ip)
    out.push(`${providers().networkLabel()}: IP ${call.client_ip} has no switch/port data`);
  if (call.osmp_id && !call.client_name && !call.whmcs_error)
    out.push(`${providers().billingLabel()}: ${providers().CLIENT_ID_LABEL} not found in billing`);
  if (call.mac_address && call.switch_ip && call.port_status === null && call.mac_found === null && !call.diag_error)
    out.push('Diagnostics: not performed (no result from switch)');
  return out;
}

function formatCallForChatbot(call) {
  const problems = generateProblems(call);
  const sysErrors = generateSystemErrors(call);
  const rawRequests = (call.user_requests && call.user_requests.length)
    ? call.user_requests : (call.user_request ? [call.user_request] : []);
  const requests = call.request_summary
    ? [call.request_summary]
    : rawRequests.filter(isUsefulPhrase);
  const SEP = '\u2500'.repeat(18);

  const L = [];
  // Шапка: номер, время, телефон
  L.push('\u{1F514} <b>Call #' + call.number + '</b>  \u00B7  ' + formatDate(call.start_time));
  const LANG_TAG = { ro: '\u{1F1F7}\u{1F1F4} RO', ru: '\u{1F1F7}\u{1F1FA} RU' };
  L.push('\u{1F4DE} <b>' + esc(call.phone) + '</b>' + (LANG_TAG[call.lang] ? '  ·  ' + LANG_TAG[call.lang] : ''));
  if (call.needs_callback) L.push('\u26A0\uFE0F <b>CALLBACK</b>: ' + esc(call.callback_reason || 'client requested operator'));
  L.push(SEP);

  // Суть обращения — самое важное, вверх. Источник по убыванию надёжности:
  // request_summary от агента → сводка Ultravox → сырые фразы распознавания (могут быть бредом).
  // Подписи честные: толкование агента — не «слова клиента».
  if (call.request_summary) {
    L.push('\u{1F4DD} <b>REQUEST</b> <i>(agent’s note)</i>');
    L.push(esc(call.request_summary));
  }
  if (call.uv_summary) {
    if (call.request_summary) L.push('');
    L.push('\u{1F4DD} <b>CALL SUMMARY</b> <i>(Ultravox, agent’s interpretation)</i>');
    L.push(esc(call.uv_summary));
  }
  if (call.raw_transcript && rawRequests.length) {
    if (call.request_summary || call.uv_summary) L.push('');
    L.push('\u{1F399} <b>RECOGNIZED SPEECH</b> <i>(may be inaccurate)</i>');
    L.push(rawRequests.slice(0, 4).map((q) => esc(q)).join('\n'));
  } else if (!call.request_summary && !call.uv_summary) {
    L.push('\u{1F5E3} <b>CLIENT SAID</b>');
    L.push(requests.length ? requests.map((q) => esc(q)).join('\n') : '<i>nothing recorded</i>');
  }
  L.push('');

  // Итог: проблема клиента
  L.push('\u{1F50D} <b>PROBLEM</b>');
  L.push(problems.length ? problems.map((p) => '\u2022 ' + esc(p)).join('\n')
    : sysErrors.length ? '<i>not determined - check did not complete</i>'
    : (call.osmp_id ? '<i>no technical problem found</i>' : '<i>general question</i>'));
  L.push('');

  if (call.resolution) {
    L.push('\u27A1\uFE0F <b>TOLD CLIENT</b>');
    L.push(esc(call.resolution));
    L.push('');
  }

  // Ошибки нашей системы
  if (sysErrors.length) {
    L.push('\u{1F6E0} <b>SYSTEM ERRORS</b> <i>(our side)</i>');
    L.push(sysErrors.map((e) => '\u2022 ' + esc(e)).join('\n'));
    L.push('');
  }

  L.push(SEP);
  // Клиент — компактно, по строке на смысл
  L.push('\u{1F464} ' + link(whmcsClientUrl(call), esc(call.client_name))
    + (call.client_type ? '  \u00B7  ' + esc(call.client_type) : ''));
  L.push('\u{1F4B3} ' + esc(providers().CLIENT_ID_LABEL) + ' ' + esc(call.osmp_id)
    + '  \u00B7  ' + (call.is_active === false ? '\u274C inactive' : '\u2705 active')
    + '  \u00B7  ' + (call.is_paid === false ? '\u{1F4B0} debt' : '\u{1F4B0} paid'));
  L.push('\u{1F4CD} ' + esc(call.address));
  L.push('\u{1F310} ' + link(netboxIpUrl(call), esc(call.client_ip))
    + '  \u00B7  \u{1F527} ' + esc(call.mac_address));
  if (call.switch_name || call.switch_ip || call.port) {
    const parts = [];
    if (call.switch_name) parts.push(link(netboxDeviceUrl(call), esc(call.switch_name)));
    if (call.switch_ip) parts.push(esc(call.switch_ip));
    if (call.port) parts.push(esc(call.port));
    L.push('\u{1F5A7} ' + (parts.join('  \u00B7  ') || '-'));
  }

  // Диагностика — одна строка
  const portTxt = call.port_status === 'up' ? '\u2705 port up'
    : call.port_status === 'down' ? '\u274C port down' : '\u2753 port n/a';
  const macTxt = call.mac_found === true ? '\u2705 MAC found'
    : call.mac_found === false ? '\u274C MAC not found' : '\u2753 MAC n/a';
  const extra = [];
  if (call.has_power !== null) extra.push((call.has_power ? '\u2705' : '\u274C') + ' power');
  if (call.router_rebooted !== null) extra.push((call.router_rebooted ? '\u2705' : '\u274C') + ' reboot');
  L.push('\u{1F50C} ' + [portTxt, macTxt].concat(extra).join('  \u00B7  '));

  return {
    text: L.join('\n'),
    call_number: call.number,
    phone: call.phone,
    lang: call.lang,
    osmp_id: call.osmp_id,
    client_name: call.client_name,
    client_type: call.client_type,
    address: call.address,
    user_request: call.user_request,
    problems,
    system_errors: sysErrors,
    needs_callback: call.needs_callback,
    callback_reason: call.callback_reason,
  };
}

// Для журнала calls.txt и совместимости: одна строка с итогом.
function generatePossibleIssue(call) {
  const problems = generateProblems(call);
  const sysErrors = generateSystemErrors(call);
  const parts = [];
  if (problems.length) parts.push(problems.join('; '));
  if (sysErrors.length) parts.push('SYSTEM: ' + sysErrors.join('; '));
  if (!problems.length && sysErrors.length) parts.unshift('Not determined - check did not complete');
  if (!parts.length) parts.push(call.osmp_id ? 'No technical problem found' : 'General question / consultation');
  return parts.join(' | ');
}

function formatBool(value, trueText = 'Yes', falseText = 'No') {
  if (value === true) return trueText;
  if (value === false) return falseText;
  return '-';
}

function getCalls(params) {
  try {
    if (!fs.existsSync(CALLS_FILE)) {
      return { error: false, data: { calls: '', count: 0 } };
    }
    const content = fs.readFileSync(CALLS_FILE, 'utf8');
    const count = (content.match(/Call: \d+/g) || []).length;
    return {
      error: false,
      data: { content, count, active_calls: Object.keys(activeCalls).length }
    };
  } catch (err) {
    return { error: true, message: err.message };
  }
}

// Пересобрать сообщение, добавив фразы клиента из стенограммы Ultravox.
function rebuildChatbotData(callSnapshot, utterances, uvSummary) {
  const call = Object.assign({}, callSnapshot);
  if (uvSummary) call.uv_summary = uvSummary;
  const list = Array.isArray(call.user_requests) ? call.user_requests.slice() : [];
  for (const u of utterances || []) if (u && isUsefulPhrase(u) && !list.includes(u)) list.push(u);
  if ((utterances || []).length) call.raw_transcript = true;
  call.user_requests = list;
  if (!call.user_request && list.length) call.user_request = list[0];
  return formatCallForChatbot(call);
}

module.exports = {
  noteUserRequest,
  rebuildChatbotData,
  runInCall,
  bindUltravoxCall,
  startCall: {
    name: 'startCall',
    description: 'Start recording a new call',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Client phone number' },
        caller_id: { type: 'string', description: 'Client phone number' },
        channel: { type: 'string', description: 'Asterisk channel' }
      },
      required: []
    },
    execute: startCall
  },
  updateCall: {
    name: 'updateCall',
    description: 'Update current call data',
    parameters: {
      type: 'object',
      properties: {
        call_id: { type: 'string', description: 'Call ID or "latest"' },
        client_name: { type: 'string' },
        client_type: { type: 'string' },
        phone: { type: 'string' },
        osmp_id: { type: 'string' },
        client_ip: { type: 'string' },
        is_active: { type: 'boolean' },
        is_paid: { type: 'boolean' },
        mac_address: { type: 'string' },
        switch_name: { type: 'string' },
        switch_ip: { type: 'string' },
        port: { type: 'string' },
        pop: { type: 'string' },
        port_status: { type: 'string' },
        mac_found: { type: 'boolean' },
        diagnosis: { type: 'string' },
        has_power: { type: 'boolean' },
        router_rebooted: { type: 'boolean' },
        possible_issue: { type: 'string' },
        needs_callback: { type: 'boolean' },
        callback_reason: { type: 'string' },
        whmcs_error: { type: 'string' },
        netbox_error: { type: 'string' },
        diag_error: { type: 'string' }
      },
      required: []
    },
    execute: updateCall
  },
  endCall: {
    name: 'endCall',
    description: 'End call and send data to chatbot',
    parameters: {
      type: 'object',
      properties: {
        call_id: { type: 'string', description: 'Call ID or "latest"' },
        channel: { type: 'string', description: 'Asterisk channel (preferred)' }
      },
      required: []
    },
    execute: endCall
  },
  getCalls: {
    name: 'getCalls',
    description: 'Get call history',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: getCalls
  },
  // ============== NEW ==============
  checkRecentCall: {
    name: 'checkRecentCall',
    description: 'Check if there was a recent call from this phone number within specified time window',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Phone number to check' },
        within_minutes: { type: 'number', description: 'Time window in minutes (default: 60)' }
      },
      required: ['phone']
    },
    execute: checkRecentCall
  }
  // =================================
};
