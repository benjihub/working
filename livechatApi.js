const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

// Minimal LiveChat API wrapper used by livechat-group-helpers.js
// Exports: sendMessage(chatId, message, payload)
// - If payload.typing === true/false, calls send_typing_indicator
// - Otherwise calls send_event to post a chat message

async function postWithVariants(path, body, { timeout = 15000 } = {}) {
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    throw new Error('LiveChat credentials not configured');
  }
  let lastErr = null;
  for (const headers of headerVariants) {
    try {
      const { data } = await axios.post(`https://api.livechatinc.com/v3.5${path}`, body, { headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout });
      return { ok: true, data };
    } catch (error) {
      lastErr = error;
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        // try next header variant
        continue;
      }
      // non-auth error: stop trying
      break;
    }
  }
  const msg = lastErr?.response?.data || lastErr?.message || 'Unknown error';
  return { ok: false, error: msg, status: lastErr?.response?.status || 500, raw: lastErr?.response?.data };
}

async function sendTypingIndicator(chatId, isTyping, visibility = 'all') {
  try {
    const body = { chat_id: chatId, is_typing: !!isTyping, visibility };
    return await postWithVariants('/agent/action/send_typing_indicator', body, { timeout: 7000 });
  } catch (e) {
    return { ok: false, error: e?.message || e };
  }
}

async function sendEventMessage(chatId, text, payload = {}) {
  const body = {
    chat_id: chatId,
    event: {
      type: 'message',
      text: text || '',
      recipients: payload.recipients || 'all'
    }
  };
  return await postWithVariants('/agent/action/send_event', body, {});
}

module.exports = {
  sendMessage: async function (chatId, message, payload = {}) {
    if (!chatId) throw new Error('chatId required');
    // Typing indicator path
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'typing')) {
      return await sendTypingIndicator(chatId, !!payload.typing, payload.visibility || 'all');
    }
    // Normal message
    return await sendEventMessage(chatId, message, payload);
  }
};
