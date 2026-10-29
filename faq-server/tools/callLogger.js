const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const transcript = require('./ultravoxTranscript');

const CALLS_FILE = path.join(__dirname, '../data/calls.txt');

let activeCalls = {};
let callCounter = 0;
// Caller phrases that arrived before startCall (the agent may call searchFAQ first).
let pendingRequests = [];

// P-02: which call the current tool request belongs to.
// server.js stores { uvCallId, callId } here for the duration of a request; every 'latest' inside
// the tools (findByClientId, getNetworkData, diagnoseClient, updateCall) writes to that call.
const callContext = new AsyncLocalStorage();

function runInCall(ctx, fn) {
  return callContext.run(ctx, fn);
}

// 'latest' / empty -> the current request's call; without context (Asterisk, Test tool) the last open call.
function resolveCallId(call_id) {
  if (call_id && call_id !== 'latest') return activeCalls[call_id] ? call_id : null;
  const ctx = callContext.getStore();
  if (ctx && ctx.uvCallId) {
    // Ultravox call is known: write only to its own call, otherwise nowhere
    return ctx.callId && activeCalls[ctx.callId] ? ctx.callId : null;
  }
  const keys = Object.keys(activeCalls);
  return keys.length ? keys[keys.length - 1] : null;
}

// Picks our call for a new Ultravox call when several are unbound:
// same language (agent) and the closest start time.
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

// Bindings run one at a time so two calls cannot claim the same call.
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

// Report times use the company time zone (the container runs in UTC; P-24). DST is handled automatically.
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
    channel: params.channel || null,  // Asterisk channel: lets endCall close exactly this call
    uv_call_id: null,                 // Ultravox call ID (bound on the first tool call)
    lang: ['ro', 'ru'].includes(params.lang) ? params.lang : null,  // from the Asterisk menu
    client_name: null,
    client_type: null,
    client_number: null,     // client ID given by the caller
    client_ip: null,
    address: null,
    client_id: null,          // WHMCS client id (for the link)
    netbox_ip_id: null,       // NetBox IP record id (for the link)
    netbox_device_id: null,   // NetBox device id (for the link)
    request_summary: null,     // one-sentence request summary (sent by the agent via updateCall)
    resolution: null,          // what the agent told / advised the client
    user_request: null,        // what the client said (first searchFAQ query)
    user_requests: [],         // all client queries during the call
    faq_matched: [],           // which FAQ entries matched
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
    'client_number', 'client_ip', 'address', 'is_active', 'is_paid',
    'user_request', 'request_summary', 'resolution', 'client_id', 'netbox_ip_id', 'netbox_device_id',
    'mac_address', 'switch_name', 'switch_ip', 'port', 'pop',
    'port_status', 'mac_found', 'diagnosis',
    'has_power', 'router_rebooted',
    'possible_issue',
    'needs_callback', 'callback_reason',
    'whmcs_error', 'netbox_error', 'diag_error'
  ];

  if (params.client_number === undefined && params.osmp_id !== undefined) params.client_number = params.osmp_id;  // pre-rename agents

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

// Stores the caller's phrase: Ultravox sends it to searchFAQ as query.
// It is verbatim what the client said, so no LLM or extra requests are needed.
function noteUserRequest(query, faqId) {
  if (!query) return false;
  if (!Object.keys(activeCalls).length) {
    // call has not started yet: hold the phrase, startCall will pick it up
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
  // Asterisk sends its channel: close exactly that call, not the last open one.
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
  // call snapshot, so the text can be rebuilt if the caller's phrase arrives later from the transcript
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

function checkRecentCall(params) {
  const { phone, within_minutes = 60 } = params;
  
  if (!phone) {
    return { error: true, message: 'Phone number required' };
  }
  
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

function formatCallForFile(call) {
  let entry = `Call: ${call.number}\n`;
  entry += `Date: ${formatDate(call.start_time)}\n`;
  if (call.needs_callback) {
    entry += `    CALLBACK NEEDED: YES\n`;
    entry += `    Callback reason: ${call.callback_reason || 'Client requested operator'}\n`;
  }
  entry += `    Phone: ${call.phone || '-'}\n`;
  entry += `    Lang: ${call.lang || '-'}\n`;
  entry += `    ${providers().CLIENT_ID_LABEL}: ${call.client_number || '-'}\n`;
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

// Billing and network inventory links are built by the adapters (providers.js); templates can be set in .env.
// require inside the functions because providers.js itself requires this module.
const providers = () => require('./providers');

function link(url, text) {
  return url ? '<a href="' + url + '">' + text + '</a>' : text;
}

const whmcsClientUrl = (call) => providers().clientUrl(call);
const netboxIpUrl = (call) => providers().ipUrl(call);
const netboxDeviceUrl = (call) => providers().deviceUrl(call);

// Filters out confirmations and dictated digits: "Da", "Da, 1-9-6-1-6", "алло".
const JUNK_RE = /^(da|nu|ok|bine|alo|salut|corect|mul[tț]umesc|multumesc|bun[aă]|да|нет|ага|алло|хорошо|спасибо|ясно)[\s.,!?-]*$/i;

function isUsefulPhrase(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return false;
  if (JUNK_RE.test(t)) return false;
  // strip digits and punctuation: if hardly any letters are left, it was a dictated code
  const letters = t.replace(/[\d\s.,!?:;()\/-]/g, '');
  if (letters.length < 12) return false;
  // fragments like "la internet." have too few words to mean anything
  const words = t.split(/\s+/).filter((w) => /[a-z\u00e0-\u024f\u0400-\u04ff]{2,}/i.test(w));
  if (words.length < 4) return false;
  // "Da, e corect", "Da, 1-9-6-1-6": a confirmation word followed by almost nothing
  const rest = t.replace(/^(da|nu|ok|bine|да|нет)[\s,.]+/i, '');
  if (rest !== t && rest.replace(/[\d\s.,!?:;()\/-]/g, '').length < 10) return false;
  return true;
}

function esc(v) {
  return String(v == null ? '-' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// CLIENT problems: anything that actually keeps them from using the service.
// Debt is NOT included: we do not cut service immediately for non-payment.
// Billing answered but has no client with this number: not a failure on our side,
// the number was given wrong or misheard.
const clientNotFound = (call) => !!(call.client_number && !call.client_name && !call.whmcs_error);

function generateProblems(call) {
  const out = [];
  if (clientNotFound(call)) {
    out.push(`${providers().CLIENT_ID_LABEL} ${call.client_number} not found in billing - wrong code given or misheard, client not identified`);
  }
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

// Errors in OUR system: not the client's problem but something for us to fix.
function generateSystemErrors(call) {
  const out = [];
  if (call.whmcs_error) out.push(providers().billingLabel() + ': ' + call.whmcs_error);
  if (call.netbox_error) out.push(providers().networkLabel() + ': ' + call.netbox_error);
  if (call.diag_error) out.push('Diagnostics: ' + call.diag_error);
  if (call.client_ip && !call.mac_address && !call.switch_ip)
    out.push(`${providers().networkLabel()}: IP ${call.client_ip} has no switch/port data`);
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
  // Header: number, time, phone
  L.push('\u{1F514} <b>Call #' + call.number + '</b>  \u00B7  ' + formatDate(call.start_time));
  const LANG_TAG = { ro: '\u{1F1F7}\u{1F1F4} RO', ru: '\u{1F1F7}\u{1F1FA} RU' };
  L.push('\u{1F4DE} <b>' + esc(call.phone) + '</b>' + (LANG_TAG[call.lang] ? '  ·  ' + LANG_TAG[call.lang] : ''));
  if (call.needs_callback) L.push('\u26A0\uFE0F <b>CALLBACK</b>: ' + esc(call.callback_reason || 'client requested operator'));
  L.push(SEP);

  // The request summary matters most, so it goes on top. Sources by decreasing reliability:
  // agent's request_summary -> Ultravox summary -> raw recognised phrases (may be garbage).
  // Labels stay honest: the agent's interpretation is not "the client's words".
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

  L.push('\u{1F50D} <b>PROBLEM</b>');
  L.push(problems.length ? problems.map((p) => '\u2022 ' + esc(p)).join('\n')
    : sysErrors.length ? '<i>not determined - check did not complete</i>'
    : (call.client_number ? '<i>no technical problem found</i>' : '<i>general question</i>'));
  L.push('');

  if (call.resolution) {
    L.push('\u27A1\uFE0F <b>TOLD CLIENT</b>');
    L.push(esc(call.resolution));
    L.push('');
  }

  if (sysErrors.length) {
    L.push('\u{1F6E0} <b>SYSTEM ERRORS</b> <i>(our side)</i>');
    L.push(sysErrors.map((e) => '\u2022 ' + esc(e)).join('\n'));
    L.push('');
  }

  L.push(SEP);
  // Client: compact, one line per fact. Unknown is shown as n/a, never as OK;
  // empty lines (address, network, diagnostics) are skipped.
  const idLabel = esc(providers().CLIENT_ID_LABEL);
  if (!call.client_name) {
    L.push('\u{1F464} <i>client not identified</i>');
    L.push('\u{1F4B3} ' + (call.client_number
      ? idLabel + ' ' + esc(call.client_number) + '  ·  '
        + (clientNotFound(call) ? '❌ not found in billing' : '❔ billing check failed')
      : idLabel + ' <i>not given</i>'));
  } else {
    L.push('\u{1F464} ' + link(whmcsClientUrl(call), esc(call.client_name))
      + (call.client_type ? '  ·  ' + esc(call.client_type) : ''));
    const active = call.is_active === true ? '✅ active'
      : call.is_active === false ? '❌ inactive' : '❔ status n/a';
    const paid = call.is_paid === true ? '\u{1F4B0} paid'
      : call.is_paid === false ? '❗ debt' : '❔ payment n/a';
    L.push('\u{1F4B3} ' + idLabel + ' ' + esc(call.client_number) + '  ·  ' + active + '  ·  ' + paid);
    if (call.address) L.push('\u{1F4CD} ' + esc(call.address));
  }
  if (call.client_ip || call.mac_address) {
    L.push('\u{1F310} ' + link(netboxIpUrl(call), esc(call.client_ip))
      + '  ·  \u{1F527} ' + esc(call.mac_address));
  }
  if (call.switch_name || call.switch_ip || call.port) {
    const parts = [];
    if (call.switch_name) parts.push(link(netboxDeviceUrl(call), esc(call.switch_name)));
    if (call.switch_ip) parts.push(esc(call.switch_ip));
    if (call.port) parts.push(esc(call.port));
    L.push('\u{1F5A7} ' + (parts.join('  \u00B7  ') || '-'));
  }

  // Only when the line check was actually reached
  const diagTried = call.switch_ip || call.mac_address || call.port_status != null
    || call.mac_found != null || call.diag_error || call.has_power != null || call.router_rebooted != null;
  if (diagTried) {
  const portTxt = call.port_status === 'up' ? '\u2705 port up'
    : call.port_status === 'down' ? '\u274C port down' : '\u2753 port n/a';
  const macTxt = call.mac_found === true ? '\u2705 MAC found'
    : call.mac_found === false ? '\u274C MAC not found' : '\u2753 MAC n/a';
  const extra = [];
  if (call.has_power != null) extra.push((call.has_power ? '\u2705' : '\u274C') + ' power');
  if (call.router_rebooted != null) extra.push((call.router_rebooted ? '\u2705' : '\u274C') + ' reboot');
  L.push('\u{1F50C} ' + [portTxt, macTxt].concat(extra).join('  \u00B7  '));
  }

  return {
    text: L.join('\n'),
    call_number: call.number,
    phone: call.phone,
    lang: call.lang,
    client_number: call.client_number,
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

// One-line summary for the calls.txt log and backwards compatibility.
function generatePossibleIssue(call) {
  const problems = generateProblems(call);
  const sysErrors = generateSystemErrors(call);
  const parts = [];
  if (problems.length) parts.push(problems.join('; '));
  if (sysErrors.length) parts.push('SYSTEM: ' + sysErrors.join('; '));
  if (!problems.length && sysErrors.length) parts.unshift('Not determined - check did not complete');
  if (!parts.length) parts.push(call.client_number ? 'No technical problem found' : 'General question / consultation');
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

// Rebuild the message with the caller's phrases from the Ultravox transcript.
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
        client_number: { type: 'string' },
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
};
