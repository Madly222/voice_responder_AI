'use strict';
const fs = require('fs');
const path = require('path');

function read(faqPath) {
  if (!fs.existsSync(faqPath)) return { faq: [] };
  return JSON.parse(fs.readFileSync(faqPath, 'utf8'));
}

// Validates the structure before writing so bad data never reaches faq.json
// (the live faq-server reloads it on mtime change and would keep serving the old FAQ).
function validate(data) {
  if (!data || !Array.isArray(data.faq)) throw new Error('ожидается { faq: [...] }');
  const ids = new Set();
  data.faq.forEach((e, i) => {
    if (!e.id || typeof e.id !== 'string') throw new Error(`запись #${i + 1}: пустой id`);
    if (ids.has(e.id)) throw new Error(`дублирующийся id: "${e.id}"`);
    ids.add(e.id);
    if (!e.keywords || !Array.isArray(e.keywords.ru) || !Array.isArray(e.keywords.ro))
      throw new Error(`запись "${e.id}": keywords.ru и keywords.ro должны быть списками`);
    if (!e.answers || typeof e.answers.ru !== 'string' || typeof e.answers.ro !== 'string')
      throw new Error(`запись "${e.id}": answers.ru и answers.ro должны быть строками`);
  });
  return true;
}

function write(faqPath, data) {
  validate(data);
  const backupDir = path.join(path.dirname(faqPath), '.faq-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(faqPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(faqPath, path.join(backupDir, `faq-${stamp}.json.bak`));
  }
  // normalise: drop empty keywords, trim whitespace
  data.faq.forEach((e) => {
    e.keywords.ru = e.keywords.ru.map((s) => s.trim()).filter(Boolean);
    e.keywords.ro = e.keywords.ro.map((s) => s.trim()).filter(Boolean);
    if (typeof e.requires_client_id !== 'boolean' && typeof e.requires_osmp === 'boolean') e.requires_client_id = e.requires_osmp;
    delete e.requires_osmp;
    if (typeof e.requires_client_id !== 'boolean') delete e.requires_client_id;
  });
  fs.writeFileSync(faqPath, JSON.stringify(data, null, 2) + require('os').EOL);   // trailing newline, as git expects
  return { ok: true, count: data.faq.length };
}

module.exports = { read, write, validate };
