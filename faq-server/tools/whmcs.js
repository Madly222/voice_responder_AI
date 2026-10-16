const axios = require('axios');

// Переходник биллинга: WHMCS. Сторона WHMCS — api_client.php на сервере биллинга (вне проекта,
// PROJECT.md §5.1). Общая логика (проверка номера, карточка звонка, ошибки) — в providers.js.
const WHMCS_CUSTOM_API = process.env.WHMCS_CUSTOM_API;
const WHMCS_API_KEY = process.env.WHMCS_API_KEY;
const BILLING_TIMEOUT_MS = Number(process.env.BILLING_TIMEOUT_MS) || 15000;

// Клиент по номеру договора (у нас — OSMP). Формат ответа — см. providers.js.
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

// Ссылка на карточку клиента в админке WHMCS.
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
