// Adapters for external platforms: billing and network inventory.
//
// Our side (agent, call card, Telegram, diagnostics) works with one common format,
// and the adapter selected in .env decides where the data comes from:
//   BILLING_PROVIDER = whmcs | none      NETWORK_SOURCE = netbox | none
// none (or empty) disables the feature: the tool answers DISABLED and is not attached to the agent.
//
// Billing adapter:     { label, configured(), findClient(number), clientUrl(call) }
//   findClient → { found:false } | { found:true, client_name, client_type, client_id, client_ip,
//                  address, is_active, is_paid, debt, ... } ; a platform error throws.
// Network adapter:     { label, configured(), findByIp(ip), ipUrl(call), deviceUrl(call) }
//   findByIp → { found:false, message } | { found:true, can_diagnose, note, mac_address, switch_ip,
//                switch_name, port, pop, ref:{ ip_id, device_id } } ; a platform error throws.
// *Url(call) return a link template ({client_id}, {ip_id}, {device_id}) or null;
// a template from .env (BILLING_CLIENT_URL, NETWORK_IP_URL, NETWORK_DEVICE_URL) takes precedence.
//
// A new platform = a new adapter file + a line in BILLING/NETWORK below.
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

// Client ID: what the agent calls it and its format (regex without ^ and $).
const CLIENT_ID_LABEL = process.env.CLIENT_ID_LABEL || 'Client ID';
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

// Platform errors go on the call card and end up in the report's SYSTEM ERRORS block.
function saveToCall(fields) {
  try { callLogger.updateCall.execute({ call_id: 'latest', ...fields }); }
  catch (e) { /* there may be no active call */ }
}

async function findClient(params) {
  if (!billing.impl) return disabled('Client lookup in billing');
  // osmp_id: parameter name used by Ultravox tools created before the client-ID rename.
  const raw = params && (params.client_number ?? params.osmp_id);
  const number = raw == null ? '' : String(raw).trim();
  if (!number) return { error: true, message: `${CLIENT_ID_LABEL} not specified` };
  if (!CLIENT_ID_RE.test(number)) return { error: true, message: `${CLIENT_ID_LABEL} has a wrong format` };
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
        client_number: c.client_number || number,
        client_name: c.client_name,
        client_type: c.client_type,
        client_id: c.client_id || null,
        client_ip: c.client_ip,
        address: c.address || null,
        is_active: c.is_active,
        is_paid: c.is_paid
      });
    } else {
      saveToCall({ client_number: number });
    }
    return { error: false, data: c || { found: false } };
  } catch (err) {
    console.error(`[billing:${billing.name}] ошибка:`, err.message);
    saveToCall({ client_number: number, whmcs_error: String(err.code || err.message).slice(0, 200) });
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
    // Card fields are named after NetBox for historical reasons (old calls.txt records); the meaning is generic.
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

// Report links: a template from .env takes precedence over the adapter's.
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
