// mapping-helpers.js
// Ensure chat row and optional mapping exist atomically to avoid FK/race issues.
const dbx = require('./db-utils');

async function ensureChatAndMapping(db, { chatId, groupId = null, groupName = null } = {}) {
  if (!chatId) return;
  // Normalize
  const cid = String(chatId);
  const gid = (groupId == null) ? null : Number(groupId);
  try {
    // Acquire DB if not provided
    const dbInstance = db || await dbx.getDb();
    if (!dbInstance) return;

    // Use a transaction if available to make this atomic
    const op = () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        // Insert chat if missing (chats table uses `id` as primary key)
        dbInstance.prepare('INSERT OR IGNORE INTO chats (id, state, last_activity) VALUES (?, ?, ?)').run(cid, JSON.stringify({}), now);

        if (gid != null && Number.isFinite(gid)) {
          // Ensure group exists (id and name) — INSERT OR IGNORE
          const gname = (groupName && String(groupName).trim()) ? String(groupName).trim() : (`group_${gid}`);
          try { dbInstance.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)').run(Number(gid), gname); } catch (_) {}

          // Upsert mapping in chat_groups — ensure one mapping per chat
          dbInstance.prepare(
            'INSERT INTO chat_groups (chat_id, group_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET group_id=excluded.group_id'
          ).run(cid, Number(gid));
        }
      } catch (e) {
        // swallow — best effort
      }
    };

    if (typeof dbInstance.transaction === 'function') {
      try {
        const tx = dbInstance.transaction(op);
        tx();
      } catch (e) {
        // fallback to non-transactional
        try { await Promise.resolve(op()); } catch (_) {}
      }
    } else {
      try { await Promise.resolve(op()); } catch (_) {}
    }

    try { console.info(`[mapping] ensured chat=${cid} group=${gid != null ? gid : 'null'}`); } catch(_){}
  } catch (e) {
    try { console.warn('[mapping] ensureChatAndMapping failed (non-fatal):', e?.message || e); } catch(_){}
  }
}

module.exports = { ensureChatAndMapping };

/**
 * Extract a LiveChat group identifier from a webhook payload.
 * Returns a normalized string id (as provided by LiveChat) or null.
 */
function extractLivechatGroupIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload?.chat?.properties?.group,
    payload?.properties?.group,
    payload?.chat?.group_id,
    payload?.chat?.group?.id,
    payload?.group_id,
    payload?.group?.id,
    payload?.event?.properties?.group,
    payload?.thread?.properties?.group,
    payload?.chat?.access?.group_ids,
    payload?.access?.group_ids,
    payload?.chat?.group,
    payload?.group,
  ];

  const normalize = (cand) => {
    if (cand == null) return null;
    // If candidate is array, pick first non-null
    if (Array.isArray(cand)) {
      for (const it of cand) {
        const n = normalize(it);
        if (n) return n;
      }
      return null;
    }
    // If object, try common keys
    if (typeof cand === 'object') {
      const v = cand.id ?? cand.group_id ?? cand.groupId ?? cand.livechat_group_id ?? cand.name ?? null;
      return v != null ? String(v).trim() : null;
    }
    // If primitive, try to parse/clean
    try {
      let s = String(cand).trim();
      if (!s || s === '0' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return null;
      // If looks like JSON string, try parse
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          const o = JSON.parse(s);
          return normalize(o);
        } catch (_) { /* not JSON */ }
      }
      // If contains digits, prefer numeric segment (e.g. 'group:123' or '123-abc')
      const m = s.match(/(\d{2,})/);
      if (m) return m[1];
      // Otherwise accept alphanumeric slug
      return s;
    } catch (_) { return null; }
  };

  for (const cand of candidates) {
    const val = normalize(cand);
    if (val) return val;
  }
  return null;
}

module.exports = Object.assign(module.exports, { extractLivechatGroupIdFromPayload });
