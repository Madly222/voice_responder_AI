const axios = require('axios');

// Billing adapter: WHMCS. The WHMCS side is api_client.php on the billing server (outside this project,
// PROJECT.md §5.1). Shared logic (number validation, call card, errors) lives in providers.js.
const WHMCS_CUSTOM_API = process.env.WHMCS_CUSTOM_API;
const WHMCS_API_KEY = process.env.WHMCS_API_KEY;
const BILLING_TIMEOUT_MS = Number(process.env.BILLING_TIMEOUT_MS) || 15000;
// Request names understood by api_client.php. The defaults match connectors deployed before the
// client-ID rename, so existing installs keep working without touching the billing side.
const WHMCS_FIND_ACTION = process.env.WHMCS_FIND_ACTION || 'find_by_osmp';
const WHMCS_ID_PARAM = process.env.WHMCS_ID_PARAM || 'osmp_id';

// Client by client ID (contract number). Response format: see providers.js.
async function findClient(clientNumber) {
  const response = await axios.get(WHMCS_CUSTOM_API, {
    params: { api_key: WHMCS_API_KEY, action: WHMCS_FIND_ACTION, [WHMCS_ID_PARAM]: clientNumber },
    timeout: BILLING_TIMEOUT_MS
  });
  const d = response.data || {};
  if (d.error) throw new Error(d.message || 'billing error');
  const c = d.data || { found: false };
  if (c.found && !c.address && c.client_address) c.address = c.client_address;
  if (c.found && !c.client_number) c.client_number = c[WHMCS_ID_PARAM] || c.osmp_id;
  return c;
}

function clientUrl(call) {
  const base = (process.env.WHMCS_ADMIN_URL || '').replace(/\/+$/, '');
  if (!base || !call.client_id) return null;
  return `${base}/clientssummary.php?userid={client_id}`;
}

module.exports = {
  label: 'WHMCS',
  configured: () => !!WHMCS_CUSTOM_API,
  findClient,
  clientUrl
};
