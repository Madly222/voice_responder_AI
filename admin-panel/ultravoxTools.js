'use strict';
// Our Ultravox tools from the panel: comparison with templates, per-installation edits, sync.
//
// Templates are ultravox/tools.json (in git). Per-installation edits (description, timeout) are
// instance/ultravox/tools.json (outside git) on top of the template. Together they define the target state:
//   URL    = TOOLS_PUBLIC_URL + path,  X-AVR-Key = TOOLS_API_KEY,
//   uv_call_id = Ultravox call ID (automatic parameter, P-02),
//   {COMPANY_NAME} {CLIENT_ID_LABEL} {CLIENT_ID_FORMAT} from .env.
// A tool with requires: billing | network is attached to agents only if that feature is enabled.
const fs = require('fs');
const path = require('path');
const uvx = require('./ultravox');

const TEMPLATE_PATH = path.join(uvx.PROJECT_DIR, 'ultravox', 'tools.json');
const OVERRIDES_PATH = path.join(uvx.INSTANCE_DIR, 'ultravox', 'tools.json');
const TOOLS_HISTORY = path.join(uvx.HISTORY_DIR, 'tools');
const KEY_HEADER = 'X-AVR-Key';
const CALL_ID_PARAM = 'uv_call_id';
const DUR = /^\d+(\.\d+)?s$/;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
const templates = () => (readJson(TEMPLATE_PATH, { tools: [] }).tools || []);
const overrides = () => readJson(OVERRIDES_PATH, {});

function enabledFeature(env, requires) {
  if (requires === 'billing') return !['', 'none'].includes(String(env.BILLING_PROVIDER || '').toLowerCase());
  if (requires === 'network') return !['', 'none'].includes(String(env.NETWORK_SOURCE || '').toLowerCase());
  return true;
}

function fill(text, env) {
  const vals = {
    COMPANY_NAME: env.COMPANY_NAME || 'our company',
    CLIENT_ID_LABEL: env.CLIENT_ID_LABEL || 'OSMP',
    CLIENT_ID_FORMAT: env.CLIENT_ID_FORMAT || 'exactly 5 digits, from the invoice',
  };
  return String(text || '').replace(/\{(COMPANY_NAME|CLIENT_ID_LABEL|CLIENT_ID_FORMAT)\}/g, (m, k) => vals[k]);
}

// What the tool should look like in Ultravox.
function desired(env) {
  const ov = overrides();
  const base = (env.TOOLS_PUBLIC_URL || '').replace(/\/+$/, '');
  return templates().map((t) => {
    const o = ov[t.name] || {};
    const def = {
      modelToolName: t.name,   // the model-facing tool name is required in the definition
      description: fill(o.description || t.description, env),
      dynamicParameters: (t.dynamicParameters || []).map((p) => ({
        ...p, schema: { ...p.schema, description: fill(p.schema && p.schema.description, env) } })),
      staticParameters: [{ name: KEY_HEADER, location: 'PARAMETER_LOCATION_HEADER', value: env.TOOLS_API_KEY || '' }],
      automaticParameters: [{ name: CALL_ID_PARAM, location: 'PARAMETER_LOCATION_BODY', knownValue: 'KNOWN_PARAM_CALL_ID' }],
      http: { baseUrlPattern: base + t.path, httpMethod: 'POST' },
      timeout: o.timeout || t.timeout,
    };
    if (t.precomputable) def.precomputable = true;
    return { name: t.name, requires: t.requires || null, enabled: enabledFeature(env, t.requires),
      overridden: Object.keys(o), template: { description: t.description, timeout: t.timeout }, definition: def };
  });
}

const paramsKey = (list) => JSON.stringify((list || [])
  .map((p) => ({ name: p.name, location: p.location, schema: p.schema || {}, required: !!p.required }))
  .sort((a, b) => a.name.localeCompare(b.name)));

// Differences between the live tool and the target (the key value is never shown, only whether it matches).
function compare(live, want, env) {
  const d = (live && live.definition) || {};
  const diffs = [];
  if ((d.description || '') !== want.description) diffs.push({ field: 'description', text: 'описание отличается' });
  if ((d.modelToolName || '') !== want.modelToolName) diffs.push({ field: 'modelToolName', text: `имя для модели ${d.modelToolName || '—'} → ${want.modelToolName}` });
  if ((d.timeout || '') !== want.timeout) diffs.push({ field: 'timeout', text: `таймаут ${d.timeout || '—'} → ${want.timeout}` });
  if (!!d.precomputable !== !!want.precomputable) diffs.push({ field: 'precomputable', text: `precomputable ${!!d.precomputable} → ${!!want.precomputable}` });
  const url = (d.http && d.http.baseUrlPattern) || '';
  if (url !== want.http.baseUrlPattern) diffs.push({ field: 'url', text: `адрес ${url || '—'} → ${want.http.baseUrlPattern}` });
  const key = (d.staticParameters || []).find((p) => p.name === KEY_HEADER);
  if (!key) diffs.push({ field: 'key', text: `нет ключа ${KEY_HEADER}` });
  else if (key.value !== env.TOOLS_API_KEY) diffs.push({ field: 'key', text: `ключ ${KEY_HEADER} не совпадает с TOOLS_API_KEY` });
  const auto = (d.automaticParameters || []).find((p) => p.name === CALL_ID_PARAM);
  if (!auto || auto.knownValue !== 'KNOWN_PARAM_CALL_ID') diffs.push({ field: 'callId', text: `нет параметра ${CALL_ID_PARAM} (ID звонка, P-02)` });
  if (paramsKey(d.dynamicParameters) !== paramsKey(want.dynamicParameters)) diffs.push({ field: 'params', text: 'параметры отличаются' });
  return diffs;
}

async function liveState(env) {
  const uv = uvx.client(env);
  const all = (await uv('get', '/tools?pageSize=100')).results || [];
  const agents = [];
  for (const l of uvx.LANGS) {
    const id = env[l.envKey];
    if (!id) continue;
    agents.push({ lang: l.lang, label: l.label, agentId: id, agent: await uv('get', '/agents/' + id) });
  }
  return { uv, all, agents };
}

function isOurs(sel, ourIds, ourNames) {
  return ourIds.has(sel.toolId) || ourNames.has(sel.nameOverride) || ourNames.has(sel.toolName);
}

async function status(env) {
  if (!env.TOOLS_PUBLIC_URL) throw uvx.httpErr(400, 'TOOLS_PUBLIC_URL не задан в .env');
  if (!env.TOOLS_API_KEY) throw uvx.httpErr(400, 'TOOLS_API_KEY не задан в .env');
  const { all, agents } = await liveState(env);
  const want = desired(env);
  const byName = new Map(all.map((t) => [t.name, t]));
  const tools = want.map((w) => {
    const live = byName.get(w.name);
    const diffs = live ? compare(live, w.definition, env) : [{ field: 'missing', text: 'тулза нет в Ultravox' }];
    const attached = {};
    for (const a of agents) {
      const sel = ((a.agent.callTemplate || {}).selectedTools || []).find((s) =>
        (live && s.toolId === live.toolId) || s.nameOverride === w.name || s.toolName === w.name);
      // When attaching, Ultravox copies the tool's name and description into the agent; a mismatch
      // means the copy is stale (the tool changed after attaching). Reattaching fixes it.
      const liveDesc = live && live.definition ? live.definition.description : null;
      const stale = !!sel && ((sel.descriptionOverride && sel.descriptionOverride !== liveDesc)
        || (sel.nameOverride && sel.nameOverride !== w.name));
      attached[a.lang] = sel ? { on: true, override: stale } : { on: false };
    }
    return {
      name: w.name, requires: w.requires, enabled: w.enabled, toolId: live ? live.toolId : null,
      description: w.definition.description, timeout: w.definition.timeout, url: w.definition.http.baseUrlPattern,
      overridden: w.overridden, template: w.template, diffs, attached,
    };
  });
  const problems = [];
  tools.forEach((t) => {
    t.diffs.forEach((d) => problems.push(`${t.name}: ${d.text}`));
    for (const a of agents) {
      const at = t.attached[a.lang];
      if (t.enabled && !at.on) problems.push(`${t.name}: не подключён к агенту ${a.lang.toUpperCase()}`);
      if (!t.enabled && at.on) problems.push(`${t.name}: подключён к ${a.lang.toUpperCase()}, но функция выключена`);
      if (at.on && at.override) problems.push(`${t.name}: у агента ${a.lang.toUpperCase()} устаревшая копия описания тулза`);
    }
  });
  return { tools, agents: agents.map((a) => ({ lang: a.lang, label: a.label })), problems };
}

function saveToolsBackup(data) {
  fs.mkdirSync(TOOLS_HISTORY, { recursive: true, mode: 0o700 });
  const file = new Date().toISOString().replace(/[:.]/g, '-') + '-tools-before.json';
  const p = path.join(TOOLS_HISTORY, file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 }); // contains the key, so owner-only
  uvx.chownToProjectOwner(p);
  return file;
}

async function setAgentTools(uv, agentId, agent, selectedTools) {
  const ct = JSON.parse(JSON.stringify(agent.callTemplate || {}));
  delete ct.created; delete ct.updated;
  ct.selectedTools = selectedTools;
  await uv('patch', '/agents/' + agentId, { callTemplate: ct });
}

// Sync: tools = template (+ installation edits); agents get the enabled tools without stale descriptions.
async function sync(env, { dryRun = false } = {}) {
  const st = await status(env);
  const plan = [];
  st.tools.forEach((t) => {
    if (!t.toolId) plan.push(`создать тулз ${t.name}`);
    else if (t.diffs.length) plan.push(`обновить ${t.name}: ${t.diffs.map((d) => d.text).join('; ')}`);
  });
  for (const a of st.agents) {
    st.tools.forEach((t) => {
      const at = t.attached[a.lang];
      if (t.enabled && !at.on) plan.push(`подключить ${t.name} к ${a.lang.toUpperCase()}`);
      if (!t.enabled && at.on) plan.push(`отключить ${t.name} от ${a.lang.toUpperCase()} (функция выключена)`);
      if (t.enabled && at.on && at.override) plan.push(`переподключить ${t.name} к ${a.lang.toUpperCase()} (обновить копию описания)`);
    });
  }
  if (dryRun || !plan.length) return { plan, done: false };

  const { uv, all, agents } = await liveState(env);
  const want = desired(env);
  const byName = new Map(all.map((t) => [t.name, t]));
  const ourNames = new Set(want.map((w) => w.name));
  const ourIds = new Set(want.map((w) => byName.get(w.name)).filter(Boolean).map((t) => t.toolId));
  const backup = saveToolsBackup({
    tools: want.map((w) => byName.get(w.name)).filter(Boolean),
    agents: Object.fromEntries(agents.map((a) => [a.lang, (a.agent.callTemplate || {}).selectedTools || []])),
  });
  const log = [];
  try {
    // 1. Detach our tools from the agents (Ultravox does not allow changing a tool attached to an agent).
    for (const a of agents) {
      const cur = (a.agent.callTemplate || {}).selectedTools || [];
      const rest = cur.filter((s) => !isOurs(s, ourIds, ourNames));
      if (rest.length !== cur.length) { await setAgentTools(uv, a.agentId, a.agent, rest); log.push(`отвязаны от ${a.lang}`); }
    }
    // 2. Create / update the tools.
    const ids = {};
    for (const w of want) {
      const live = byName.get(w.name);
      if (!live) {
        const created = await uv('post', '/tools', { name: w.name, definition: w.definition });
        ids[w.name] = created.toolId; log.push(`создан ${w.name}`);
      } else {
        if (compare(live, w.definition, env).length) {
          await uv('put', '/tools/' + live.toolId, { name: w.name, definition: w.definition }); // Ultravox does not support PATCH for tools
          log.push(`обновлён ${w.name}`);
        }
        ids[w.name] = live.toolId;
      }
    }
    // 3. Attach the enabled tools (no descriptionOverride, so the tool's own description applies).
    for (const a of agents) {
      const fresh = await uv('get', '/agents/' + a.agentId);
      const rest = ((fresh.callTemplate || {}).selectedTools || []).filter((s) => !isOurs(s, new Set(Object.values(ids)), ourNames));
      const ours = want.filter((w) => w.enabled).map((w) => ({ toolId: ids[w.name] }));
      await setAgentTools(uv, a.agentId, fresh, rest.concat(ours));
      log.push(`агенту ${a.lang}: ${want.filter((w) => w.enabled).map((w) => w.name).join(', ')}`);
    }
  } catch (e) {
    // Restore the agents' previous tool set (updated tools keep their ids).
    for (const a of agents) {
      try {
        const fresh = await uv('get', '/agents/' + a.agentId);
        await setAgentTools(uv, a.agentId, fresh, (a.agent.callTemplate || {}).selectedTools || []);
      } catch (_) { /* reported below */ }
    }
    console.error('[ultravox-tools] ошибка синхронизации, агентам возвращены прежние тулзы:', e.message);
    throw uvx.httpErr(e.status || 500, `${e.message}. Агентам возвращён прежний набор тулзов; копия ${backup}`);
  }
  console.log('[ultravox-tools] синхронизация:', log.join('; '), '| копия', backup);
  const after = await status(env);
  return { plan, done: true, backup, log, problems: after.problems };
}

// Per-installation tool edit (description/timeout over the template). Empty restores the template.
function saveOverride(name, { description, timeout }) {
  if (!templates().some((t) => t.name === name)) throw uvx.httpErr(404, 'нет такого тулза в шаблонах');
  const errors = {};
  if (timeout && !DUR.test(String(timeout).trim())) errors.timeout = 'в секундах, напр. 15s';
  if (Object.keys(errors).length) { const e = uvx.httpErr(400, 'есть ошибки в значениях'); e.errors = errors; throw e; }
  const all = overrides();
  const o = {};
  if (description && String(description).trim()) o.description = String(description).trim();
  if (timeout && String(timeout).trim()) o.timeout = String(timeout).trim();
  const t = templates().find((x) => x.name === name);
  if (o.description === t.description) delete o.description;
  if (o.timeout === t.timeout) delete o.timeout;
  if (Object.keys(o).length) all[name] = o; else delete all[name];
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(all, null, 2));
  uvx.chownToProjectOwner(OVERRIDES_PATH);
  return { name, overridden: Object.keys(o) };
}

// The prompt must match the enabled features: describe the attached tools
// and not the disabled ones. Each installation edits its own prompt; the panel only warns.
function promptWarnings(env, prompt) {
  const text = String(prompt || '');
  const out = [];
  const what = { billing: 'биллинг (BILLING_PROVIDER)', network: 'учёт сети (NETWORK_SOURCE)' };
  for (const t of templates()) {
    const on = enabledFeature(env, t.requires);
    const mentioned = text.includes(t.name);
    if (on && !mentioned) out.push(`промпт не упоминает ${t.name}` + (t.requires ? `, а ${what[t.requires]} включён` : '') + ' — агент может его не вызывать');
    if (!on && mentioned) out.push(`промпт упоминает ${t.name}, но ${what[t.requires]} выключен — уберите эти шаги из промпта`);
  }
  const label = env.CLIENT_ID_LABEL || 'OSMP';
  if (enabledFeature(env, 'billing') && !text.includes(label))
    out.push(`биллинг включён, а промпт не просит у клиента номер «${label}» (CLIENT_ID_LABEL)`);
  return out;
}

module.exports = { status, sync, saveOverride, promptWarnings };
