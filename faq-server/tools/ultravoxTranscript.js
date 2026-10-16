/**
 * ultravoxTranscript.js — второй (резервный) источник фразы клиента.
 *
 * Первый источник — параметр query тулза searchFAQ. Но агент может не вызвать searchFAQ
 * (ответил сам, сразу пошёл к OSMP и диагностике), и тогда в Telegram нечего показать.
 * Здесь мы берём реплики клиента из стенограммы звонка в Ultravox по их же API:
 * это готовые данные, ни LLM, ни дополнительных токенов не требуется.
 *
 * Звонок сопоставляется по времени: берём последние звонки агента и выбираем тот,
 * который начался в окне нашего звонка. Агент выбирается по языку звонка (меню Asterisk);
 * если язык неизвестен — смотрим звонки обоих агентов.
 */
const axios = require('axios');

const API = (process.env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/api').replace(/\/+$/, '');
const KEY = process.env.ULTRAVOX_API_KEY;
const AGENTS = { ro: process.env.ULTRAVOX_AGENT_ID, ru: process.env.ULTRAVOX_AGENT_ID_RU };
const MAX_UTTERANCES = Number(process.env.TRANSCRIPT_MAX_UTTERANCES || 4);
const TIMEOUT = Number(process.env.ULTRAVOX_TIMEOUT_MS) || 8000;

function isUser(role) {
  return typeof role === 'string' && role.toUpperCase().includes('USER');
}

function pickText(m) {
  return (m && (m.text || m.content || m.message) || '').toString().trim();
}

// Последние звонки одного агента (или всех, если agentId пуст).
// Параметр ?agentId= у /calls Ultravox игнорирует — нужен /agents/{id}/calls.
async function listCalls(headers, agentId) {
  const url = agentId ? `${API}/agents/${agentId}/calls` : `${API}/calls`;
  const list = await axios.get(url, {
    headers, timeout: TIMEOUT, validateStatus: () => true, params: { pageSize: 10 },
  });
  if (list.status !== 200) {
    console.warn('[transcript] список звонков: HTTP', list.status);
    return [];
  }
  const calls = list.data && (list.data.results || list.data.calls || []);
  return Array.isArray(calls) ? calls : [];
}

function callTime(c) {
  return new Date(c.created || c.startTime || c.joined || 0).getTime();
}

/**
 * @param {string} startIso начало нашего звонка (ISO)
 * @param {string} endIso   конец нашего звонка (ISO)
 * @param {string} [lang]   'ro' | 'ru' — язык из меню; без него ищем у обоих агентов
 * @param {string} [uvCallId] ID звонка Ultravox, если известен (P-02) — тогда без поиска по времени
 * @returns {Promise<string[]>} реплики клиента (может быть пустым)
 */
async function getUserUtterances(startIso, endIso, lang, uvCallId) {
  if (!KEY) return [];
  const headers = { 'X-API-Key': KEY, Accept: 'application/json' };
  const from = new Date(startIso).getTime() - 5 * 60 * 1000; // запас на расхождение часов
  const to = new Date(endIso || Date.now()).getTime() + 5 * 60 * 1000;

  try {
    let callId = uvCallId;
    if (!callId) {
      const ids = AGENTS[lang] ? [AGENTS[lang]] : [...new Set(Object.values(AGENTS).filter(Boolean))];
      const lists = await Promise.all((ids.length ? ids : [null]).map((id) => listCalls(headers, id)));
      const calls = lists.flat().sort((a, b) => callTime(b) - callTime(a));
      if (!calls.length) return [];

      const inWindow = calls.filter((c) => {
        const t = callTime(c);
        return t >= from && t <= to;
      });
      const call = (inWindow.length ? inWindow : calls)[0];
      callId = call && (call.callId || call.id);
    }
    if (!callId) return [];

    const msgs = await axios.get(`${API}/calls/${callId}/messages`, {
      headers, timeout: TIMEOUT, validateStatus: () => true, params: { pageSize: 100 },
    });
    if (msgs.status !== 200) {
      console.warn('[transcript] сообщения звонка: HTTP', msgs.status);
      return [];
    }
    const items = msgs.data && (msgs.data.results || msgs.data.messages || []);
    if (!Array.isArray(items)) return [];

    const out = [];
    for (const m of items) {
      if (!isUser(m.role)) continue;
      const t = pickText(m).slice(0, 300);
      // отбрасываем «алло», «да», цифры OSMP и прочие короткие подтверждения
      if (t.length < 8 || /^[\d\s+()-]+$/.test(t)) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= MAX_UTTERANCES) break;
    }
    return out;
  } catch (err) {
    console.warn('[transcript] не удалось получить стенограмму:', err.code || err.message);
    return [];
  }
}

/**
 * Когда начался звонок Ultravox и какой агент (язык) его ведёт — для привязки к нашему звонку (P-02).
 * @returns {Promise<{created: string|null, lang: string|null}|null>} null — API недоступен
 */
async function getCallInfo(uvCallId) {
  if (!KEY || !uvCallId) return null;
  try {
    const r = await axios.get(`${API}/calls/${encodeURIComponent(uvCallId)}`, {
      headers: { 'X-API-Key': KEY, Accept: 'application/json' },
      timeout: 3000, validateStatus: () => true,
    });
    if (r.status !== 200 || !r.data) {
      console.warn('[transcript] звонок Ultravox: HTTP', r.status);
      return null;
    }
    const c = r.data;
    const agentId = c.agentId || (c.agent && (c.agent.agentId || c.agent.id)) || null;
    const lang = Object.keys(AGENTS).find((k) => AGENTS[k] && AGENTS[k] === agentId) || null;
    // shortSummary Ultravox пишет сам через несколько секунд после конца звонка
    return { created: c.created || c.joined || null, lang, shortSummary: c.shortSummary || null, ended: c.ended || null };
  } catch (err) {
    console.warn('[transcript] не удалось получить звонок Ultravox:', err.code || err.message);
    return null;
  }
}

module.exports = { getUserUtterances, getCallInfo };
