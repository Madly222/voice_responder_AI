'use strict';
const fs = require('fs');
const path = require('path');

// Секреты маскируем в UI: по имени ключа и по отметке «(секрет)» в .env.example (envSchema.js).
const { SECRET_HINT } = require('./envSchema');
// Копии .env перед записью — вне контейнера и вне проекта (см. compose панели), храним последние N.
const BACKUP_DIR = process.env.ENV_BACKUP_DIR || '/data/backups';
const BACKUP_KEEP = 30;

function mask(value) {
  if (!value) return '';
  const v = String(value);
  if (v.length <= 4) return '••••';
  return '••••' + v.slice(-4);
}

// Разбирает .env построчно, сохраняя порядок и комментарии.
// Возвращает [{type:'kv', key, value, secret} | {type:'raw', text}]
function parse(envPath) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  return text.split('\n').map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) return { type: 'raw', text: line };
    const orig = line;
    let value = m[2];
    // снять окружающие кавычки для отображения
    if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    else if (/^".*"$/.test(value)) { try { value = JSON.parse(value); } catch (_) { value = value.slice(1, -1); } }
    return { type: 'kv', key: m[1], value, line: orig, secret: SECRET_HINT.test(m[1]) };
  });
}

// Для UI: список переменных с замаскированными секретами. secretKeys — секреты из .env.example.
function readMasked(envPath, secretKeys = new Set()) {
  return parse(envPath)
    .filter((e) => e.type === 'kv')
    .map((e) => {
      const secret = e.secret || secretKeys.has(e.key);
      return {
        key: e.key,
        value: secret ? mask(e.value) : e.value,
        secret,
        isSet: e.value !== '' && e.value !== undefined,
      };
    });
}

// Значение для записи в .env так, чтобы docker compose прочитал его как есть:
// одинарные кавычки — без подстановки $; двойные — только если внутри есть ' (тогда $ удваиваем).
function quote(v) {
  v = String(v);
  if (!/[\s"'#$\`]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return JSON.stringify(v).replace(/\$/g, '$$$$');
}

function backup(envPath) {
  if (!fs.existsSync(envPath)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(BACKUP_DIR, `env-${stamp}`);
  fs.copyFileSync(envPath, dst);
  fs.chmodSync(dst, 0o600);
  // панель работает от root — отдаём копию владельцу папки, чтобы её можно было открыть без sudo
  try { const st = fs.statSync(BACKUP_DIR); fs.chownSync(dst, st.uid, st.gid); } catch (_) {}
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('env-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// Применяет изменения { KEY: newValue }. Только переданные ключи меняются.
// Пустая строка = очистить значение. Секрет со значением из одних '•' игнорируется
// (пользователь не менял замаскированное поле). Делает бэкап перед записью.
function applyUpdates(envPath, updates) {
  const entries = parse(envPath);
  backup(envPath);
  const seen = new Set();
  for (const e of entries) {
    if (e.type !== 'kv') continue;
    if (!(e.key in updates)) continue;
    const nv = updates[e.key];
    seen.add(e.key);
    if (String(nv).includes('•')) continue; // не трогаем немодифицированный секрет (маска содержит •)
    if (String(nv) === e.value) continue;
    e.value = String(nv);
    e.changed = true;
  }
  // Новые ключи, которых не было в файле — добавляем в конец.
  const added = Object.keys(updates).filter((k) => !seen.has(k) && !String(updates[k]).includes('•'));

  const lines = entries.map((e) => {
    if (e.type === 'raw') return e.text;
    // неизменённые строки пишем как были — не трогаем чужое форматирование
    return e.changed ? `${e.key}=${quote(e.value)}` : e.line;
  });
  for (const k of added) lines.push(`${k}=${quote(updates[k])}`);
  fs.writeFileSync(envPath, lines.join('\n'));
  return { changed: entries.filter((e) => e.changed).map((e) => e.key), added };
}

// Полный набор значений (незамаскированный) — только для внутренних проверок,
// НИКОГДА не отдаётся в UI.
function readRaw(envPath) {
  const out = {};
  for (const e of parse(envPath)) if (e.type === 'kv') out[e.key] = e.value;
  return out;
}

module.exports = { readMasked, applyUpdates, readRaw, mask, quote };
