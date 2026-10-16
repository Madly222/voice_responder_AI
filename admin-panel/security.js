'use strict';
// Безопасность панели: вход с защитой от подбора пароля и журнал действий.
// Журнал — instance/audit.log (вне git): кто, откуда, когда и что сделал. Значения настроек
// и пароли в журнал НЕ пишутся — только имена ключей, полей, файлов и сервисов.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = process.env.PROJECT_DIR || '/project';
const AUDIT_PATH = path.join(process.env.INSTANCE_DIR || path.join(PROJECT_DIR, 'instance'), 'audit.log');
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;   // больше — оставляем последнюю половину
const FAIL_LIMIT = 10;                     // неверных паролей с одного адреса…
const FAIL_WINDOW_MS = 15 * 60 * 1000;     // …за 15 минут —
const BLOCK_MS = 15 * 60 * 1000;           // блокировка на 15 минут

// ---------- журнал ----------
function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_PATH, line, { mode: 0o600 });
    const st = fs.statSync(AUDIT_PATH);
    if (st.size > AUDIT_MAX_BYTES) {
      const keep = fs.readFileSync(AUDIT_PATH, 'utf8').slice(-AUDIT_MAX_BYTES / 2);
      fs.writeFileSync(AUDIT_PATH, keep.slice(keep.indexOf('\n') + 1), { mode: 0o600 });
    }
    try { const p = fs.statSync(PROJECT_DIR); fs.chownSync(AUDIT_PATH, p.uid, p.gid); } catch (_) {}
  } catch (e) { console.error('[audit] не удалось записать журнал:', e.message); }
}

function readAudit(limit = 100) {
  try {
    const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// ---------- вход ----------
const fails = new Map();   // ip -> { count, first, blockedUntil }

function sameSecret(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Basic-auth с блокировкой подбора. Запрос без заголовка (первый заход браузера) попыткой не считается.
function authGuard({ user, pass, realm }) {
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    const f = fails.get(ip);
    if (f && f.blockedUntil > now) {
      const min = Math.ceil((f.blockedUntil - now) / 60000);
      return res.status(429).send(`Слишком много неверных паролей. Вход с ${ip} заблокирован ещё на ${min} мин.`);
    }
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) {
      const raw = Buffer.from(m[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      const u = i >= 0 ? raw.slice(0, i) : raw;
      const p = i >= 0 ? raw.slice(i + 1) : '';
      if (sameSecret(u, user) && sameSecret(p, pass)) {
        fails.delete(ip);
        req.auth = { user: u };
        return next();
      }
      const cur = f && now - f.first < FAIL_WINDOW_MS ? f : { count: 0, first: now, blockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= FAIL_LIMIT) {
        cur.blockedUntil = now + BLOCK_MS;
        audit({ user: u.slice(0, 40), ip, action: 'вход заблокирован', detail: `${cur.count} неверных паролей за 15 мин` });
        console.warn(`[auth] ${ip}: ${cur.count} неверных паролей — блокировка на 15 мин`);
      } else if (cur.count === 1 || cur.count === 5) {
        audit({ user: u.slice(0, 40), ip, action: 'неверный пароль', detail: `попытка ${cur.count}` });
      }
      fails.set(ip, cur);
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.status(401).send('Нужен логин и пароль панели');
  };
}

// ---------- что записать в журнал ----------
// Только изменяющие запросы; «проверки» (preview, dryRun) не пишем.
function describe(req) {
  const b = req.body || {};
  const p = req.path;
  let m;
  if (b.dryRun || /\/preview$/.test(p)) return null;
  if (p === '/api/env') return { action: 'изменены настройки .env', detail: Object.keys(b.updates || {}).filter((k) => !String(b.updates[k]).includes('•')).join(', ') };
  if (p === '/api/apply') return { action: 'применены настройки .env' };
  if (p === '/api/panel-auth') return { action: 'сменён доступ к панели', detail: b.user ? `логин: ${String(b.user).slice(0, 40)}` : '' };
  if (p === '/api/settings') return { action: 'изменён режим уведомлений', detail: String(b.notifyMode || '') };
  if (p === '/api/check-now') return { action: 'ручная проверка системы' };
  if (p === '/api/faq') return { action: 'изменён FAQ', detail: Array.isArray(b.faq) ? `записей: ${b.faq.length}` : '' };
  if ((m = p.match(/^\/api\/asterisk\/(.+)$/))) return { action: 'изменён конфиг Asterisk', detail: m[1] };
  if ((m = p.match(/^\/api\/(restart|rebuild)\/(.+)$/))) return { action: m[1] === 'restart' ? 'перезапуск сервиса' : 'пересборка сервиса', detail: m[2] };
  if ((m = p.match(/^\/api\/ultravox\/agents\/(\w+)\/apply$/))) return { action: `изменён агент ${m[1].toUpperCase()}`, detail: Object.keys(b.changes || {}).join(', ') };
  if ((m = p.match(/^\/api\/ultravox\/agents\/(\w+)\/restore$/))) return { action: `откат агента ${m[1].toUpperCase()}`, detail: String(b.file || '') };
  if ((m = p.match(/^\/api\/ultravox\/agents\/(\w+)\/create$/))) return { action: `создан агент ${m[1].toUpperCase()}` };
  if (p === '/api/ultravox/tools/sync') return { action: 'синхронизированы тулзы Ultravox' };
  if ((m = p.match(/^\/api\/ultravox\/tools\/(.+)$/))) return { action: 'изменён тулз', detail: m[1] };
  return { action: `${req.method} ${p}` };
}

function auditMiddleware(req, res, next) {
  if (req.method !== 'POST' || !req.path.startsWith('/api/')) return next();
  const d = describe(req);
  if (!d) return next();
  res.on('finish', () => {
    audit({ user: (req.auth && req.auth.user) || '', ip: clientIp(req), ...d,
      result: res.statusCode < 400 ? 'ok' : `ошибка ${res.statusCode}` });
  });
  next();
}

// ---------- оценка доступа к панели (для «Мониторинга») ----------
const WEAK = ['admin', 'password', 'parola', 'qwerty', '12345678', '123456789', 'avr', 'changeme', 'change_me'];

function panelCheck(env) {
  const pass = env.PANEL_PASS || '';
  const user = env.PANEL_USER || 'admin';
  const problems = [];
  if (pass.length < 12) problems.push(`пароль короче 12 символов (${pass.length})`);
  if (WEAK.includes(pass.toLowerCase()) || pass.toLowerCase() === user.toLowerCase()) problems.push('пароль слишком простой');
  if (pass.length && new Set(pass).size < 5) problems.push('в пароле мало разных символов');
  const bind = env.PANEL_BIND || '127.0.0.1';
  const port = env.PANEL_PORT || '8090';
  const reach = bind === '127.0.0.1' ? 'только с самого сервера' : `из сети (${bind}:${port}) — не пробрасывайте этот порт в интернет`;
  const day = Date.now() - 24 * 3600 * 1000;
  const failed = readAudit(1000).filter((e) => /неверный пароль|вход заблокирован/.test(e.action) && Date.parse(e.ts) > day).length;
  const detail = (problems.length ? problems.join('; ') + '. ' : 'пароль надёжный. ') + `Доступ ${reach}.`
    + (failed ? ` Неудачные входы за сутки: ${failed}.` : '');
  return { ok: problems.length === 0, detail };
}

module.exports = { authGuard, auditMiddleware, audit, readAudit, panelCheck };
