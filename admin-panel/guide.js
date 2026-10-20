'use strict';
// Guide tab: the text (guide.md) and a first-run checklist with live status.
// The text is read from the project folder (edits show up without rebuilding the panel), falling back to the image.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runAll } = require('./healthChecks');
const ultravox = require('./ultravox');
const uvTools = require('./ultravoxTools');
const applyPlan = require('./applyPlan');

const PROJECT_DIR = process.env.PROJECT_DIR || '/project';
const GUIDE_PATHS = [path.join(PROJECT_DIR, 'admin-panel', 'guide.md'), path.join(__dirname, 'guide.md')];

function text() {
  for (const p of GUIDE_PATHS) if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return '# Справка не найдена\n\nФайл `admin-panel/guide.md` отсутствует.';
}

function containerRunning(name) {
  return new Promise((resolve) => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeout: 10000, env: applyPlan.CLEAN_ENV() },
      (err, out) => resolve(!err && String(out).trim() === 'true'));
  });
}

function callsCount() {
  try {
    const t = fs.readFileSync(path.join(PROJECT_DIR, 'faq-server', 'data', 'calls.txt'), 'utf8');
    return (t.match(/^Call: \d+/gm) || []).length;
  } catch (_) { return 0; }
}

const off = (v) => ['', 'none'].includes(String(v || '').toLowerCase());

// Items in setup order. ok: true = done, false = to do, null = disabled / optional.
async function status(env) {
  const health = await runAll(env).catch(() => []);
  const h = (id) => health.find((x) => x.id === id) || { ok: false, detail: 'проверка не выполнена' };
  const items = [];
  const add = (id, title, ok, detail, tab, hint) => items.push({ id, title, ok, detail, tab, hint });

  add('panel', 'Пароль панели задан', !!(env.PANEL_PASS && env.PANEL_PASS.length >= 8),
    env.PANEL_PASS ? (env.PANEL_PASS.length >= 8 ? 'задан' : 'короче 8 символов') : 'не задан', 'env',
    'Переменные (.env) → блок «Доступ к панели».');

  const uvx = h('ultravox');
  add('ultravox-key', 'Ключ Ultravox', !!uvx.ok, uvx.detail, 'env', 'Справка → «Ultravox — ИИ-агент».');

  let agents = [];
  if (env.ULTRAVOX_API_KEY) agents = await ultravox.listAgents(env).catch(() => []);
  for (const l of ultravox.LANGS) {
    const a = agents.find((x) => x.lang === l.lang);
    const ok = !!(a && !a.error);
    add('agent-' + l.lang, `Агент ${l.lang.toUpperCase()}`, ok,
      ok ? `${a.fields.name}` : (a ? a.error : `${l.envKey} не задан`), 'ultravox',
      `ID агента — в ${l.envKey}; создать можно на вкладке Ultravox.`);
  }

  const pub = h('tools-endpoint');
  add('public', 'Публичный вход для тулзов (nginx)', !!pub.ok, pub.detail, 'env', 'Справка → «Публичный вход для тулзов».');

  if (env.ULTRAVOX_API_KEY && env.TOOLS_PUBLIC_URL && env.TOOLS_API_KEY) {
    const t = await uvTools.status(env).catch((e) => ({ problems: [e.message] }));
    add('tools', 'Тулзы в Ultravox синхронизированы', !t.problems.length,
      t.problems.length ? `расхождений: ${t.problems.length}` : 'совпадают', 'ultravox',
      'Ultravox (агенты) → «Тулзы» → «Синхронизировать с Ultravox».');
    const warn = agents.filter((a) => a.fields).flatMap((a) => uvTools.promptWarnings(env, a.fields.systemPrompt));
    add('prompts', 'Промпты соответствуют включённым функциям', !warn.length,
      warn.length ? `предупреждений: ${warn.length}` : 'соответствуют', 'ultravox', 'Ultravox (агенты) → промпт агента.');
  } else {
    add('tools', 'Тулзы в Ultravox синхронизированы', false, 'сначала ключ Ultravox и публичный вход', 'ultravox');
  }

  const tg = h('telegram');
  add('telegram', 'Telegram — отчёты о звонках', !!tg.ok, tg.detail, 'env', 'Справка → «Telegram».');

  const faq = h('faq-server');
  add('faq', 'FAQ заполнен', !!faq.ok && !/faq_count=0\b/.test(faq.detail || ''), faq.detail, 'faq',
    'Вкладка FAQ: вопросы и ответы о компании.');

  if (off(env.BILLING_PROVIDER)) add('billing', 'Биллинг', null, 'выключен (по желанию)', 'env');
  else { const b = h('whmcs'); add('billing', 'Биллинг', !!b.ok, b.detail, 'env', 'Справка → «Биллинг».'); }

  if (off(env.NETWORK_SOURCE)) add('network', 'Учёт сети и диагностика', null, 'выключены (по желанию)', 'env');
  else {
    const n = h('netbox'); const d = h('network-diag');
    add('network', 'Учёт сети (NetBox)', !!n.ok, n.detail, 'env', 'Справка → «Учёт сети и диагностика».');
    add('diag', 'Диагностика свитчей (сервис)', !!d.ok, d.detail, 'health',
      'Учётка SSH проверяется только на реальном свитче — пробным звонком.');
  }

  const ast = await containerRunning('avr-asterisk');
  add('asterisk', 'Asterisk запущен', ast, ast ? 'работает' : 'не запущен', 'health',
    'Транк от вашей АТС — вкладка Asterisk, pjsip.conf.');

  const plan = await applyPlan.plan(env, uvTools).catch(() => null);
  const pending = plan ? plan.services.length + (plan.tools.needed ? 1 : 0) : 0;
  add('applied', 'Настройки применены', plan ? pending === 0 : false,
    plan ? (pending ? `ждут применения: ${plan.services.map((s) => s.service).concat(plan.tools.needed ? ['тулзы'] : []).join(', ')}` : 'всё применено') : 'не удалось проверить',
    'env', 'Переменные (.env) → «Применить».');

  const calls = callsCount();
  add('call', 'Пробный звонок', calls > 0, calls ? `звонков в журнале: ${calls}` : 'звонков ещё не было', 'health',
    'Позвоните на 5004 (RO) или 5003 (RU); отчёт должен прийти в Telegram.');

  const need = items.filter((i) => i.ok === false).length;
  return { items, need };
}

module.exports = { text, status };
