// livechatApi.js
// Helper to send messages via LiveChat API with robust auth fallbacks (Basic preferred)
const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

async function sendMessage(chatId, text) {
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    throw new Error('LiveChat credentials not set (LIVECHAT_USERNAME/PASSWORD, LIVECHAT_PAT, or LIVECHAT_ACCESS_TOKEN)');
  }

  const body = {
    chat_id: chatId,
    event: {
      type: 'message',
      text: text,
      recipients: 'all'
    }
  };

  const apiVersions = ['v3.6', 'v3.5'];
  let lastErr = null;
  for (const ver of apiVersions) {
    for (const headers of headerVariants) {
      try {
        const res = await axios.post(`https://api.livechatinc.com/${ver}/agent/action/send_event`, body, {
          headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: 15000
        });
        return res.data;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        // On auth or not found, try next header/version; on other errors, break out of headers loop
        if (status === 401 || status === 403 || status === 404) {
          continue;
        }
        break;
      }
    }
  }
  const details = lastErr?.response?.data || lastErr?.message || 'Unknown error';
  console.error('LiveChat sendMessage error:', details);
  throw lastErr || new Error('Failed to send message to LiveChat');
}

module.exports = { sendMessage };
