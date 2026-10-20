'use strict';
// Setting descriptions for the panel come from .env.example, the single source of truth:
//   # ---------- Group ----------        group heading
//   # --- Subgroup ---                   subheading
//   # description (comment lines right above the key)
//   KEY=
// From the description: "(секрет ...)" hides the value; "(по умолч. X)" is the default hint;
// ": a | b" is a choice of options. .env keys missing from the example go to the "Прочее" (Other) group.
const fs = require('fs');
const cron = require('node-cron');

const SECRET_HINT = /(KEY|TOKEN|PASS|SECRET|PASSWORD)/i;

function parseExample(examplePath) {
  const text = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  const groups = [];
  let group = null, sub = null, comments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^#\s*-{4,}\s*(.+?)\s*-{4,}\s*$/))) {
      group = { name: m[1], items: [] }; groups.push(group); sub = null; comments = []; continue;
    }
    if ((m = line.match(/^#\s*-{3}\s*(.+?)\s*-{3}\s*$/))) { sub = m[1]; comments = []; continue; }
    if (line.startsWith('#')) { comments.push(line.replace(/^#\s?/, '')); continue; }
    if ((m = line.match(/^([A-Z0-9_]+)=/))) {
      if (!group) { group = { name: 'Общее', items: [] }; groups.push(group); }
      const desc = comments.join(' ');
      const def = (desc.match(/по умолч\.\s*([^)]*)\)/) || [])[1] || '';
      const ch = desc.match(/:\s*([a-z0-9_]+(?:\s*\|\s*[a-z0-9_]+)+)/i);
      group.items.push({
        key: m[1], sub, desc,
        def: def.trim(),
        secret: /\(секрет/i.test(desc) || SECRET_HINT.test(m[1]),
        choices: ch ? ch[1].split('|').map((s) => s.trim()) : null,
      });
    }
    comments = [];
  }
  return groups;
}

function isIPv4(s) {
  const p = s.split('.');
  return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

// Error for the value, or null. An empty value is always allowed: the default applies.
function validate(key, value, item) {
  const v = String(value);
  if (/[\r\n]/.test(v)) return 'значение не может быть многострочным';
  if (v.includes("'") && v.includes('$')) return 'нельзя одновременно символы \' и $';
  if (v === '') return null;
  if (item && item.choices && !item.choices.includes(v.toLowerCase()))
    return 'допустимо: ' + item.choices.join(', ');
  if (/_PORT$/.test(key) || key === 'PORT') {
    if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) return 'порт — число 1…65535';
  } else if (/_MS$/.test(key) || key === 'TRANSCRIPT_MAX_UTTERANCES') {
    if (!/^\d+$/.test(v) || +v <= 0) return 'целое число больше 0';
  } else if (/^SSH_.*_TIMEOUT$/.test(key)) {
    if (!/^\d+(\.\d+)?$/.test(v) || +v <= 0) return 'число секунд больше 0';
  }
  if (/_URL$/.test(key) || key === 'WHMCS_CUSTOM_API') {
    if (!/^https?:\/\/[^\s/]+/i.test(v)) return 'адрес должен начинаться с http:// или https://';
  }
  if (key === 'TOOLS_CHECK_ADDR' && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(v)) return 'формат адрес:порт, напр. 10.0.0.5:8443';
  if (key === 'PANEL_BIND' && !isIPv4(v)) return 'IPv4-адрес, напр. 127.0.0.1 или 0.0.0.0';
  if (key === 'SWITCH_MGMT_NETS') {
    const bad = v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).find((c) => {
      const [ip, bits] = c.split('/');
      return !isIPv4(ip) || (bits !== undefined && !(/^\d+$/.test(bits) && +bits <= 32));
    });
    if (bad) return `не сеть: ${bad} (нужно вида 198.51.100.0/24)`;
  }
  if (key === 'CLIENT_ID_PATTERN') {
    try { new RegExp(v); } catch (e) { return 'неверное регулярное выражение: ' + e.message; }
  }
  if (key === 'HEALTH_REPORT_CRON' && !cron.validate(v)) return 'неверный формат cron, напр. 0 8 * * *';
  if (key === 'CRON_TZ') {
    try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch (_) { return 'неизвестный часовой пояс, напр. UTC'; }
  }
  return null;
}

module.exports = { parseExample, validate, SECRET_HINT };
