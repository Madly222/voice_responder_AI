'use strict';
const axios = require('axios');
const https = require('https');
const tls = require('tls');

const TIMEOUT = Number(process.env.HEALTH_TIMEOUT_MS) || 8000;
const ultravoxApi = (env) => (env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/api').replace(/\/+$/, '');

// Days left on the public entry point's certificate (null if it could not be read).
function certDaysLeft(host, port, servername) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = tls.connect({ host, port: Number(port), servername, rejectUnauthorized: false }, () => {
        const c = sock.getPeerCertificate();
        sock.end();
        if (!c || !c.valid_to) return finish(null);
        finish(Math.floor((new Date(c.valid_to) - Date.now()) / 86400000));
      });
      sock.setTimeout(TIMEOUT, () => { sock.destroy(); finish(null); });
      sock.on('error', () => finish(null));
    } catch { finish(null); }
  });
}

// Each check: { id, label, group, envKeys, run(env) -> {ok, detail} }
// detail is a short human-readable description (the error text when ok:false).
const CHECKS = [
  {
    id: 'faq-server',
    label: 'FAQ Server',
    group: 'Внутренние сервисы',
    help: 'Сервис вопросов-ответов. К нему обращается голосовой бот за всеми инструментами (поиск в FAQ, поиск клиента, диагностика). Если красный — бот отвечает голосом, но не может искать клиента и диагностировать.',
    envKeys: [],
    async run() {
      const url = process.env.FAQ_SERVER_URL || 'http://faq-server:3000';
      const r = await axios.get(`${url}/health`, { timeout: TIMEOUT });
      return { ok: true, detail: `faq_count=${r.data.faq_count ?? '?'}, tools=${(r.data.tools || []).length}` };
    },
  },
  {
    id: 'network-diag',
    label: 'Network Diag (SSH)',
    group: 'Внутренние сервисы',
    help: 'Сервис SSH-диагностики. Заходит на свитчи и проверяет порт/MAC клиента. Если красный — бот не сможет сказать, в чём проблема с подключением.',
    envKeys: ['NETWORK_USER', 'NETWORK_PASS', 'NETWORK_ENABLE'],
    async run() {
      const url = process.env.NETWORK_DIAG_URL || 'http://network-diag:5000';
      const r = await axios.get(`${url}/health`, { timeout: TIMEOUT });
      return { ok: r.data.status === 'ok', detail: `protocol=${r.data.protocol || '?'}` };
    },
  },
  {
    id: 'ultravox',
    label: 'Ultravox API',
    group: 'AI / облако',
    help: 'Облачный AI-агент (голос и мозг бота «Andreea»). Проверяется валидность API-ключа. Если красный — бот вообще не сможет говорить.',
    envKeys: ['ULTRAVOX_API_KEY', 'ULTRAVOX_AGENT_ID'],
    async run(env) {
      if (!env.ULTRAVOX_API_KEY) return { ok: false, detail: 'ULTRAVOX_API_KEY не задан' };
      const r = await axios.get(`${ultravoxApi(env)}/voices`, {
        headers: { 'X-API-Key': env.ULTRAVOX_API_KEY },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (r.status === 200) return { ok: true, detail: 'ключ валиден' };
      if (r.status === 401) return { ok: false, detail: 'ключ отклонён (401)' };
      return { ok: false, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'whmcs',
    label: 'Биллинг (WHMCS)',
    group: 'Интеграции',
    help: 'Биллинг. По номеру OSMP бот находит клиента (имя, IP, активен, оплачен). Красный → бот не опознаёт клиента. КАК УСТРОЕНО: связка — это PHP-файл на сервере биллинга (НЕ в проекте), путь к нему задан в .env → WHMCS_CUSTOM_API. Внутри файла: allowed_ips = IP машины с проектом (откуда идут запросы); api_key должен совпадать с WHMCS_API_KEY из .env; поле OSMP в базе = custom field клиента (id поля и групп клиентов — из настроек своего WHMCS). Если красный после переноса — проверь эти четыре вещи. Подробности — PROJECT.md, раздел 5.1 «WHMCS».',
    envKeys: ['BILLING_PROVIDER', 'WHMCS_CUSTOM_API', 'WHMCS_API_KEY'],
    async run(env) {
      if ((env.BILLING_PROVIDER || 'none').toLowerCase() !== 'whmcs')
        return { ok: true, off: true, detail: `выключено (BILLING_PROVIDER=${env.BILLING_PROVIDER || 'none'})` };
      const base = env.WHMCS_CUSTOM_API;
      if (!base) return { ok: false, detail: 'WHMCS_CUSTOM_API не задан' };
      // A real check: send an actual request with api_key and parse the answer
      // instead of just pinging the server. OSMP 00000 never exists; what matters is not the client
      // but that PHP ran, the key was accepted and the DB answered.
      let r;
      try {
        r = await axios.get(base, {
          params: { api_key: env.WHMCS_API_KEY || '', action: 'find_by_osmp', osmp_id: '00000' },
          timeout: TIMEOUT, validateStatus: () => true,
        });
      } catch (e) { return { ok: false, detail: `сервер недоступен (${e.code || e.message})` }; }
      if (r.status >= 500) return { ok: false, detail: `сервер недоступен (HTTP ${r.status})` };
      const d = r.data;
      if (typeof d !== 'object' || d === null) return { ok: false, detail: `не JSON (HTTP ${r.status}) — не тот URL?` };
      // api_client.php answers error:true on an access/key problem
      if (d.error === true) {
        const m = (d.message || '').toLowerCase();
        if (m.includes('unauthorized')) return { ok: false, detail: 'api_key не совпадает с .env' };
        if (m.includes('access denied')) return { ok: false, detail: 'IP проекта не в allowed_ips файла' };
        return { ok: false, detail: d.message || 'ошибка биллинга' };
      }
      // error:false (even with found:false) means the whole chain works: key accepted, DB answered
      return { ok: true, detail: 'связка работает (ключ принят, БД отвечает)' };
    },
  },
  {
    id: 'netbox',
    label: 'Учёт сети (NetBox)',
    group: 'Интеграции',
    help: 'Инвентарь сети. По IP клиента находит его свитч и порт для диагностики. Если красный — диагностика не найдёт, куда смотреть.',
    envKeys: ['NETWORK_SOURCE', 'NETBOX_API_URL', 'NETBOX_API_TOKEN'],
    async run(env) {
      if ((env.NETWORK_SOURCE || 'none').toLowerCase() !== 'netbox')
        return { ok: true, off: true, detail: `выключено (NETWORK_SOURCE=${env.NETWORK_SOURCE || 'none'})` };
      if (!env.NETBOX_API_URL || !env.NETBOX_API_TOKEN)
        return { ok: false, detail: 'NETBOX_API_URL/TOKEN не заданы' };
      const r = await axios.get(`${env.NETBOX_API_URL.replace(/\/$/, '')}/api/`, {
        headers: { Authorization: `Token ${env.NETBOX_API_TOKEN}` },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (r.status === 200) return { ok: true, detail: 'токен валиден' };
      if (r.status === 401 || r.status === 403) return { ok: false, detail: `токен отклонён (${r.status})` };
      return { ok: false, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'telegram',
    label: 'Telegram (уведомления)',
    group: 'Интеграции',
    help: 'Канал уведомлений. Сюда приходят сводки по звонкам и утренний отчёт. Если красный — уведомления не дойдут (проверь бот/токен).',
    envKeys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    async run(env) {
      if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN не задан' };
      const r = await axios.get(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, {
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (r.data && r.data.ok) return { ok: true, detail: `бот @${r.data.result.username}` };
      return { ok: false, detail: 'токен отклонён' };
    },
  },
  {
    id: 'tools-endpoint',
    label: 'Публичный вход (nginx)',
    group: 'Публичный вход',
    help: 'Публичный HTTPS-вход, через который облако Ultravox вызывает тулзы: nginx на этом сервере (порт 8443, сертификат Let\'s Encrypt, секретный заголовок X-AVR-Key). Проверка шлёт реальный запрос POST /tool/searchFAQ с ключом и ждёт 200, то есть проверяет сразу сертификат, nginx, ключ и faq-server. Если красный — бот говорит, но инструменты не отвечают. Красный «ключ не совпадает» → значение X-AVR-Key в тулзах Ultravox не равно /etc/nginx/avr_tool_key. Проверка идёт изнутри сети, поэтому доступность снаружи (проброс 8443 на MikroTik) она не покажет — это проверяется с внешней сети вручную.',
    envKeys: ['TOOLS_PUBLIC_URL', 'TOOLS_API_KEY'],
    async run(env) {
      if (!env.TOOLS_PUBLIC_URL) return { ok: false, detail: 'TOOLS_PUBLIC_URL не задан в .env' };
      const publicUrl = env.TOOLS_PUBLIC_URL.replace(/\/$/, '');
      const key = env.TOOLS_API_KEY;
      if (!key) return { ok: false, detail: 'TOOLS_API_KEY не задан в .env (ключ из /etc/nginx/avr_tool_key)' };

      let u;
      try { u = new URL(publicUrl); } catch { return { ok: false, detail: `TOOLS_PUBLIC_URL некорректен: ${publicUrl}` }; }
      const servername = u.hostname;
      const port = u.port || '443';
      // Inside the network the name resolves to the external IP, unreachable from the LAN (no hairpin NAT),
      // so connect to the internal address and take the name for SNI and certificate checks from the URL.
      const [addrHost, addrPort] = (env.TOOLS_CHECK_ADDR || `${servername}:${port}`).split(':');

      const agent = new https.Agent({ servername, keepAlive: false });
      let r;
      try {
        r = await axios.post(`https://${addrHost}:${addrPort || port}/tool/searchFAQ`,
          { query: 'health', lang: 'ro' },
          { headers: { 'Content-Type': 'application/json', 'X-AVR-Key': key, Host: servername },
            httpsAgent: agent, timeout: TIMEOUT, validateStatus: () => true });
      } catch (e) {
        const c = e.code || e.message;
        if (/CERT|ALT_NAME|SELF_SIGNED|EXPIRED/i.test(c)) return { ok: false, detail: `проблема с сертификатом (${c})` };
        return { ok: false, detail: `nginx не отвечает на ${addrHost}:${addrPort || port} (${c})` };
      }
      if (r.status === 403) return { ok: false, detail: 'ключ X-AVR-Key не совпадает с nginx' };
      if (r.status === 404) return { ok: false, detail: 'nginx не знает этот путь (конфиг avr-tools.conf)' };
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
      if (!r.data || r.data.error === true) return { ok: false, detail: 'faq-server ответил ошибкой' };

      const days = await certDaysLeft(addrHost, addrPort || port, servername);
      const certNote = days === null ? 'сертификат не прочитан'
        : days < 0 ? `СЕРТИФИКАТ ПРОСРОЧЕН ${-days} дн назад`
        : `сертификат ещё ${days} дн`;
      if (days !== null && days < 20) return { ok: false, detail: `${publicUrl} отвечает, но ${certNote} — проверь автопродление (certbot renew --dry-run)` };
      return { ok: true, detail: `${publicUrl} — 200, ${certNote}`, extra: { publicUrl } };
    },
  },
  {
    id: 'panel-security',
    label: 'Безопасность панели',
    group: 'Панель',
    help: 'Пароль панели и откуда она доступна. Красное — слабый пароль: смените его на вкладке «Переменные (.env)» → «Доступ к панели». Панель видит все ключи и управляет сервером — не пробрасывайте её порт в интернет. После 10 неверных паролей с одного адреса вход с него блокируется на 15 минут; все действия в панели пишутся в журнал (ниже).',
    envKeys: ['PANEL_PASS', 'PANEL_BIND', 'PANEL_PORT'],
    async run(env) { return require('./security').panelCheck(env); },
  }
];

async function runAll(env) {
  return Promise.all(CHECKS.map(async (c) => {
    const started = Date.now();
    try {
      const r = await c.run(env);
      return { id: c.id, label: c.label, group: c.group, help: c.help, envKeys: c.envKeys, ...r, ms: Date.now() - started };
    } catch (e) {
      return {
        id: c.id, label: c.label, group: c.group, help: c.help, envKeys: c.envKeys,
        ok: false, detail: e.code || e.message || 'ошибка', ms: Date.now() - started,
      };
    }
  }));
}

module.exports = { runAll, CHECKS };
