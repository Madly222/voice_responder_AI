const axios = require('axios');

// Network inventory adapter: NetBox. Shared logic (call card, errors) lives in providers.js.

const NETBOX_API_URL = (process.env.NETBOX_API_URL || '').replace(/\/+$/, '');
const NETBOX_API_TOKEN = process.env.NETBOX_API_TOKEN;
// Per-request limit. NetBox usually answers in 0.1-0.3 s; the tool makes 2 sequential steps,
// so the worst case is ~2x the limit, which must stay below the getNetworkData timeout in Ultravox (15 s).
const NETBOX_TIMEOUT_MS = Number(process.env.NETBOX_TIMEOUT_MS) || 5000;

async function callNetboxApi(endpoint, params = {}) {
  if (!NETBOX_API_URL || !NETBOX_API_TOKEN) {
    console.log('[NetBox] API not configured');
    return null;
  }

  const url = `${NETBOX_API_URL}/api/${endpoint}`;
  console.log(`[NetBox] Calling: ${url}`);

  const response = await axios.get(url, {
    headers: {
      'Authorization': `Token ${NETBOX_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    params: params,
    timeout: NETBOX_TIMEOUT_MS
  });

  return response.data;
}

// Networks holding switch management addresses (can be overridden in .env)
const MGMT_NETS = (process.env.SWITCH_MGMT_NETS || '198.51.100.0/24')
  .split(/[,;]/).map((x) => x.trim()).filter(Boolean);

function ipToLong(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inMgmtNets(ip) {
  const a = ipToLong(ip);
  if (a === null) return false;
  return MGMT_NETS.some((cidr) => {
    const [net, bitsRaw] = cidr.split('/');
    const b = ipToLong(net);
    if (b === null) return false;
    const bits = Number(bitsRaw === undefined ? 32 : bitsRaw);
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

// Switch management address: primary_ip4, or if there is none (true for most devices),
// look for a device address in the management network. Otherwise return null and do NOT invent one.
async function getMgmtIpByDeviceId(deviceId) {
  if (!deviceId) return null;
  try {
    const res = await callNetboxApi('ipam/ip-addresses/', { device_id: deviceId, limit: 50 });
    const list = (res && res.results) || [];
    const mgmtFirst = list.slice().sort((x, y) => {
      const rx = /vlan|mgmt|manage|loopback/i.test((x.assigned_object && x.assigned_object.name) || '') ? 0 : 1;
      const ry = /vlan|mgmt|manage|loopback/i.test((y.assigned_object && y.assigned_object.name) || '') ? 0 : 1;
      return rx - ry;
    });
    for (const item of mgmtFirst) {
      const ip = (item.address || '').split('/')[0];
      if (inMgmtNets(ip)) return ip;
    }
  } catch (err) {
    console.error('[NetBox] getMgmtIpByDeviceId error:', err.message);
  }
  return null;
}

// Hardware network-diag can query: Cisco IOS/NX-OS and ZTE.
// In NetBox, Nexus and D-Link are recorded with manufacturer "Generic", so the model is checked too.
// MikroTik, D-Link, Juniper and the rest are not supported (the agent offers a callback straight away).
function isDiagSupported(device) {
  const dt = (device && device.device_type) || {};
  const vendor = ((dt.manufacturer && dt.manufacturer.name) || '').toLowerCase();
  const model = dt.model || '';
  return vendor === 'cisco' || vendor === 'zte' || /^N\dK-|nexus/i.test(model);
}

// Device by id: site (POP), primary_ip4 and diagnostics support in one request.
// If NetBox does not answer, supported = null (unknown) and diagnostics are not blocked.
async function getDeviceDetails(deviceId) {
  if (!deviceId) return { site: null, primary_ip: null, supported: null };
  try {
    const device = await callNetboxApi(`dcim/devices/${deviceId}/`);
    return {
      site: (device && device.site && device.site.name) || null,
      primary_ip: (device && device.primary_ip4 && device.primary_ip4.address
        && device.primary_ip4.address.split('/')[0]) || null,
      supported: device ? isDiagSupported(device) : null
    };
  } catch (err) {
    console.log('[NetBox] Could not get device details:', err.message);
    return { site: null, primary_ip: null, supported: null };
  }
}

function extractMacAddress(ipData) {
  if (!ipData.custom_fields) return null;
  
  const possibleFields = ['mac_address', 'Mac', 'MAC', 'mac', 'client_mac', 'client_mac_address'];
  
  for (const field of possibleFields) {
    if (ipData.custom_fields[field]) {
      const mac = ipData.custom_fields[field];
      console.log(`[NetBox] Found MAC in custom_fields.${field}: ${mac}`);
      return mac;
    }
  }
  
  console.log('[NetBox] MAC address not found in custom_fields');
  return null;
}

// Client network data by IP. Response format: see providers.js. An API error throws.
async function findByIp(ip) {
  console.log(`[NetBox] findByIp: ${ip}`);
  {
    const ipResult = await callNetboxApi('ipam/ip-addresses/', { address: ip });

    console.log('[NetBox] IP Result:', JSON.stringify(ipResult).substring(0, 300));

    if (!ipResult || !ipResult.results || ipResult.results.length === 0) {
      return { found: false, message: `IP ${ip} not found in NetBox` };
    }

    const ipData = ipResult.results[0];
    const mac_address = extractMacAddress(ipData);

    const netbox_device_id_early = (ipData.assigned_object && ipData.assigned_object.device
      && ipData.assigned_object.device.id) || null;
    let device_name = null;
    let port = null;

    if (ipData.assigned_object) {
      port = ipData.assigned_object.name || null;

      if (ipData.assigned_object.device) {
        device_name = ipData.assigned_object.device.name || null;
      }
    }

    // Second step: both requests in parallel; errors here do not fail the tool (MAC/port are already known).
    const [details, mgmtIp] = await Promise.all([
      getDeviceDetails(netbox_device_id_early),
      getMgmtIpByDeviceId(netbox_device_id_early)
    ]);
    const site = details.site;
    const primaryOk = details.primary_ip && inMgmtNets(details.primary_ip);
    let switch_ip = primaryOk ? details.primary_ip : mgmtIp;
    if (!primaryOk && mgmtIp) console.log(`[NetBox] primary_ip4 пуст или вне сетей управления, взят mgmt-адрес устройства: ${mgmtIp}`);
    if (switch_ip && !inMgmtNets(switch_ip)) {
      console.warn(`[NetBox] ${switch_ip} вне сетей управления — не используем как switch_ip`);
      switch_ip = null;
    }

    console.log(`[NetBox] Result: MAC=${mac_address}, Switch=${device_name}, Port=${port}`);

    const netbox_ip_id = ipData.id || null;
    const netbox_device_id = netbox_device_id_early;

    const unsupported = details.supported === false;
    if (unsupported) console.log(`[NetBox] ${device_name}: тип оборудования не поддерживается network-diag`);
    const can_diagnose = !!(switch_ip && mac_address) && !unsupported;
    let note;
    if (!can_diagnose) {
      note = unsupported
        ? 'Remote diagnostics is not supported for this switch type - do NOT call diagnoseClient, offer a callback'
        : 'No management IP for this switch in NetBox - do NOT call diagnoseClient, offer a callback';
    }

    return {
      found: true,
      can_diagnose,
      note,
      mac_address: mac_address,
      switch_ip: switch_ip,
      switch_name: device_name,
      port: port,
      pop: site,
      ref: { ip_id: netbox_ip_id, device_id: netbox_device_id }
    };
  }
}

function netboxWeb() {
  return (process.env.NETBOX_WEB_URL || NETBOX_API_URL || '').replace(/\/+$/, '');
}
function ipUrl(call) {
  return netboxWeb() && call.netbox_ip_id ? `${netboxWeb()}/ipam/ip-addresses/{ip_id}/` : null;
}
function deviceUrl(call) {
  return netboxWeb() && call.netbox_device_id ? `${netboxWeb()}/dcim/devices/{device_id}/` : null;
}

module.exports = {
  label: 'NetBox',
  configured: () => !!(NETBOX_API_URL && NETBOX_API_TOKEN),
  findByIp,
  ipUrl,
  deviceUrl
};
