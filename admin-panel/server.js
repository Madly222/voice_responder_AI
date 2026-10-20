'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cron = require('node-cron');
const axios = require('axios');
const envStore = require('./envStore');
const envSchema = require('./envSchema');
const faqStore = require('./faqStore');
const { runAll } = require('./healthChecks');

const PORT = process.env.PORT || 8090;
const ENV_PATH = process.env.ENV_PATH || '/data/.env';
const ASTERISK_DIR = process.env.ASTERISK_DIR || '/data/asterisk/conf';
const FAQ_PATH = process.env.FAQ_PATH || '/data/faqdata/faq.json';
const ULTRAVOX_URL = process.env.PANEL_ULTRAVOX_URL || 'https://app.ultravox.ai';
// Panel settings (survive restarts), stored as a separate JSON file next to the data.
const SETTINGS_PATH = process.env.SETTINGS_PATH || '/data/faqdata/panel-settings.json';
const DEFAULT_SETTINGS = { notifyMode: 'problems' }; // 'problems' = only when something is red, 'always' = every time
function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch (_) { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  return s;
}
// Asterisk files that may be edited (a whitelist, so arbitrary files cannot be touched).
const ASTERISK_FILES = ['pjsip.conf', 'extensions.conf', 'queues.conf', 'ari.conf', 'manager.conf'];

const ADMIN_USER = process.env.PANEL_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_PASS;
if (!ADMIN_PASS) {
  console.error('FATAL: PANEL_PASS не задан — панель не запускается без пароля.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
const security = require('./security');
app.use(security.authGuard({ user: ADMIN_USER, pass: ADMIN_PASS, realm: 'avr-admin' }));
app.use(security.auditMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ---- ENV ----
// Groups, descriptions and defaults come from the project's .env.example (envSchema.js).
const EXAMPLE_PATH = process.env.ENV_EXAMPLE_PATH
  || path.join(process.env.PROJECT_DIR || '/project', '.env.example');
// These keys change only through the panel access block (with a password change and a restart).
const PANEL_MANAGED = ['PANEL_USER', 'PANEL_PASS'];

function envGroups() {
  const groups = envSchema.parseExample(EXAMPLE_PATH);
  const items = new Map();
  groups.forEach((g) => g.items.forEach((it) => items.set(it.key, it)));
  const secretKeys = new Set([...items.values()].filter((it) => it.secret).map((it) => it.key));
  const vars = envStore.readMasked(ENV_PATH, secretKeys);
  const byKey = new Map(vars.map((v) => [v.key, v]));
  const out = groups.map((g) => ({
    name: g.name,
    items: g.items.filter((it) => !PANEL_MANAGED.includes(it.key))
      .map((it) => ({ ...it, ...(byKey.get(it.key) || { value: '', isSet: false }), inFile: byKey.has(it.key) })),
  })).filter((g) => g.items.length);
  const extra = vars.filter((v) => !items.has(v.key) && !PANEL_MANAGED.includes(v.key));
  if (extra.length) out.push({ name: 'Прочее (нет в .env.example)', items: extra.map((v) => ({ ...v, desc: '', inFile: true })) });
  return { groups: out, items };
}

app.get('/api/env', (req, res) => {
  try {
    const { groups } = envGroups();
    const user = envStore.readRaw(ENV_PATH).PANEL_USER || '';
    res.json({ groups, panelUser: user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/env', (req, res) => {
  try {
    const updates = { ...(req.body.updates || {}) };
    PANEL_MANAGED.forEach((k) => delete updates[k]);
    const { items } = envGroups();
    const errors = {};
    for (const [k, v] of Object.entries(updates)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) { errors[k] = 'недопустимое имя'; continue; }
      if (String(v).includes('•')) continue; // untouched secret
      const err = envSchema.validate(k, v, items.get(k));
      if (err) errors[k] = err;
    }
    if (Object.keys(errors).length) return res.status(400).json({ error: 'есть ошибки в значениях', errors });
    const result = envStore.applyUpdates(ENV_PATH, updates);
    console.log('[env] сохранено, изменены:', result.changed.concat(result.added).join(', ') || '—');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ASTERISK CONFIG ----
app.get('/api/asterisk/:file', (req, res) => {
  const file = req.params.file;
  if (!ASTERISK_FILES.includes(file)) return res.status(400).json({ error: 'файл не в списке разрешённых' });
  const p = path.join(ASTERISK_DIR, file);
  try { res.json({ file, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/asterisk/:file', (req, res) => {
  const file = req.params.file;
  if (!ASTERISK_FILES.includes(file)) return res.status(400).json({ error: 'файл не в списке разрешённых' });
  const p = path.join(ASTERISK_DIR, file);
  try {
    const backupDir = path.join(ASTERISK_DIR, '.backups');
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(p)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(p, path.join(backupDir, `${file}.${stamp}.bak`));
    }
    fs.writeFileSync(p, req.body.content || '');
    res.json({ ok: true, file });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/asterisk', (req, res) => res.json({ files: ASTERISK_FILES }));

// ---- FAQ ----
app.get('/api/faq', (req, res) => {
  try { res.json(faqStore.read(FAQ_PATH)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/faq', (req, res) => {
  try { res.json(faqStore.write(FAQ_PATH, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- ULTRAVOX: RO/RU agents (edit, history, rollback) ----
const ultravox = require('./ultravox');
// tools are needed here too, to check the prompt against the enabled features
const uvTools = require('./ultravoxTools');
const uvRoute = (fn) => async (req, res) => {
  try { res.json(await fn(envStore.readRaw(ENV_PATH), req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, errors: e.errors }); }
};
app.get('/api/ultravox/agents', uvRoute(async (env) => {
  const agents = await ultravox.listAgents(env);
  agents.forEach((a) => { a.warnings = a.fields ? uvTools.promptWarnings(env, a.fields.systemPrompt) : []; });
  return { agents, models: await ultravox.models(env).catch(() => []) };
}));
app.get('/api/ultravox/voices', uvRoute(async (env) => ({
  voices: (await ultravox.voices(env)).map(({ _preview, ...v }) => v),
})));
app.get('/api/ultravox/voices/:id/preview', async (req, res) => {
  try {
    const r = await ultravox.voicePreview(envStore.readRaw(ENV_PATH), req.params.id);
    if (r.redirect) return res.redirect(r.redirect);
    res.set('Content-Type', r.type); r.stream.pipe(res);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/ultravox/agents/:lang/preview', uvRoute(async (env, req) => {
  const changes = (req.body || {}).changes || {};
  const r = await ultravox.apply(env, req.params.lang, changes, { dryRun: true });
  r.warnings = 'systemPrompt' in changes ? uvTools.promptWarnings(env, changes.systemPrompt) : [];
  return r;
}));
app.post('/api/ultravox/agents/:lang/apply', uvRoute((env, req) =>
  ultravox.apply(env, req.params.lang, (req.body || {}).changes)));
// First run: create the agent from the template in the ULTRAVOX_API_KEY account and write its ID to .env.
app.post('/api/ultravox/agents/:lang/create', uvRoute(async (env, req) => {
  const r = await ultravox.createAgent(env, req.params.lang, { writeEnv: true });
  envStore.applyUpdates(ENV_PATH, { [r.envKey]: r.agentId });
  return r;
}));
app.get('/api/ultravox/agents/:lang/history', uvRoute(async (env, req) => ({ history: ultravox.history(req.params.lang) })));
app.post('/api/ultravox/agents/:lang/restore', uvRoute((env, req) =>
  ultravox.restore(env, req.params.lang, (req.body || {}).file, { dryRun: !!(req.body || {}).dryRun })));

// ---- ULTRAVOX: tools (compare with the ultravox/tools.json templates, sync) ----
app.get('/api/ultravox/tools', uvRoute((env) => uvTools.status(env)));
app.post('/api/ultravox/tools/sync', uvRoute((env, req) => uvTools.sync(env, { dryRun: !!(req.body || {}).dryRun })));
app.post('/api/ultravox/tools/:name', uvRoute(async (env, req) => uvTools.saveOverride(req.params.name, req.body || {})));

// ---- GUIDE: guide.md text and the first-run checklist ----
const guide = require('./guide');
app.get('/api/guide', (req, res) => res.json({ markdown: guide.text() }));
app.get('/api/guide/status', uvRoute((env) => guide.status(env)));

// ---- AUDIT LOG (instance/audit.log) ----
app.get('/api/audit', (req, res) => res.json({ entries: security.readAudit(Math.min(Number(req.query.limit) || 50, 500)) }));

// ---- CONFIG (for the frontend: Ultravox link etc.) ----
app.get('/api/config', (req, res) => res.json({ ultravoxUrl: ULTRAVOX_URL }));

// ---- SETTINGS (notification mode etc.) ----
app.get('/api/settings', (req, res) => res.json(readSettings()));
app.post('/api/settings', (req, res) => {
  const mode = req.body && req.body.notifyMode;
  if (!['problems', 'always'].includes(mode)) return res.status(400).json({ error: 'notifyMode: problems | always' });
  res.json(writeSettings({ notifyMode: mode }));
});

// ---- APPLY .env: what is stale (services, Ultravox tools), and apply it ----
// Services are compared with what they actually run with (applyPlan.js); only the ones that need it are recreated.
const applyPlan = require('./applyPlan');
app.get('/api/apply/plan', uvRoute(async (env) => {
  const p = await applyPlan.plan(env, uvTools);
  const agents = env.ULTRAVOX_API_KEY ? await ultravox.listAgents(env).catch(() => []) : [];
  p.promptWarnings = agents.filter((a) => a.fields)
    .map((a) => ({ lang: a.lang, warnings: uvTools.promptWarnings(env, a.fields.systemPrompt) }))
    .filter((a) => a.warnings.length);
  return p;
}));
app.post('/api/apply', uvRoute(async (env) => applyPlan.execute(env, uvTools)));

// ---- PANEL ACCESS CHANGE (self-restart) ----
// The panel cannot recreate itself synchronously (that would kill the request). So:
// 1) write the new PANEL_USER/PANEL_PASS to .env, 2) answer the browser, 3) after a pause
// recreate admin-panel via compose in the background; by then the response has been delivered.
app.post('/api/panel-auth', (req, res) => {
  const { user, pass } = req.body || {};
  if (!pass || String(pass).length < 8) return res.status(400).json({ error: 'пароль минимум 8 символов' });
  const updates = { PANEL_PASS: pass };
  if (user && user.trim()) updates.PANEL_USER = user.trim();
  try {
    envStore.applyUpdates(ENV_PATH, updates);
  } catch (e) { return res.status(500).json({ error: e.message }); }
  // A separate container does the recreation (see applyPlan.recreateSelf): the panel cannot recreate itself from inside.
  applyPlan.recreateSelf()
    .then(() => { console.log('[panel-auth] панель будет пересоздана с новым доступом'); res.json({ ok: true, restarting: true }); })
    .catch((e) => { console.error('[panel-auth] пересоздать панель не удалось:', e.message); res.status(500).json({ error: 'доступ записан в .env, но панель не перезапустилась: ' + e.message }); });
});

// ---- Container STATUS (real uptime, so the UI shows the result of a restart) ----
app.get('/api/status', (req, res) => {
  const { dir, files } = composePrefix();
  exec(`cd ${dir} && docker compose ${files} ps --format json`, { timeout: 20000, env: applyPlan.CLEAN_ENV() }, (err, stdout) => {
    if (err) return res.json({ status: {} }); // don't fail the page, just show no statuses
    const map = {};
    const ingest = (o) => { if (o && o.Service) map[o.Service] = o.Status || o.State || ''; };
    const text = (stdout || '').trim();
    // compose may return either one JSON object per line or an array
    if (text.startsWith('[')) {
      try { JSON.parse(text).forEach(ingest); } catch (_) {}
    } else {
      text.split('\n').filter(Boolean).forEach((line) => { try { ingest(JSON.parse(line)); } catch (_) {} });
    }
    res.json({ status: map });
  });
});

// ---- HEALTH ----
app.get('/api/health', async (req, res) => {
  try {
    const env = envStore.readRaw(ENV_PATH);
    res.json({ ts: new Date().toISOString(), results: await runAll(env) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- RESTART / REBUILD containers via compose ----
// All project services. admin-panel is handled separately (self-operation in the background).
const MANAGEABLE = ['faq-server', 'network-diag', 'avr-asterisk', 'avr-sts-ultravox', 'avr-sts-ultravox-ru', 'avr-core', 'avr-core-ru', 'avr-ami', 'admin-panel'];
function composePrefix() {
  const dir = process.env.PROJECT_DIR || '/project';
  const files = (process.env.COMPOSE_FILES || 'docker-compose-ultravox.yml:docker-compose-admin-panel.yml')
    .split(':').map((f) => `-f ${f}`).join(' ');
  return { dir, files };
}
// Shared handler: action = 'restart' | 'rebuild' (up -d --build --force-recreate).
function runContainerAction(action, s, res) {
  if (!MANAGEABLE.includes(s)) return res.status(400).json({ error: 'сервис не в списке' });
  const { dir, files } = composePrefix();
  const cmd = action === 'rebuild'
    ? `cd ${dir} && docker compose --env-file .env ${files} up -d --build --force-recreate ${s}`
    : `cd ${dir} && docker compose ${files} restart ${s}`;
  // admin-panel cannot recreate itself; a separate container does it (applyPlan.recreateSelf).
  if (s === 'admin-panel') {
    applyPlan.recreateSelf({ build: action === 'rebuild' })
      .then(() => res.json({ ok: true, service: s, action, background: true }))
      .catch((e) => res.status(500).json({ error: e.message }));
    return;
  }
  exec(cmd, { timeout: 300000, env: applyPlan.CLEAN_ENV() }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, service: s, action });
  });
}
app.post('/api/restart/:service', (req, res) => runContainerAction('restart', req.params.service, res));
app.post('/api/rebuild/:service', (req, res) => runContainerAction('rebuild', req.params.service, res));

// ---- Telegram alert ----
async function sendTelegram(text) {
  const env = envStore.readRaw(ENV_PATH);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn('[telegram] не настроен (нет токена/chat_id) — уведомление не отправлено');
    return false;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML',
    }, { timeout: Number(env.TELEGRAM_TIMEOUT_MS) || 8000 });
    return true;
  } catch (e) {
    console.error('[telegram] ОТПРАВКА НЕ УДАЛАСЬ:', e.message,
      '— уведомление НЕ доставлено. Проверь бот/сеть.');
    return false;
  }
}

function formatReport(results, title) {
  const down = results.filter((r) => !r.ok);
  const head = down.length === 0
    ? `✅ <b>${title}</b>\nВсе системы в норме (${results.length}/${results.length}).`
    : `⚠️ <b>${title}</b>\nПроблемы: ${down.length} из ${results.length}.`;
  const lines = results.map((r) => `${r.off ? '⚪' : (r.ok ? '🟢' : '🔴')} ${r.label}${r.ok && !r.off ? '' : ' — ' + r.detail}`);
  return head + '\n\n' + lines.join('\n');
}

// Manual run that also sends to Telegram
app.post('/api/check-now', async (req, res) => {
  const env = envStore.readRaw(ENV_PATH);
  const results = await runAll(env);
  await sendTelegram(formatReport(results, 'Ручная проверка системы'));
  res.json({ ts: new Date().toISOString(), results });
});

// ---- CRON: daily health report (HEALTH_REPORT_CRON, 08:00 by default) ----
const TZ = process.env.CRON_TZ || 'Europe/Chisinau';
const HEALTH_CRON = process.env.HEALTH_REPORT_CRON || '0 8 * * *';
cron.schedule(HEALTH_CRON, async () => {
  const env = envStore.readRaw(ENV_PATH);
  const results = await runAll(env);
  const down = results.filter((r) => !r.ok);
  const mode = readSettings().notifyMode;
  console.log(`[cron ${HEALTH_CRON}] проверка: ${results.length - down.length}/${results.length} ok`
    + (down.length ? `; упало: ${down.map((d) => d.id).join(', ')}` : '')
    + `; режим=${mode}`);
  // 'problems': send only if something is red; 'always': send every time.
  if (mode === 'problems' && down.length === 0) return;
  if (down.some((d) => d.id === 'telegram')) {
    console.error(`[cron ${HEALTH_CRON}] ВНИМАНИЕ: сам Telegram помечен как упавший — `
      + 'уведомление может не дойти. Проверь статус в панели (вкладка Мониторинг).');
  }
  await sendTelegram(formatReport(results, 'Плановая проверка системы'));
}, { timezone: TZ });

app.listen(PORT, () => console.log(`admin-panel слушает :${PORT} (TZ=${TZ}, проверка: ${HEALTH_CRON}), env=${ENV_PATH}`));
