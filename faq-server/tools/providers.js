// Переходники к внешним платформам: биллинг и учёт сети.
//
// Наша часть (агент, карточка звонка, Telegram, диагностика) работает с единым форматом,
// а откуда пришли данные — решает переходник, выбранный в .env:
//   BILLING_PROVIDER = whmcs | none      NETWORK_SOURCE = netbox | none
// none (или пусто) — функция выключена: тулз отвечает DISABLED, агенту эти тулзы не подключают.
//
// Переходник биллинга:  { label, configured(), findClient(number), clientUrl(call) }
//   findClient → { found:false } | { found:true, client_name, client_type, client_id, client_ip,
//                  address, is_active, is_paid, debt, ... } ; ошибка платформы — исключение.
// Переходник сети:      { label, configured(), findByIp(ip), ipUrl(call), deviceUrl(call) }
//   findByIp → { found:false, message } | { found:true, can_diagnose, note, mac_address, switch_ip,
//                switch_name, port, pop, ref:{ ip_id, device_id } } ; ошибка платформы — исключение.
// *Url(call) возвращают шаблон ссылки ({client_id}, {ip_id}, {device_id}) или null;
// шаблон из .env (BILLING_CLIENT_URL, NETWORK_IP_URL, NETWORK_DEVICE_URL) важнее.
//
// Новая платформа = новый файл-переходник + строка в BILLING/NETWORK ниже.
const callLogger = require('./callLogger');

const BILLING = { whmcs: require('./whmcs') };
const NETWORK = { netbox: require('./netbox') };

function pick(table, envName) {
  const name = String(process.env[envName] || 'none').trim().toLowerCase();
  if (name === 'none' || name === '') return { name: 'none', impl: null };
  if (!table[name]) {
    console.error(`[providers] ${envName}=${name}: такого переходника нет (есть: ${Object.keys(table).join(', ')}) — выключено`);
    return { name: 'none', impl: null };
  }
  return { name, impl: table[name] };
}

const billing = pick(BILLING, 'BILLING_PROVIDER');
const network = pick(NETWORK, 'NETWORK_SOURCE');
console.log(`[providers] биллинг: ${billing.name}, сеть: ${network.name}`);

// Номер клиента: как агент его называет и какой у него формат (регулярка без ^ и $).
const CLIENT_ID_LABEL = process.env.CLIENT_ID_LABEL || 'OSMP';
let CLIENT_ID_RE;
try {
  CLIENT_ID_RE = new RegExp(`^(?:${process.env.CLIENT_ID_PATTERN || '[0-9]{5}'})$`);
} catch (e) {
  console.error('[providers] CLIENT_ID_PATTERN некорректен, беру [0-9]{5}:', e.message);
  CLIENT_ID_RE = /^\d{5}$/;
}

const disabled = (what) => ({
  error: true,
  code: 'DISABLED',
  message: `${what} is disabled on this installation - do not retry, offer a callback from a technician.`
});

// Ошибку платформы пишем в карточку звонка — она уйдёт в блок SYSTEM ERRORS отчёта.
function saveToCall(fields) {
  try { callLogger.updateCall.execute({ call_id: 'latest', ...fields }); }
  catch (e) { /* активного звонка может не быть */ }
}

async function findClient(params) {
  if (!billing.impl) return disabled('Client lookup in billing');
  const raw = params && (params.osmp_id ?? params.client_number);
  const number = raw == null ? '' : String(raw).trim();
  if (!number) return { error: true, message: `${CLIENT_ID_LABEL} ID not specified` };
  if (!CLIENT_ID_RE.test(number)) return { error: true, message: `${CLIENT_ID_LABEL} ID has a wrong format` };
  if (!billing.impl.configured()) {
    saveToCall({ whmcs_error: `${billing.impl.label}: not configured` });
    return { error: true, message: 'Billing is not configured' };
  }
  console.log(`[billing:${billing.name}] поиск клиента ${number}`);
  try {
    const c = await billing.impl.findClient(number);
    console.log(`[billing:${billing.name}] ответ:`, JSON.stringify(c));
    if (c && c.found) {
      saveToCall({
        osmp_id: c.osmp_id || number,
        client_name: c.client_name,
        client_type: c.client_type,
        client_id: c.client_id || null,
        client_ip: c.client_ip,
        address: c.address || null,
        is_active: c.is_active,
        is_paid: c.is_paid
      });
    } else {
      saveToCall({ osmp_id: number });
    }
    return { error: false, data: c || { found: false } };
  } catch (err) {
    console.error(`[billing:${billing.name}] ошибка:`, err.message);
    saveToCall({ osmp_id: number, whmcs_error: String(err.code || err.message).slice(0, 200) });
    return { error: true, message: 'Could not find client' };
  }
}

async function findNetwork(params) {
  if (!network.impl) return disabled('Network lookup');
  const ip = String((params && (params.client_ip || params.ip)) || '').trim();
  if (!ip) return { error: true, message: 'IP address not specified' };
  if (!network.impl.configured()) {
    saveToCall({ netbox_error: `${network.impl.label} API not configured` });
    return { error: true, message: `${network.impl.label} API not configured` };
  }
  try {
    const n = await network.impl.findByIp(ip);
    if (!n || !n.found) {
      saveToCall({ netbox_error: (n && n.message) || `IP ${ip} not found` });
      return { error: false, data: { found: false, message: (n && n.message) || `IP ${ip} not found` } };
    }
    const { ref, ...data } = n;
    // Поля карточки названы по NetBox исторически (старые записи calls.txt), смысл общий.
    saveToCall({
      netbox_ip_id: (ref && ref.ip_id) || null,
      netbox_device_id: (ref && ref.device_id) || null,
      mac_address: data.mac_address,
      switch_name: data.switch_name,
      switch_ip: data.switch_ip,
      port: data.port,
      pop: data.pop
    });
    return { error: false, data };
  } catch (err) {
    console.error(`[network:${network.name}] ошибка:`, err.message);
    saveToCall({ netbox_error: `${network.impl.label} API error: ${err.message}` });
    return { error: true, message: `Could not search in ${network.impl.label}` };
  }
}

// Ссылки для отчёта: шаблон из .env важнее шаблона переходника.
function fill(tpl, vals) {
  if (!tpl) return null;
  let missing = false;
  const url = tpl.replace(/\{(\w+)\}/g, (m, k) => {
    if (vals[k] == null || vals[k] === '') { missing = true; return ''; }
    return encodeURIComponent(vals[k]);
  });
  return missing ? null : url;
}
function linkFor(envName, impl, method, call) {
  const tpl = process.env[envName] || (impl && impl[method] ? impl[method](call) : null);
  return fill(tpl, { client_id: call.client_id, ip_id: call.netbox_ip_id, device_id: call.netbox_device_id });
}

module.exports = {
  billingEnabled: () => !!billing.impl,
  networkEnabled: () => !!network.impl,
  billingLabel: () => (billing.impl ? billing.impl.label : 'Billing'),
  networkLabel: () => (network.impl ? network.impl.label : 'Network'),
  CLIENT_ID_LABEL,
  disabled,
  findClient,
  findNetwork,
  clientUrl: (call) => linkFor('BILLING_CLIENT_URL', billing.impl, 'clientUrl', call),
  ipUrl: (call) => linkFor('NETWORK_IP_URL', network.impl, 'ipUrl', call),
  deviceUrl: (call) => linkFor('NETWORK_DEVICE_URL', network.impl, 'deviceUrl', call)
};
