const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 10000;

/**
 * Send call report to Telegram
 * 
 * @param {Object} chatbotData - Formatted call data
 * @param {string} chatbotData.text - HTML formatted message
 * @param {number} chatbotData.call_number - Call number
 * @param {string} chatbotData.phone - Client phone
 * @param {string} chatbotData.client_number - client ID
 * @param {boolean} chatbotData.needs_callback - Whether callback is needed
 * 
 * @returns {Promise<Object>} Result with error flag and data
 */
async function sendToTelegram(chatbotData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Not configured - skipping send');
    return { error: false, skipped: true, message: 'Telegram not configured' };
  }
  
  console.log(`[Telegram] Sending call #${chatbotData.call_number}...`);
  
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: chatbotData.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, {
      timeout: TELEGRAM_TIMEOUT_MS
    });
    
    console.log('[Telegram] Message sent successfully');
    
    return {
      error: false,
      data: {
        message_id: response.data.result.message_id,
        call_number: chatbotData.call_number
      }
    };
    
  } catch (err) {
    console.error('[Telegram] Error:', err.message);
    
    if (err.response) {
      console.error('[Telegram] Response:', JSON.stringify(err.response.data));
    }
    
    return {
      error: true,
      message: `Failed to send to Telegram: ${err.message}`
    };
  }
}

/**
 * Send urgent callback alert to Telegram
 * 
 * @param {Object} chatbotData - Call data
 * @returns {Promise<Object>} Result with error flag
 */
async function sendCallbackAlert(chatbotData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { error: false, skipped: true };
  }
  
  if (!chatbotData.needs_callback) {
    return { error: false, skipped: true, message: 'No callback needed' };
  }
  
  const alertText = `⚠️ <b>URGENT CALLBACK REQUIRED</b>\n\n` +
    `Call #${chatbotData.call_number}\n` +
    `Phone: ${chatbotData.phone}\n` +
    `${process.env.CLIENT_ID_LABEL || 'Client ID'}: ${chatbotData.client_number}\n` +
    `Reason: ${chatbotData.callback_reason || 'Client requested operator'}`;
  
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: alertText,
        parse_mode: 'HTML'
      },
      { timeout: TELEGRAM_TIMEOUT_MS }
    );
    
    console.log('[Telegram] Callback alert sent');
    return { error: false };
    
  } catch (err) {
    console.error('[Telegram] Alert error:', err.message);
    return { error: true, message: err.message };
  }
}

module.exports = {
  sendToTelegram,
  sendCallbackAlert
};
