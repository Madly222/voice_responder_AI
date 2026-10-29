/**
 * ultravoxTranscript.js: the second (fallback) source of the caller's phrase.
 *
 * The first source is the query parameter of the searchFAQ tool. But the agent may never call searchFAQ
 * (it answered on its own or went straight to the client ID and diagnostics), leaving nothing to show in Telegram.
 * Here we take the caller's lines from the Ultravox call transcript via their API:
 * the data is ready-made, so no LLM or extra tokens are needed.
 *
 * The call is matched by time: take the agent's recent calls and pick the one
 * that started within our call's window. The agent is chosen by call language (Asterisk menu);
 * if the language is unknown, both agents' calls are checked.
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

// Recent calls of one agent (or all agents if agentId is empty).
// Ultravox ignores ?agentId= on /calls, so /agents/{id}/calls is needed.
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
 * @param {string} startIso start of our call (ISO)
 * @param {string} endIso   end of our call (ISO)
 * @param {string} [lang]   'ro' | 'ru' from the menu; without it both agents are searched
 * @param {string} [uvCallId] Ultravox call ID if known (P-02); skips the time-based search
 * @returns {Promise<string[]>} caller's lines (may be empty)
 */
async function getUserUtterances(startIso, endIso, lang, uvCallId) {
  if (!KEY) return [];
  const headers = { 'X-API-Key': KEY, Accept: 'application/json' };
  const from = new Date(startIso).getTime() - 5 * 60 * 1000; // margin for clock skew
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
      // drop "алло", "да", client ID digits and other short confirmations
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
 * When the Ultravox call started and which agent (language) handles it, for binding to our call (P-02).
 * @returns {Promise<{created: string|null, lang: string|null}|null>} null if the API is unavailable
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
    // Ultravox writes shortSummary itself a few seconds after the call ends
    return { created: c.created || c.joined || null, lang, shortSummary: c.shortSummary || null, ended: c.ended || null };
  } catch (err) {
    console.warn('[transcript] не удалось получить звонок Ultravox:', err.code || err.message);
    return null;
  }
}

module.exports = { getUserUtterances, getCallInfo };
