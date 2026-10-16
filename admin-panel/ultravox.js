'use strict';
// Агенты Ultravox из панели: чтение, правка, история и откат.
// Живая конфигурация — в Ultravox; перед каждой записью панель сохраняет копию агента
// в рабочую папку установки (вне git): <PROJECT_DIR>/instance/ultravox/history/<lang>/.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Языки = агенты. ID агентов — в .env.
const LANGS = [
  { lang: 'ro', label: 'Румынский (RO)', envKey: 'ULTRAVOX_AGENT_ID' },
  { lang: 'ru', label: 'Русский (RU)', envKey: 'ULTRAVOX_AGENT_ID_RU' },
];
const HISTORY_KEEP = 50;
const PROJECT_DIR = process.env.PROJECT_DIR || '/project';
const INSTANCE_DIR = process.env.INSTANCE_DIR || path.join(PROJECT_DIR, 'instance');
const HISTORY_DIR = path.join(INSTANCE_DIR, 'ultravox', 'history');

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function client(env) {
  if (!env.ULTRAVOX_API_KEY) throw httpErr(400, 'ULTRAVOX_API_KEY не задан в .env');
  const base = (env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/api').replace(/\/+$/, '');
  return async (method, url, data) => {
    const r = await axios({ method, url: base + url, data, timeout: 20000, validateStatus: () => true,
      headers: { 'X-API-Key': env.ULTRAVOX_API_KEY, 'Content-Type': 'application/json' } });
    if (r.status >= 400) {
      const body = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data);
      throw httpErr(502, `Ultravox ответил HTTP ${r.status}: ${body.slice(0, 400)}`);
    }
    return r.data;
  };
}

function langInfo(env, lang) {
  const l = LANGS.find((x) => x.lang === lang);
  if (!l) throw httpErr(404, 'нет такого языка: ' + lang);
  const agentId = env[l.envKey];
  if (!agentId) throw httpErr(400, `${l.envKey} не задан в .env`);
  return { ...l, agentId };
}

const agentOf = (ct) => (ct.firstSpeakerSettings && ct.firstSpeakerSettings.agent) || {};
function setAgentSpeaker(ct, patch) {
  ct.firstSpeakerSettings = { ...(ct.firstSpeakerSettings || {}), agent: { ...agentOf(ct), ...patch } };
}

// Редактируемые поля: как читать из агента и как записать в callTemplate.
const FIELDS = {
  name:                    { get: (a) => a.name || '' },
  systemPrompt:            { get: (a, ct) => ct.systemPrompt || '', set: (ct, v) => { ct.systemPrompt = v; } },
  voice:                   { get: (a, ct) => ct.voice || '', set: (ct, v) => { ct.voice = v; } },
  model:                   { get: (a, ct) => ct.model || '', set: (ct, v) => { ct.model = v; } },
  languageHint:            { get: (a, ct) => ct.languageHint || '', set: (ct, v) => { ct.languageHint = v; } },
  maxDuration:             { get: (a, ct) => ct.maxDuration || '', set: (ct, v) => { ct.maxDuration = v; } },
  greeting:                { get: (a, ct) => agentOf(ct).text || '', set: (ct, v) => setAgentSpeaker(ct, { text: v }) },
  greetingUninterruptible: { get: (a, ct) => !!agentOf(ct).uninterruptible, set: (ct, v) => setAgentSpeaker(ct, { uninterruptible: !!v }) },
  inactivityMessages: {
    get: (a, ct) => (ct.inactivityMessages || []).map((m) => ({
      duration: m.duration || '', message: m.message || '', endBehavior: m.endBehavior || '' })),
    set: (ct, v) => {
      ct.inactivityMessages = v.map((m) => {
        const o = { duration: m.duration, message: m.message };
        if (m.endBehavior) o.endBehavior = m.endBehavior;
        return o;
      });
    },
  },
  vadSettings: { get: (a, ct) => ({ ...(ct.vadSettings || {}) }), set: (ct, v) => { ct.vadSettings = v; } },
};
const END_BEHAVIORS = ['', 'END_BEHAVIOR_HANG_UP_SOFT', 'END_BEHAVIOR_HANG_UP_STRICT'];
const DUR = /^\d+(\.\d+)?s$/;

function viewOf(agent) {
  const ct = agent.callTemplate || {};
  const fields = {};
  for (const [k, f] of Object.entries(FIELDS)) fields[k] = f.get(agent, ct);
  return fields;
}

function validate(c, models) {
  const errors = {};
  if ('name' in c && !/^[A-Za-z0-9_-]{1,64}$/.test(c.name)) errors.name = 'латиница, цифры, _ и -, до 64 символов';
  if ('systemPrompt' in c && !String(c.systemPrompt).trim()) errors.systemPrompt = 'промпт не может быть пустым';
  if ('model' in c && models.length && !models.includes(c.model)) errors.model = 'допустимо: ' + models.join(', ');
  if ('maxDuration' in c && !DUR.test(c.maxDuration)) errors.maxDuration = 'в секундах, напр. 300s';
  if ('languageHint' in c && !/^[a-z]{2}(-[A-Z]{2})?$/.test(c.languageHint)) errors.languageHint = 'код языка, напр. ro или ru';
  if ('voice' in c && !String(c.voice).trim()) errors.voice = 'выберите голос';
  if ('inactivityMessages' in c) {
    const list = c.inactivityMessages;
    if (!Array.isArray(list)) errors.inactivityMessages = 'ожидается список';
    else list.forEach((m, i) => {
      if (!DUR.test(m.duration || '')) errors.inactivityMessages = `сообщение ${i + 1}: время в секундах, напр. 45s`;
      else if (!String(m.message || '').trim()) errors.inactivityMessages = `сообщение ${i + 1}: пустой текст`;
      else if (!END_BEHAVIORS.includes(m.endBehavior || '')) errors.inactivityMessages = `сообщение ${i + 1}: неизвестное действие`;
    });
  }
  if ('vadSettings' in c) {
    const v = c.vadSettings || {};
    for (const k of ['turnEndpointDelay', 'minimumTurnDuration', 'minimumInterruptionDuration'])
      if (v[k] !== undefined && !DUR.test(v[k])) errors.vadSettings = `${k}: в секундах, напр. 0.500s`;
    if (v.frameActivationThreshold !== undefined
      && !(Number(v.frameActivationThreshold) >= 0 && Number(v.frameActivationThreshold) <= 1))
      errors.vadSettings = 'frameActivationThreshold: число от 0 до 1';
  }
  return errors;
}

// Пустые значения VAD не шлём (значение Ultravox по умолчанию), порог — числом.
function normalize(changes) {
  const c = {};
  for (const [k, v] of Object.entries(changes || {})) if (k in FIELDS) c[k] = v;
  if (c.vadSettings) {
    const v = {};
    for (const [k, val] of Object.entries(c.vadSettings)) {
      if (val === '' || val == null) continue;
      v[k] = k === 'frameActivationThreshold' ? Number(val) : String(val).trim();
    }
    c.vadSettings = v;
  }
  if (c.inactivityMessages) {
    c.inactivityMessages = c.inactivityMessages.map((m) => ({
      duration: String(m.duration || '').trim(), message: String(m.message || '').trim(), endBehavior: m.endBehavior || '' }));
  }
  for (const k of ['name', 'voice', 'model', 'languageHint', 'maxDuration']) if (k in c) c[k] = String(c[k]).trim();
  if ('greetingUninterruptible' in c) c.greetingUninterruptible = !!c.greetingUninterruptible;
  return c;
}

// Только реально изменённые поля.
function diff(before, changes) {
  const out = {};
  for (const [k, v] of Object.entries(changes)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) out[k] = v;
  return out;
}

// Панель работает от root — файлы и папки истории отдаём владельцу папки проекта.
function chownToProjectOwner(p) {
  try {
    const st = fs.statSync(PROJECT_DIR);
    for (let d = p; d.startsWith(INSTANCE_DIR); d = path.dirname(d)) fs.chownSync(d, st.uid, st.gid);
  } catch (_) {}
}

function saveHistory(lang, agent, tag) {
  const dir = path.join(HISTORY_DIR, lang);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${stamp}-${tag}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(agent, null, 2), { mode: 0o600 });
  chownToProjectOwner(path.join(dir, file));
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) fs.unlinkSync(path.join(dir, f));
  return file;
}

let modelsCache = { at: 0, list: [] };
let voicesCache = { at: 0, list: [] };
const HOUR = 3600 * 1000;

async function models(env) {
  if (Date.now() - modelsCache.at < HOUR && modelsCache.list.length) return modelsCache.list;
  const d = await client(env)('get', '/models');
  const list = (d.results || []).map((m) => m.name).filter(Boolean);
  modelsCache = { at: Date.now(), list };
  return list;
}

async function voices(env) {
  if (Date.now() - voicesCache.at < HOUR && voicesCache.list.length) return voicesCache.list;
  const uv = client(env);
  const list = [];
  let url = '/voices?pageSize=200';
  for (let i = 0; i < 20 && url; i++) {
    const d = await uv('get', url);
    for (const v of d.results || []) list.push({
      voiceId: v.voiceId, name: v.name, language: v.primaryLanguage || '', languageLabel: v.languageLabel || '',
      provider: v.provider || '', description: (v.description || '').slice(0, 160),
      // EXTERNAL — голос требует свой ключ провайдера (ElevenLabs и т.п.) в аккаунте Ultravox
      external: v.billingStyle === 'VOICE_BILLING_STYLE_EXTERNAL',
      // образцы с API Ultravox требуют ключ — отдаём через панель; прочие (публичные) — как есть
      previewUrl: !v.previewUrl ? '' : (isUltravoxUrl(env, v.previewUrl) ? `/api/ultravox/voices/${v.voiceId}/preview` : v.previewUrl),
      _preview: v.previewUrl || '',
    });
    const cursor = d.next ? new URL(d.next).searchParams.get('cursor') : null;
    url = cursor ? '/voices?pageSize=200&cursor=' + encodeURIComponent(cursor) : null;
  }
  voicesCache = { at: Date.now(), list };
  return list;
}

function isUltravoxUrl(env, u) {
  try {
    const base = new URL(env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/api');
    return new URL(u).host === base.host;
  } catch (_) { return false; }
}

// Образец голоса с API Ultravox: ключ уходит только на хост API Ultravox.
async function voicePreview(env, voiceId) {
  const v = (await voices(env)).find((x) => x.voiceId === voiceId);
  if (!v || !v._preview) throw httpErr(404, 'нет образца');
  if (!isUltravoxUrl(env, v._preview)) throw httpErr(400, 'образец не на Ultravox');
  const r = await axios.get(v._preview, { responseType: 'stream', timeout: 20000, maxRedirects: 0,
    headers: { 'X-API-Key': env.ULTRAVOX_API_KEY }, validateStatus: () => true });
  if (r.status >= 300 && r.status < 400 && r.headers.location) return { redirect: r.headers.location };
  if (r.status >= 400) throw httpErr(502, 'Ultravox ответил HTTP ' + r.status);
  return { stream: r.data, type: r.headers['content-type'] || 'audio/mpeg' };
}

async function listAgents(env) {
  const uv = client(env);
  const out = [];
  for (const l of LANGS) {
    const agentId = env[l.envKey];
    if (!agentId) { out.push({ lang: l.lang, label: l.label, envKey: l.envKey, error: `${l.envKey} не задан в .env` }); continue; }
    try {
      const a = await uv('get', '/agents/' + agentId);
      out.push({ lang: l.lang, label: l.label, envKey: l.envKey, agentId, calls: (a.statistics || {}).calls,
        fields: viewOf(a), tools: ((a.callTemplate || {}).selectedTools || []).map((t) => t.toolId) });
    } catch (e) { out.push({ lang: l.lang, label: l.label, envKey: l.envKey, agentId, error: e.message }); }
  }
  try {
    const t = await uv('get', '/tools?pageSize=100');
    const names = new Map((t.results || []).map((x) => [x.toolId, x.name]));
    out.forEach((a) => { if (a.tools) a.tools = a.tools.map((id) => ({ toolId: id, name: names.get(id) || id })); });
  } catch (_) { /* без имён тулзов — покажем id */ }
  return out;
}

function describeChange(k, a, b) {
  if (k === 'systemPrompt') {
    const al = String(a).split('\n'), bl = String(b).split('\n');
    const setA = new Set(al), setB = new Set(bl);
    const removed = al.filter((x) => !setB.has(x)).length, added = bl.filter((x) => !setA.has(x)).length;
    return { field: k, text: `строк ${al.length} → ${bl.length} (новых ${added}, убрано ${removed}), символов ${String(a).length} → ${String(b).length}` };
  }
  const s = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { field: k, before: s(a), after: s(b) };
}

// Применить изменения к агенту: копия «до» → PATCH всего callTemplate → проверка → копия «после».
async function apply(env, lang, rawChanges, { dryRun = false } = {}) {
  const info = langInfo(env, lang);
  const uv = client(env);
  const agent = await uv('get', '/agents/' + info.agentId);
  const before = viewOf(agent);
  const changes = diff(before, normalize(rawChanges));
  const errors = validate(changes, await models(env).catch(() => []));
  if (Object.keys(errors).length) { const e = httpErr(400, 'есть ошибки в значениях'); e.errors = errors; throw e; }
  const summary = Object.keys(changes).map((k) => describeChange(k, before[k], changes[k]));
  if (dryRun || !summary.length) return { changed: Object.keys(changes), summary };

  const backup = saveHistory(lang, agent, 'before');
  const ct = JSON.parse(JSON.stringify(agent.callTemplate || {}));
  delete ct.created; delete ct.updated;
  for (const [k, v] of Object.entries(changes)) if (FIELDS[k].set) FIELDS[k].set(ct, v);
  const body = { callTemplate: ct };
  if ('name' in changes) body.name = changes.name;
  await uv('patch', '/agents/' + info.agentId, body);

  const after = await uv('get', '/agents/' + info.agentId);
  const now = viewOf(after);
  const mismatch = Object.keys(changes).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(changes[k]));
  const untouched = Object.keys(before).filter((k) => !(k in changes) && JSON.stringify(now[k]) !== JSON.stringify(before[k]));
  saveHistory(lang, after, 'after');
  console.log(`[ultravox] ${lang}: изменены ${Object.keys(changes).join(', ')}; копия ${backup}`
    + (mismatch.length ? `; НЕ СОВПАЛО: ${mismatch.join(', ')}` : '')
    + (untouched.length ? `; ИЗМЕНИЛИСЬ ЛИШНИЕ: ${untouched.join(', ')}` : ''));
  return { changed: Object.keys(changes), summary, backup, mismatch, untouched };
}

function historyFile(lang, file) {
  if (!LANGS.some((l) => l.lang === lang)) throw httpErr(404, 'нет такого языка');
  if (!/^[\w.-]+\.json$/.test(file || '')) throw httpErr(400, 'неверное имя файла');
  const p = path.join(HISTORY_DIR, lang, file);
  if (!fs.existsSync(p)) throw httpErr(404, 'копия не найдена');
  return p;
}

function history(lang) {
  const dir = path.join(HISTORY_DIR, lang);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
}

function readHistory(lang, file) {
  return viewOf(JSON.parse(fs.readFileSync(historyFile(lang, file), 'utf8')));
}

// Откат: поля из копии применяются как обычная правка (со своей копией «до»).
async function restore(env, lang, file, opts) {
  return apply(env, lang, readHistory(lang, file), opts);
}

// ---- Создание агента из образца (первый запуск) ----
// Агент создаётся в аккаунте Ultravox, которому принадлежит ULTRAVOX_API_KEY (оплата — там же).
// Промпт — ultravox/prompts/<lang>.md с подстановкой {COMPANY_NAME}; остальное — значения по умолчанию,
// их потом можно поменять на вкладке. Тулзы подключает «Синхронизировать» (ultravoxTools.js).
const SAMPLE = {
  ro: {
    greeting: 'Bună ziua, vă salută asistentul virtual {COMPANY_NAME}, un sistem de inteligență artificială. Cu ce vă pot ajuta?',
    inactivity: [
      { duration: '45s', message: 'Vă mai pot ajuta cu ceva?' },
      { duration: '120s', message: 'Se pare că nu vă mai aud. Vă mulțumesc pentru apel. O zi bună!', endBehavior: 'END_BEHAVIOR_HANG_UP_SOFT' },
    ],
  },
  ru: {
    greeting: 'Здравствуйте, вас приветствует виртуальный помощник {COMPANY_NAME} — это система искусственного интеллекта. Чем могу помочь?',
    inactivity: [
      { duration: '45s', message: 'Могу чем-то помочь?' },
      { duration: '120s', message: 'Похоже, вас не слышно. Спасибо за звонок. Хорошего дня!', endBehavior: 'END_BEHAVIOR_HANG_UP_SOFT' },
    ],
  },
};
const PREFERRED_MODEL = 'ultravox-v0.7';

async function createAgent(env, lang, { name, writeEnv } = {}) {
  const l = LANGS.find((x) => x.lang === lang);
  if (!l) throw httpErr(404, 'нет такого языка: ' + lang);
  if (writeEnv && env[l.envKey]) throw httpErr(409, `${l.envKey} уже задан — агент есть. Чтобы создать новый, сначала очистите ${l.envKey}`);
  const promptPath = path.join(PROJECT_DIR, 'ultravox', 'prompts', `${lang}.md`);
  if (!fs.existsSync(promptPath)) throw httpErr(400, `нет образца промпта ultravox/prompts/${lang}.md`);
  const company = env.COMPANY_NAME || 'our company';
  const fill = (s) => String(s).replace(/\{COMPANY_NAME\}/g, company);

  const list = await models(env).catch(() => []);
  const model = list.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : (list[list.length - 1] || PREFERRED_MODEL);
  // только голоса, включённые в оплату Ultravox (для «внешних» нужен свой ключ провайдера)
  const voice = (await voices(env)).find((v) => !v.external && (v.language || '').toLowerCase().startsWith(lang));
  if (!voice) throw httpErr(400, `в Ultravox не нашлось голоса для языка ${lang}, включённого в оплату`);
  const agentName = name || ((company.replace(/[^A-Za-z0-9]/g, '') || 'Support') + lang.toUpperCase()).slice(0, 64);

  const sample = SAMPLE[lang];
  const created = await client(env)('post', '/agents', {
    name: agentName,
    callTemplate: {
      systemPrompt: fill(fs.readFileSync(promptPath, 'utf8').trim()),
      model,
      voice: voice.voiceId,
      languageHint: lang,
      maxDuration: '300s',
      firstSpeakerSettings: { agent: { uninterruptible: true, text: fill(sample.greeting) } },
      inactivityMessages: sample.inactivity,
    },
  });
  const agentId = created.agentId;
  if (!agentId) throw httpErr(502, 'Ultravox не вернул ID агента');
  saveHistory(lang, created, 'created');
  console.log(`[ultravox] создан агент ${agentName} (${lang}) ${agentId}`);
  return { agentId, name: agentName, envKey: l.envKey, model, voice: voice.name };
}

async function deleteAgent(env, agentId) {
  await client(env)('delete', '/agents/' + encodeURIComponent(agentId));
}

module.exports = {
  LANGS, END_BEHAVIORS, listAgents, apply, history, readHistory, restore, voices, models, voicePreview,
  createAgent, deleteAgent,
  // для ultravoxTools.js
  client, httpErr, chownToProjectOwner, PROJECT_DIR, INSTANCE_DIR, HISTORY_DIR,
};
