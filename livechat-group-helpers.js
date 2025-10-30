const {
  findGroupByLivechatGroupId,
  setGroupLivechatGroupId,
  getGroupLivechatGroupId,
  listGroupLivechatMappings,
  setChatGroup,
  getChatStatus
} = require('./db-utils');
// livechatApi is optional in some deployments. Load defensively and provide
// a no-op fallback so the server can start even if the module is missing.
let sendLivechatMessage = async (chatId, message, payload) => {
  console.log('[WARN] livechatApi missing — sendLivechatMessage noop called', { chatId, preview: String(message || '').slice(0, 200) });
};
try {
  const lcApi = require('./livechatApi');
  if (lcApi && typeof lcApi.sendMessage === 'function') {
    sendLivechatMessage = lcApi.sendMessage.bind(lcApi);
  }
} catch (err) {
  console.log('Optional module ./livechatApi not found - continuing with noop sendLivechatMessage');
}

function normalizeCandidate(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str || str === 'null' || str === 'undefined') return null;
  return str;
}

function collectCandidates(chat) {
  const candidates = [];
  if (!chat || typeof chat !== 'object') return candidates;

  const push = (val) => {
    const normalized = normalizeCandidate(val);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const scoped = [
    chat,
    chat.chat,
    chat.thread,
    chat.event,
    chat.message,
    chat.properties,
    chat.chat?.properties,
    chat.event?.properties,
    chat.thread?.properties,
    chat.message?.properties
  ];

  for (const scope of scoped) {
    if (!scope || typeof scope !== 'object') continue;
    if ('group_id' in scope) push(scope.group_id);
    if ('groupId' in scope) push(scope.groupId);
    if ('group' in scope) {
      const grp = scope.group;
      if (grp && typeof grp === 'object' && 'id' in grp) {
        push(grp.id);
      } else {
        push(grp);
      }
    }
    if ('lc_group_id' in scope) push(scope.lc_group_id);
  }

  // Access metadata from Agent Chat API responses
  if (Array.isArray(chat.access?.group_ids) && chat.access.group_ids.length) {
    push(chat.access.group_ids[0]);
  }
  if (Array.isArray(chat.chat?.access?.group_ids) && chat.chat.access.group_ids.length) {
    push(chat.chat.access.group_ids[0]);
  }

  if (chat.chat_vars && typeof chat.chat_vars === 'object') {
    push(chat.chat_vars.group);
    push(chat.chat_vars.group_id);
  }

  // Also scan nested objects for any keys that look like group identifiers
  try {
    const found = scanForGroupId(chat || {});
    for (const f of found) push(f);
  } catch (_) {}

  return candidates;
}

// Best-effort recursive scan to find any property that looks like a livechat group id
function scanForGroupId(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 6) return [];
  if (seen.has(obj)) return [];
  seen.add(obj);
  const results = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (!k) continue;
    try {
      const key = String(k).toLowerCase();
      if (/(^|_|-|\.)?(group|group_id|groupid|livechat|lc|lc_group|lc_group_id|livechat_group)/i.test(key)) {
        if (v == null) continue;
        if (typeof v === 'string' || typeof v === 'number') {
          const cand = normalizeCandidate(v);
          if (cand) results.push(cand);
        }
      }
    } catch (_) {}
    if (v && typeof v === 'object') {
      results.push(...scanForGroupId(v, depth + 1, seen));
    }
  }
  return results;
}

function extractGroupId(chat) {
  const candidates = collectCandidates(chat);
  // suppressed group-mapping debug logging
  return candidates.length ? candidates[0] : null;
}

async function mapChatToGroup(chat) {
  const lcGroupId = extractGroupId(chat);
  // suppressed group-mapping lcGroupId debug logging
  if (!lcGroupId) {
    // Fallback: if a default internal group is configured, persist mapping immediately
    try {
      const def = Number(process.env.DEFAULT_GROUP_ID || process.env.DEFAULT_GROUPID || process.env.DEFAULT_GROUP || NaN);
      const chatId = normalizeCandidate(
        chat?.chat_id || chat?.chatId || chat?.id || chat?.chat?.id || chat?.thread?.chat_id || chat?.thread?.id
      );
      if (!Number.isNaN(def) && chatId) {
        try {
          await setChatGroup(chatId, def);
          try {
            const Chatbot = require('./Chatbot');
            if (Chatbot && typeof Chatbot.clearChatGroupCache === 'function') {
              Chatbot.clearChatGroupCache(chatId);
            }
          } catch (_) {}
        } catch (_) {}
        return { lcGroupId: null, internalGroupId: def, internalGroupName: null };
      }
    } catch (_) {}
    return { lcGroupId: null, internalGroupId: null, internalGroupName: null };
  }

  const found = await findGroupByLivechatGroupId(lcGroupId);
  // suppressed group-mapping findGroupByLivechatGroupId debug logging
  if (!found) {
    return { lcGroupId, internalGroupId: null, internalGroupName: null };
  }

  const chatId = normalizeCandidate(
    chat?.chat_id || chat?.chatId || chat?.id || chat?.chat?.id || chat?.thread?.chat_id || chat?.thread?.id
  );
  if (chatId) {
    try {
      await setChatGroup(chatId, found.id);
    // Clear in-memory chat->group caches in Chatbot (best-effort) so subsequent
    // getGroupIdForChat calls pick up the newly persisted mapping immediately.
    try {
      const Chatbot = require('./Chatbot');
      if (Chatbot && typeof Chatbot.clearChatGroupCache === 'function') {
        Chatbot.clearChatGroupCache(chatId);
      }
    } catch (_) {}
    } catch (err) {
      console.warn('Failed to persist chat→group mapping', { chatId, groupId: found.id, error: err?.message || err });
    }
  }

  return {
    lcGroupId,
    internalGroupId: found.id,
    internalGroupName: found.name || null
  };
}

async function sendReply(chat, message, options = {}) {
  if (!chat) throw new Error('chat required for sendReply');
  // Honor STRICT_WEBHOOK_ONLY: when enabled, only callers that explicitly
  // mark the send as originating from the webhook flow are permitted to
  // deliver messages to LiveChat. This lets the server enforce fast
  // webhook-driven sends while blocking manual/admin sends.
  const strictWebhookOnly = String(process.env.STRICT_WEBHOOK_ONLY || '').toLowerCase() === 'true';
  if (strictWebhookOnly && !options.__allowFromWebhook) {
    throw new Error('sendReply is restricted: STRICT_WEBHOOK_ONLY enabled; only webhook-originated sends are allowed');
  }
  // Require that webhook-originated sends are actually generated by the Chatbot
  if (strictWebhookOnly && options.__allowFromWebhook && !options.__generatedByChatbot) {
    throw new Error('sendReply blocked: STRICT_WEBHOOK_ONLY requires messages to be generated by the Chatbot (options.__generatedByChatbot=true)');
  }
  // Only allow direct sends from trusted assistant flows by default.
  // Set environment variable ALLOW_DIRECT_LIVECHAT_SEND=true to temporarily
  // allow all callers (not recommended for production).
  const allowDirectSends = String(process.env.ALLOW_DIRECT_LIVECHAT_SEND || '').toLowerCase() === 'true';
  // Allow if explicitly permitted by env, or if caller marks this send as
  // originating from the webhook flow and it was generated by the Chatbot.
  // This lets webhook-driven automated replies (the common fast path) operate
  // without setting ALLOW_DIRECT_LIVECHAT_SEND globally.
  const allowedViaWebhook = !!(options.__allowFromWebhook && options.__generatedByChatbot);
  if (!allowDirectSends && !allowedViaWebhook && !options.__allowFromAssistant) {
    throw new Error('sendReply is restricted: only assistant-originated messages may send to LiveChat. Caller must set options.__allowFromAssistant = true');
  }
  const chatId = normalizeCandidate(
    chat?.chat_id || chat?.chatId || chat?.id || chat?.chat?.id || chat?.thread?.chat_id || chat?.thread?.id
  );
  if (!chatId) throw new Error('chatId not found in chat payload');

  // If chat is paused for human support, prevent automated assistant sends
  try {
    const status = await getChatStatus(chatId).catch(() => null);
    if (status === 'needs_human') {
      throw new Error('sendReply suppressed: chat paused for human support (needs_human)');
    }
  } catch (e) {
    // If getChatStatus fails due to DB issues, rethrow only explicit suppression
    if (e && String(e.message).includes('sendReply suppressed')) throw e;
    // otherwise swallow and continue (best-effort)
  }

  let lcGroupId = extractGroupId(chat);
  if (!lcGroupId && options.groupId) {
    lcGroupId = normalizeCandidate(options.groupId);
  }
  if (!lcGroupId && options.internalGroupId) {
    lcGroupId = await getGroupLivechatGroupId(options.internalGroupId);
  }

  if (!lcGroupId) {
    const mapping = await mapChatToGroup(chat);
    lcGroupId = mapping.lcGroupId;
  }

  const payload = { groupId: lcGroupId ? String(lcGroupId) : null };

  // If caller requests a typing indicator to be shown prior to sending,
  // send a typing event first (best-effort; depends on livechatApi implementation).
  if (options.showTyping) {
    try {
      await sendLivechatMessage(chatId, null, { ...payload, typing: true });
    } catch (e) {
      // non-fatal
      console.warn('setTyping(1) failed:', e && e.message ? e.message : e);
    }
  }

  await sendLivechatMessage(chatId, message, payload);

  // Clear typing indicator explicitly after sending the message
  if (options.showTyping) {
    try {
      await sendLivechatMessage(chatId, null, { ...payload, typing: false });
    } catch (e) {
      // non-fatal
      console.warn('setTyping(0) failed:', e && e.message ? e.message : e);
    }
  }

  return {
    chatId,
    lcGroupId: payload.groupId,
    message
  };
}

/**
 * Best-effort helper to set/clear typing indicator in the livechat UI.
 * Some livechat backends accept a 'typing' flag in the payload; this
 * simply calls the underlying sendLivechatMessage with a null message
 * and typing flag. Non-fatal if the backend doesn't support it.
 */
async function setTyping(chat, isTyping = true) {
  if (!chat) throw new Error('chat required for setTyping');
  const chatId = normalizeCandidate(
    chat?.chat_id || chat?.chatId || chat?.id || chat?.chat?.id || chat?.thread?.chat_id || chat?.thread?.id
  );
  if (!chatId) throw new Error('chatId not found in chat payload');

  const lcGroupId = extractGroupId(chat);
  const payload = { groupId: lcGroupId ? String(lcGroupId) : null, typing: !!isTyping };
  try {
    await sendLivechatMessage(chatId, null, payload);
  } catch (e) {
    console.warn('setTyping failed (non-fatal):', e && e.message ? e.message : e);
  }
}

module.exports = {
  extractGroupId,
  mapChatToGroup,
  sendReply,
  setTyping,
  listGroupLivechatMappings,
  setGroupLivechatGroupId
};
