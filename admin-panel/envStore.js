'use strict';
const fs = require('fs');
const path = require('path');

// Secrets are masked in the UI by key name and by the "(секрет)" marker in .env.example (envSchema.js).
const { SECRET_HINT } = require('./envSchema');
// .env backups before each write live outside the container and the project (see the panel compose file); the last N are kept.
const BACKUP_DIR = process.env.ENV_BACKUP_DIR || '/data/backups';
const BACKUP_KEEP = 30;

function mask(value) {
  if (!value) return '';
  const v = String(value);
  if (v.length <= 4) return '••••';
  return '••••' + v.slice(-4);
}

// Parses .env line by line, preserving order and comments.
// Returns [{type:'kv', key, value, secret} | {type:'raw', text}]
function parse(envPath) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  return text.split('\n').map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) return { type: 'raw', text: line };
    const orig = line;
    let value = m[2];
    if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    else if (/^".*"$/.test(value)) { try { value = JSON.parse(value); } catch (_) { value = value.slice(1, -1); } }
    return { type: 'kv', key: m[1], value, line: orig, secret: SECRET_HINT.test(m[1]) };
  });
}

// For the UI: variables with secrets masked. secretKeys are the secrets declared in .env.example.
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

// Quote a value for .env so docker compose reads it verbatim:
// single quotes disable $ interpolation; double quotes only when the value contains ' (then $ is doubled).
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
  // the panel runs as root: hand the backup to the folder owner so it can be opened without sudo
  try { const st = fs.statSync(BACKUP_DIR); fs.chownSync(dst, st.uid, st.gid); } catch (_) {}
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('env-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// Applies { KEY: newValue } changes. Only the given keys change.
// An empty string clears the value. A secret whose value is all '•' is ignored
// (the user did not touch the masked field). Makes a backup before writing.
function applyUpdates(envPath, updates) {
  const entries = parse(envPath);
  backup(envPath);
  const seen = new Set();
  for (const e of entries) {
    if (e.type !== 'kv') continue;
    if (!(e.key in updates)) continue;
    const nv = updates[e.key];
    seen.add(e.key);
    if (String(nv).includes('•')) continue; // untouched secret (the mask contains •)
    if (String(nv) === e.value) continue;
    e.value = String(nv);
    e.changed = true;
  }
  // Keys not yet in the file are appended at the end.
  const added = Object.keys(updates).filter((k) => !seen.has(k) && !String(updates[k]).includes('•'));

  const lines = entries.map((e) => {
    if (e.type === 'raw') return e.text;
    // unchanged lines are written back as is, keeping their original formatting
    return e.changed ? `${e.key}=${quote(e.value)}` : e.line;
  });
  for (const k of added) lines.push(`${k}=${quote(updates[k])}`);
  fs.writeFileSync(envPath, lines.join('\n'));
  return { changed: entries.filter((e) => e.changed).map((e) => e.key), added };
}

// All values, unmasked: for internal checks only,
// NEVER sent to the UI.
function readRaw(envPath) {
  const out = {};
  for (const e of parse(envPath)) if (e.type === 'kv') out[e.key] = e.value;
  return out;
}

module.exports = { readMasked, applyUpdates, readRaw, mask, quote };
