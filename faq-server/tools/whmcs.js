const axios = require('axios');

// Billing adapter: WHMCS. The WHMCS side is api_client.php on the billing server (outside this project,
// PROJECT.md §5.1). Shared logic (number validation, call card, errors) lives in providers.js.
const WHMCS_CUSTOM_API = process.env.WHMCS_CUSTOM_API;
const WHMCS_API_KEY = process.env.WHMCS_API_KEY;
const BILLING_TIMEOUT_MS = Number(process.env.BILLING_TIMEOUT_MS) || 15000;

// Client by contract number (OSMP here). Response format: see providers.js.
async function findClient(clientNumber) {
  const response = await axios.get(WHMCS_CUSTOM_API, {
    params: { api_key: WHMCS_API_KEY, action: 'find_by_osmp', osmp_id: clientNumber },
    timeout: BILLING_TIMEOUT_MS
  });
  const d = response.data || {};
  if (d.error) throw new Error(d.message || 'billing error');
  const c = d.data || { found: false };
  if (c.found && !c.address && c.client_address) c.address = c.client_address;
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
