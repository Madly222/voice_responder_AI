const faq = require('./faq');
const callLogger = require('./callLogger');
const providers = require('./providers');
const axios = require('axios');

const NETWORK_DIAG_URL = process.env.NETWORK_DIAG_URL || 'http://localhost:5000';
// How long to wait for network-diag: above SSH_TOTAL_TIMEOUT, below the diagnoseClient timeout in Ultravox.
const DIAG_TIMEOUT_MS = Number(process.env.DIAG_TIMEOUT_MS) || 12000;

// Switch management networks: the only place diagnostics may connect to.
const MGMT_NETS = (process.env.SWITCH_MGMT_NETS || '10.99.0.0/24')
  .split(/[,;]/).map((x) => x.trim()).filter(Boolean);

function ipToLong(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255 || !/^\d+$/.test(o)) return null;
    n = n * 256 + v;
  }
  return n;
}

function isMgmtIp(ip) {
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

module.exports = {
  // Wrapper: the search itself is unchanged, but the caller's phrase (query) is stored
  // on the call card; this is what Telegram shows as "what the client said".
  searchFAQ: {
    ...faq.searchFAQ,
    execute: async (params) => {
      const result = await faq.searchFAQ.execute(params);
      try {
        const saved = callLogger.noteUserRequest(params && params.query, result && result.data && result.data.id);
        if (saved === false) {
          console.warn('[searchFAQ] нет активного звонка — фраза клиента не сохранена:',
            params && params.query);
        }
      } catch (err) {
        console.error('[searchFAQ] noteUserRequest failed:', err.message);
      }
      return result;
    },
  },
  // The tool name is historical (that is its name in Ultravox); it looks the client up in the selected billing system.
  findByOSMP: {
    name: 'findByOSMP',
    description: `Find client in billing by ${providers.CLIENT_ID_LABEL} ID`,
    parameters: {
      type: 'object',
      properties: {
        osmp_id: { type: 'string', description: `Client ${providers.CLIENT_ID_LABEL} ID` }
      },
      required: ['osmp_id']
    },
    execute: providers.findClient
  },

  getNetworkData: {
    name: 'getNetworkData',
    description: 'Get network data by client IP: switch, port, POP, whether diagnostics is possible',
    parameters: {
      type: 'object',
      properties: {
        client_ip: { type: 'string', description: 'Client IP address from findByOSMP' }
      },
      required: ['client_ip']
    },
    execute: providers.findNetwork
  },

  diagnoseClient: {
    name: 'diagnoseClient',
    description: 'Client diagnostics via SSH: check MAC, port, VLAN. Usually takes 1-2 seconds.',
    parameters: {
      type: 'object',
      properties: {
        switch_ip: { type: 'string', description: 'Switch IP address from getNetworkData' },
        switch_name: { type: 'string', description: 'Switch hostname from getNetworkData' },
        mac_address: { type: 'string', description: 'Client MAC address from getNetworkData' },
        port: { type: 'string', description: 'Port number from getNetworkData (optional)' }
      },
      required: ['switch_ip', 'mac_address']
    },
    execute: async (params) => {
      // Without the network inventory there is no switch or MAC to use, so diagnostics are disabled with it.
      if (!providers.networkEnabled()) return providers.disabled('Remote diagnostics');
      console.log('[diagnoseClient] Calling network-diag (SSH) with params:', JSON.stringify(params));

      // switch_ip must be a real switch address from the management network.
      // The LLM may put "null", a switch name or the client IP here; such requests are rejected.
      const ip = String((params && params.switch_ip) || '').trim();
      if (!isMgmtIp(ip)) {
        const msg = `switch IP is unknown or not allowed ("${ip || 'empty'}"`
          + (params.switch_name ? `, switch ${params.switch_name}` : '') + ')';
        console.error('[diagnoseClient] ОТКАЗ:', msg);
        try {
          callLogger.updateCall.execute({ call_id: 'latest', diag_error: msg });
        } catch (e) { /* there may be no active call */ }
        return {
          error: true,
          code: 'SWITCH_IP_UNKNOWN',
          message: 'Switch management IP is unknown - diagnostics not possible. Offer a callback from a technician.',
        };
      }

      try {
        const response = await axios.post(`${NETWORK_DIAG_URL}/diagnose`, {
          switch_ip: params.switch_ip,
          switch_name: params.switch_name || params.switch_ip,
          mac_address: params.mac_address,
          port: params.port
        }, {
          // network-diag keeps within SSH_TOTAL_TIMEOUT (10 s); usually 1-2 s (measured 25.09.2026).
          // Must stay below the diagnoseClient timeout in Ultravox.
          timeout: DIAG_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json' }
        });

        console.log('[diagnoseClient] Response:', JSON.stringify(response.data));

        // network-diag reports errors as HTTP 200 + error:true; these used to get lost.
        if (response.data && response.data.error === true) {
          const msg = `${response.data.message || 'unknown error'} (switch ${params.switch_ip}${params.port ? ', port ' + params.port : ''})`;
          console.error('[diagnoseClient] network-diag вернул ошибку:', msg);
          try {
            callLogger.updateCall.execute({ call_id: 'latest', diag_error: msg });
          } catch (err) {
            console.error('[diagnoseClient] Failed to save diag_error:', err.message);
          }
          return response.data;
        }

        // Auto-save diagnostics to call log
        if (response.data && response.data.data) {
          const diagData = response.data.data;
          try {
            callLogger.updateCall.execute({
              call_id: 'latest',
              port_status: diagData.port_status || null,
              mac_found: diagData.mac_found || false,
              diagnosis: diagData.diagnosis || null
            });
            console.log('[diagnoseClient] Auto-saved diagnostics to call log');
          } catch (err) {
            console.error('[diagnoseClient] Failed to auto-save:', err.message);
          }
        }

        return response.data;
      } catch (error) {
        console.error('[diagnoseClient] Error:', error.message);

        // Determine error type
        let errorMsg;
        if (error.code === 'ECONNREFUSED') {
          errorMsg = 'Cannot connect to network-diag service';
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
          errorMsg = 'SSH connection timeout to switch';
        } else if (error.response && error.response.data && error.response.data.message) {
          errorMsg = error.response.data.message;
        } else {
          errorMsg = `Diagnostics error: ${error.message}`;
        }

        // Save error to call log
        try {
          callLogger.updateCall.execute({
            call_id: 'latest',
            diag_error: `${errorMsg} (switch ${params.switch_ip}${params.port ? ', port ' + params.port : ''})`
          });
          console.log('[diagnoseClient] Error saved to call log');
        } catch (err) {
          console.error('[diagnoseClient] Failed to save error:', err.message);
        }

        if (error.response) {
          return error.response.data;
        }
        return { error: true, message: errorMsg };
      }
    }
  },

  updateCall: callLogger.updateCall,
  startCall: callLogger.startCall,
  endCall: callLogger.endCall,
  getCalls: callLogger.getCalls,
  checkRecentCall: callLogger.checkRecentCall  // <-- NEW
};
