// server.js
// Express server for LiveChat + local APIs
require('dotenv').config({ override: true });
// Ensure support pings are immediate by default (no throttling)
try {
  if (typeof process.env.SUPPORT_PING_MIN_INTERVAL_MS === 'undefined' || process.env.SUPPORT_PING_MIN_INTERVAL_MS === null || String(process.env.SUPPORT_PING_MIN_INTERVAL_MS).trim() === '') {
    process.env.SUPPORT_PING_MIN_INTERVAL_MS = '0';
  }
} catch(_) {}
// Ensure ENABLE_AUTO_BOT defaults to true when not explicitly set in env
if (typeof process.env.ENABLE_AUTO_BOT === 'undefined' || process.env.ENABLE_AUTO_BOT === null || String(process.env.ENABLE_AUTO_BOT).trim() === '') {
  process.env.ENABLE_AUTO_BOT = 'true';
}
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { extractGroupId, mapChatToGroup, sendReply } = require('./livechat-group-helpers.js');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const dbUtils = require('./db-utils.js');

// DEBUG HELPERS: optionally prevent unexpected process.exit during development
// Set PREVENT_PROCESS_EXIT=false to allow normal exits. Default is 'true'
try {
  if (String(process.env.PREVENT_PROCESS_EXIT || 'true').toLowerCase() === 'true') {
    const _origExit = process.exit.bind(process);
    process.exit = (code = 0) => {
      try {
        console.warn(`process.exit(${code}) suppressed by PREVENT_PROCESS_EXIT; call stack:\n${new Error().stack}`);
      } catch (_) {}
      // swallow exit to keep process alive for debugging
    };
    console.log('PREVENT_PROCESS_EXIT enabled: process.exit calls will be suppressed (set PREVENT_PROCESS_EXIT=false to disable)');
  }
} catch (_) {}

// Removed combine-window buffering and summarization. Replies send immediately.

async function addReplyToBuffer({ chatId, threadId = null, text, replyContextFactory, immediate = false, noSummarize = false }) {
  // Simplified immediate-send implementation: no buffering, combining, or summarization.
  try {
    const newText = String(text || '').trim();
    if (!newText) return;

    // Build reply context
    const replyContext = (typeof replyContextFactory === 'function') ? replyContextFactory() : { chat_id: chatId };

    // Attempt to map group info (best-effort)
    let replyMapping = { lcGroupId: null, internalGroupId: null };
    try {
      const mapped = await mapChatToGroup(replyContext);
      if (mapped) replyMapping = mapped;
    } catch (_) {}

    // Send immediately via existing sendReply path
    try {
      await sendReply(replyContext, newText, {
        internalGroupId: replyMapping.internalGroupId,
        groupId: replyMapping.lcGroupId,
        __allowFromAssistant: true,
        __allowFromWebhook: true,
        __generatedByChatbot: true
      });
    } catch (e) {
      console.warn('Immediate sendReply failed:', e && e.message ? e.message : e);
    }

    // Persist assistant message for history (best-effort)
    try {
      const dbi = await dbUtils.getDb();
      await dbUtils.addMessage(dbi, chatId, 'assistant', newText).catch(() => {});
    } catch (_) {}
  } catch (e) {
    // keep it silent but safe: don't throw to callers
  }
}

// Simple real-time updates (no WebSockets needed!). This module is optional
// and may be missing in some deployments. Load it defensively and fall back
// to no-op functions when not present so the server can start.
let setupSimpleUpdates = () => ({ register: () => {} });
let integrateWithWebhook = () => {};
try {
  const us = require('./ultra-simple-updates.js');
  if (us) {
    setupSimpleUpdates = us.setupSimpleUpdates || setupSimpleUpdates;
    integrateWithWebhook = us.integrateWithWebhook || integrateWithWebhook;
  }
} catch (err) {
  console.log('Optional module ./ultra-simple-updates.js not found - continuing without real-time update helper');
}



let liveChatSSE = null;
// In-memory flag to completely disable SSE (can be toggled by owner via admin endpoint)
// Disabled by default per owner request
if (typeof global.__sseDisabled === 'undefined') global.__sseDisabled = true;

const {
  getDb,
  getChatState,
  updateChatState,
  setChatStatus,
  getChatStatus,
  getChatStatusMap,
  addMessage,
  getChatMessages,
  getChatGroup,
  getGlobalAutoAiState,
  setGlobalAutoAiState,
  getLastCustomerEventId,
  updateLastCustomerEventId,
  getGroupLivechatGroupId
} = dbUtils;
let db;

// Load local settings.json and prefer its welcomeMessage when present
let LOCAL_SETTINGS = null;
try {
  LOCAL_SETTINGS = require('./settings.json');
} catch (_) { LOCAL_SETTINGS = null; }

function getConfiguredWelcomeMessage() {
  try {
    if (LOCAL_SETTINGS && typeof LOCAL_SETTINGS.welcomeMessage === 'string' && LOCAL_SETTINGS.welcomeMessage.trim()) {
      return LOCAL_SETTINGS.welcomeMessage.trim();
    }
  } catch (_) {}
  return process.env.BOT_WELCOME_MESSAGE || 'Halo bosku! Ada yang bisa saya bantu?';
}
// Group-aware welcome message: prefer per-group aiSettings, fallback to global helper above
async function getConfiguredWelcomeMessageForChat(chatId) {
  try {
    if (!chatId) return getConfiguredWelcomeMessage();
    let groupId = null;
    try {
      const row = await getChatGroup(String(chatId)).catch(() => null);
      if (row != null) {
        const val = row.group_id ?? row.groupId ?? row.GROUP_ID ?? row;
        const num = Number(val);
        if (!Number.isNaN(num)) groupId = num;
      }
    } catch (_) { groupId = null; }
    if (groupId == null) return getConfiguredWelcomeMessage();

    const cfg = await dbUtils.getGroupConfig(groupId).catch(() => null);
    const ai = (cfg && cfg.aiSettings) ? cfg.aiSettings : {};
    const cm = (ai && ai.customMessages && typeof ai.customMessages === 'object') ? ai.customMessages : {};
    const msg = (ai.welcomeMessage || cm.welcomeMessage || '').toString().trim();
    return msg || getConfiguredWelcomeMessage();
  } catch (_) {
    return getConfiguredWelcomeMessage();
  }
}

// Generic helper to retrieve a custom message by key for a chat's group aiSettings
// Example keys: 'welcomeMessage', 'waitMessage', 'endMessage', 'depositTemplate', 'withdrawTemplate'
async function getAiCustomMessage(chatId, key) {
  try {
    if (!chatId || !key) return '';
    let groupId = null;
    try {
      const row = await getChatGroup(String(chatId)).catch(() => null);
      if (row != null) {
        const val = row.group_id ?? row.groupId ?? row.GROUP_ID ?? row;
        const num = Number(val);
        if (!Number.isNaN(num)) groupId = num;
      }
    } catch (_) { groupId = null; }
    if (groupId == null) return '';
    const cfg = await dbUtils.getGroupConfig(groupId).catch(() => null);
    const ai = (cfg && cfg.aiSettings) ? cfg.aiSettings : {};
    const cm = (ai && ai.customMessages && typeof ai.customMessages === 'object') ? ai.customMessages : {};
    const candidates = [ ai[key], cm[key] ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return '';
  } catch (_) { return ''; }
}
if (!global.__globalAutoAiState) {
  global.__globalAutoAiState = {
    enabled: false,
    lockedByUserId: null,
    lockedByEmail: null,
    lockedByRole: null,
    lockedScope: null,
    lockedAt: null
  };
}

// Auto-Attend AI helpers restored for duplicate prevention
function hasProcessedAutoAiEvent(chatId, key) {
  const map = global.__handledMessagesByChat;
  const entries = map.get(chatId) || new Map();
  const isProcessed = entries.has(key);
  if (isProcessed) {
    console.log(`Ã°Å¸â€ºâ€˜ [DEDUP] Message already processed for chat ${chatId}, key: ${key}`);
  }
  return isProcessed;
}

function markAutoAiEventProcessed(chatId, key) {
  const map = global.__handledMessagesByChat;
  let entries = map.get(chatId);
  if (!entries) {
    entries = new Map();
    map.set(chatId, entries);
  }
  entries.set(key, Date.now());
  console.log(`Ã¢Å“â€¦ [DEDUP] Marked event processed for chat ${chatId}, key: ${key}`);
  setTimeout(() => entries.delete(key), 5 * 60 * 1000);
}

function normalizeEventTimestamp(ts) {
  // Removed implementation: return a stable, safe string representation
  if (ts == null) return '';
  try { return String(ts); } catch (_) { return '';} 
}

function buildEventIdentity(chatId, eventId, { text = '', authorId = null, createdAt = null } = {}) {
  // Removed implementation: return a minimal identity so callers continue to work
  const normalizedEventId = eventId || `anon:${chatId || ''}`;
  const fingerprint = crypto.createHash('sha1').update(String(normalizedEventId)).digest('hex');
  return { normalizedEventId, fingerprint };
}

function normalizeCustomerText(text) {
  // Minimal normalizer: trim and lowercase
  try { return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase(); } catch (_) { return ''; }
}

function normalizeAuthorId(authorId) {
  try { const a = String(authorId || '').trim().toLowerCase(); return a || 'anon'; } catch (_) { return 'anon'; }
}

function buildCustomerMessageSignature(chatId, text, authorId) {
  // Minimal signature generator to preserve callers' expectations
  const normalizedText = normalizeCustomerText(text);
  const normalizedAuthor = normalizeAuthorId(authorId);
  const source = [chatId || 'unknown', normalizedAuthor, normalizedText].join('||');
  const signature = crypto.createHash('sha1').update(source).digest('hex');
  return { signature, normalizedText, normalizedAuthor };
}

// Initialize database
const initializeDatabase = async () => {
  // Database initialization removed: defer to db-utils when needed.
  try {
    db = null;
    console.log(' initializeDatabase is disabled in this build');
  } catch (e) {}
};


const PAYMENT_STATES = {};
const PAYMENT_TEMPLATES = {};

// GoodCasino bot functions were removed from automated flows.
// Provide safe no-op stubs here so any accidental references won't crash the server.
// Wire in the Chatbot module (main logic) so server can use its functions
let gcGetResponse = async function () { return null; };
let gcGetChatState = function () { return {}; };
let Chatbot = null;
try {
  Chatbot = require('./Chatbot.js');
  // primary function used by the server to generate a bot reply for a chat message
  if (Chatbot && typeof Chatbot.getCustomerServiceResponse === 'function') gcGetResponse = Chatbot.getCustomerServiceResponse;
  if (Chatbot && typeof Chatbot.getChatState === 'function') gcGetChatState = Chatbot.getChatState;
  // Also expose helper for sending agent reply text to LiveChat if needed elsewhere
  // Note: Chatbot.sendAgentReply only prepares and records the reply locally; sending to LiveChat is done by sendMessage
} catch (e) {
  console.warn('Chatbot module not available, bot features disabled:', e && e.message ? e.message : e);
}
// If you want to re-enable the assistant, replace these stubs with a require('./Chatbot.js') import.

// GroupReply AI (used for 5s burst aggregation)
let groupReply = null;
try {
  groupReply = require('./ai/groupReply.js');
} catch (_) {
  console.warn('groupReply module not available; falling back to Chatbot per-message replies');
  groupReply = null;
}

const app = express();
const auth = require('./auth.js');
const INITIAL_PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = '0.0.0.0';

// Global server instance
let serverInstance = null;
let activePort = INITIAL_PORT;

// In-memory deduplication for webhook events (prevent spam on duplicates)
const processedEvents = new Map(); // id -> timestamp
function isDuplicateEvent(eventId, ttlMs = 5 * 60 * 1000) {
  const now = Date.now();
  const prev = processedEvents.get(eventId);
  if (prev && now - prev < ttlMs) {
    console.log(`Ã°Å¸â€ºâ€˜ [DEDUP] Duplicate event detected: ${eventId}, last processed ${now - prev}ms ago`);
    return true;
  }
  processedEvents.set(eventId, now);
  return false;
}

function removeDuplicateEvent(eventId) {
  // No-op: duplicate tracking removed
  return;
}

if (!global.__handledMessagesByChat) {
  global.__handledMessagesByChat = new Map();
}

function clearHandledMessage(chatId, signature) {
  // Removed internal handled-message tracking
  return;
}

function markHandledMessage(chatId, signature) {
  // Removed internal handled-message tracking
  return;
}

function hasHandledMessage(chatId, signature) {
  // Removed internal handled-message tracking
  return false;
}

function buildMessageSignature(chatId, eventId, text) {
  return `${chatId || 'unknown'}::${eventId || 'none'}::${String(text || '').slice(0,120)}`;
}

const ASSISTANT_DUP_TTL_MS = parseInt(process.env.ASSISTANT_DUP_TTL_MS || '60000', 10);
if (!global.__recentAssistantMessages) {
  global.__recentAssistantMessages = new Map();
}

// Global Auto AI: Request-level locking to prevent concurrent processing duplicates
if (!global.__activeChatLocks) {
  global.__activeChatLocks = new Set();
}
const activeChatLocks = global.__activeChatLocks;

function normalizeAssistantText(text) {
  try { return (text || '').toString().trim(); } catch (_) { return ''; }
}

function shouldSkipAssistantMessage(chatId, text, { senderId = null } = {}, ttlMs = ASSISTANT_DUP_TTL_MS) {
  // Assistant duplicate/ratelimit tracking removed - never skip
  return false;
}

function rememberAssistantMessage(chatId, text, { senderId = null } = {}) {
  // No-op: message remembering disabled
  return;
}

if (!global.__messageCountsByChat) {
  global.__messageCountsByChat = new Map();
}

function trackMessage(chatId, role) {
  // Message tracking removed
  return;
}

function hasExceededMessageRatio(chatId) {
  // Message ratio enforcement removed
  return false;
}

function parseEnvList(key, fallback = '') {
  // Minimal parser: return fallback when env missing
  try {
    const raw = process.env[key];
    if (!raw) return fallback.split(',').map(s => s.trim()).filter(Boolean);
    if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  } catch (_) { return fallback.split(',').map(s => s.trim()).filter(Boolean); }
}

function evaluateChatIdForSend(chatId, req, payload) {
  // Simplified: conservative default to skip sends when chatId missing
  const normalized = (chatId == null ? '' : String(chatId)).trim();
  if (!normalized) return { skip: true, reason: 'missing_chat_id', match: null, allowFake: false };
  return { skip: false, reason: null, match: null, allowFake: false };
}

function matchSecretFromSignature(signatureHeader, rawBodyBuffer, allowedSecrets) {
  try {
    if (!signatureHeader || !rawBodyBuffer || !allowedSecrets || allowedSecrets.size === 0) return null;
    const sig = String(signatureHeader).trim();
    const crypto = require('crypto');
    for (const secret of allowedSecrets) {
      const h = crypto.createHmac('sha256', String(secret)).update(rawBodyBuffer).digest('hex');
      if (crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(sig, 'hex'))) {
        return secret;
      }
    }
  } catch (e) {
    console.warn('matchSecretFromSignature error:', e?.message || e);
  }
  return null;
}

// Function to get server instance
function getServerInstance() {
  if (!serverInstance) throw new Error('Server not initialized');
  return serverInstance;
}

// Function to start the server
const startServer = async () => {
  // Minimal server start: bind Express app to INITIAL_PORT (with a few fallbacks).
  // This intentionally avoids running full DB initialization here to keep startup
  // resilient; route handlers will lazily acquire DB connections as needed.
  try {
    const listenOnce = (port) => new Promise((resolve, reject) => {
      const s = app.listen(port, () => resolve(s));
      s.on('error', (err) => reject(err));
    });

    let portToTry = INITIAL_PORT;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const server = await listenOnce(portToTry);
        serverInstance = server;
        activePort = portToTry;
        const localUrl = `http://localhost:${portToTry}`;
        // Reflect the actual bound port and base in env for other modules
        try { process.env.PORT = String(portToTry); } catch(_) {}
        try { process.env.SERVER_BASE = localUrl; } catch(_) {}
        console.log(`\Server started: ${localUrl}`);
        console.log('🎉 Server ready to accept requests');
        server.on('error', (err) => console.error('🛑 Server runtime error:', err));
        return;
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') {
          console.warn(`Port ${portToTry} in use, trying ${portToTry + 1}...`);
          portToTry = portToTry + 1;
          continue;
        }
        console.error('Ã¢ÂÅ’ Failed to start server:', err);
        process.exit(1);
      }
    }
    console.error('Ã¢ÂÅ’ Unable to bind a port for the server after multiple attempts');
    process.exit(1);
  } catch (err) {
    console.error('Ã¢ÂÅ’ startServer error:', err);
    process.exit(1);
  }
};

// Start the server
startServer().catch(error => {
  console.error('Ã¢ÂÅ’ Failed to start server:', error);
  process.exit(1);
});

// Track active users and open tickets
const activeUsers = new Set();
const openTickets = new Set();

// Helper function to update chat activity
async function updateChatActivity(chatId, userId) {
  const now = Math.floor(Date.now() / 1000);
  activeUsers.add(userId);
  openTickets.add(chatId);

  // Update last activity in the database (better-sqlite3 is synchronous)
  try {
    if (!db) {
      // Lazy acquire if global not yet set (should normally be set by startServer)
      db = await getDb();
    }
    db.prepare('INSERT OR IGNORE INTO chats (id, state, last_activity) VALUES (?, ?, ?)')
      .run(chatId, '{}', now);
    db.prepare('UPDATE chats SET last_activity = ? WHERE id = ?')
      .run(now, chatId);
  } catch (error) {
    console.error('Error updating chat activity:', error);
  }
}

app.use(cors({
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-bot-secret']
}));
const rawBodySaver = (req, res, buf) => {
  if (Buffer.isBuffer(buf)) {
    req.rawBody = Buffer.from(buf);
  }
};
app.use(bodyParser.json({ limit: '2mb', verify: rawBodySaver }));
app.use(express.static(__dirname));
// Also serve assets from ./public for the web chat UI
app.use(express.static(path.join(__dirname, 'public')));

// Initialize ultra simple updates (polling/SSE alternative)
try {
  const simple = setupSimpleUpdates(app);
  // expose addUpdate if needed elsewhere
  if (simple && typeof simple.addUpdate === 'function') {
    const webhookNotifier = integrateWithWebhook(simple.addUpdate);
    // Expose a global notifier function that other modules (like Chatbot.js)
    // can call without requiring server2 (to avoid circular requires).
    global.__notifyNewMessage = webhookNotifier.notifyNewMessage;
    global.__notifyStatusChange = webhookNotifier.notifyStatusChange;
    console.log('Simple updates initialized (SSE/polling endpoint: /api/simple-updates)');
  }
} catch (e) {
  console.warn(' Failed to init simple-updates integration:', e?.message || e);
}

// LiveChat webhook endpoint
// Lightweight GET for external health checks
app.get('/livechat/webhook', (req, res) => {
  res.json({ status: 'ok' });
});

// Local/mock assistant endpoint used for development and testing.
// If the incoming request looks like an intent-classifier prompt (the
// detectIntentsLLM prompt includes a JSON schema with "is_deposit_query"),
// return a JSON string payload that matches that schema so the caller can
// parse it directly. Otherwise return a simple text reply shape.
app.post('/local/assistant-reply', async (req, res) => {
  try {
    const body = req.body || {};
    // Support both { messages: [...] } and { payload: { messages: [...] } }
    const messages = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.payload?.messages) ? body.payload.messages : []);
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    const lastContent = (lastMsg && lastMsg.content) ? String(lastMsg.content) : '';

    // Also find the most recent user-authored message so we can classify it
    const lastUserMsgObj = messages.filter(m => String(m.role || '').toLowerCase() === 'user').slice(-1)[0] || null;
    const userText = String(lastUserMsgObj?.content || lastContent || (body.text || '')).trim();

    // Determine whether the caller asked the webhook to act as the intent classifier
    const wantsIntents = /"is_deposit_query"\s*:/i.test(lastContent || '');

    if (wantsIntents) {
      // Very simple regex-based classifier on the most recent user text.
      const depositRe = /\b(deposit|depo|dp|cek\s+deposit|cek\s+depo|top\s?up)\b/i;
      const withdrawRe = /\b(withdraw|wd|penarikan|tarik\s*dana|cek\s*withdraw)\b/i;
      const turnoverRe = /\b(turnover|turn\s*over|omset|omzet|rollover|cek\s*to)\b/i;
      const promoRe = /\b(promo|promosi|bonus|diskon)\b/i;
      const gameRe = /\b(game|games|slot|slots|gacor|permainan)\b/i;
      const rtpRe = /\brtp\b/i;
      const transferRe = /\b(cs|agent|human|transfer\s+ke\s+cs|hubungkan\s+ke\s+cs|minta\s+agen|operator)\b/i;

      const result = {
        is_deposit_query: !!depositRe.test(userText),
        is_withdrawal_query: !!withdrawRe.test(userText),
        is_turnover_query: !!turnoverRe.test(userText),
        is_promotion_query: !!promoRe.test(userText),
        is_game_list_query: !!gameRe.test(userText),
        is_rtp_query: !!rtpRe.test(userText),
        wants_transfer_to_agent: !!transferRe.test(userText)
      };

      // Return in the expected webhook shape: { content: 'JSON-string' }
      return res.json({ content: JSON.stringify(result) });
    }

    // Default: simple text reply shape (keeps compatibility with aiClient handling)
    const preview = (userText || '').toString().slice(0, 400);
    return res.json({ content: `Mock assistant reply (text): ${preview}` });
  } catch (err) {
    console.error('Local assistant-reply mock error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// --- Auth and Accounts ---
// Bootstrap: create initial owner if none (email/password from env for first run)
app.post('/api/auth/bootstrap', async (req, res) => {
  try {
    const email = (req.body?.email || process.env.MASTER_EMAIL || '').trim();
    const password = (req.body?.password || process.env.MASTER_PASSWORD || '').trim();
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    const user = await auth.createInitialMasterIfNone(email, password);
  if (!user) return res.json({ success: true, message: 'Already initialized' });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    const user = await auth.findUserByEmail(String(email).trim());
    if (!user) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const bcrypt = require('bcryptjs');
    const ok = bcrypt.compareSync(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const token = auth.signToken(user);
    res.json({ success: true, token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Owner: create master
app.post('/api/masters', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const { email, password, permissions = {}, groupIds = [] } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    const db = await getDb();
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
    if (exists) return res.status(409).json({ success: false, error: 'Email already exists' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(String(password), 10);
    const ins = db.prepare('INSERT INTO users (email, password_hash, role, permissions) VALUES (?, ?, ?, ?)');
    const info = ins.run(String(email).trim(), hash, 'master', JSON.stringify(permissions || {}));
    if (Array.isArray(groupIds) && groupIds.length) {
      await auth.setMasterGroups(info.lastInsertRowid, groupIds);
    }
    res.status(201).json({ success: true, id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: reset password for any user
app.put('/api/users/:id/password', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    if (!password || String(password).length < 4) {
      return res.status(400).json({ success: false, error: 'password required (min 4 chars)' });
    }
    const db = await getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(String(password), 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Owner: create agent directly (alias of /api/agents but owner-only ensures control)
app.post('/api/owner/agents', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const { email, password, permissions = {}, groupIds = [] } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    const id = await auth.registerAgent(String(email).trim(), String(password), permissions, groupIds);
    res.status(201).json({ success: true, id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: delete any user (agent/master). Prevent deleting last owner.
app.delete('/api/users/:id', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = await getDb();
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (user.role === 'owner') {
      const owners = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'owner'").get().c;
      if (owners <= 1) return res.status(400).json({ success: false, error: 'Cannot delete the last owner' });
    }
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true, deleted: info.changes > 0 });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// --- Per-Group AI Config and Promotions ---
const { upsertGroupConfig, getGroupConfig, listGroupPromotions, addGroupPromotion, updateGroupPromotion, deleteGroupPromotion } = require('./db-utils.js');

// Owner/Master: set brand/AI config for a group
app.put('/api/groups/:id/config', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
  const { brandName, aiSettings, rtpLink, livechatLicense, livechatGroupId, livechatWidgetSrc, livechatClientId, livechatWebhookSecret } = req.body || {};
    if (!brandName) return res.status(400).json({ success: false, error: 'brandName is required' });

    // Validate LiveChat settings if enabling any LiveChat feature fields
    const lcLicense = (livechatLicense ?? '').toString().trim();
    const lcWidgetSrc = (livechatWidgetSrc ?? '').toString().trim();
    const lcGroupId = (livechatGroupId ?? '').toString().trim();
    const lcClientId = (livechatClientId ?? '').toString().trim();
    const lcWebhookSecret = (livechatWebhookSecret ?? '').toString().trim();
    const livechatEnabling = !!(lcLicense || lcWidgetSrc || lcGroupId);
    if (livechatEnabling) {
      if (!lcClientId || !lcWebhookSecret) {
        return res.status(400).json({ success: false, error: 'livechatClientId and livechatWebhookSecret are required when configuring LiveChat for a group' });
      }
    }
  // If caller passed paymentOptions at top-level (legacy clients), copy into aiSettings
  try { if (req.body && req.body.paymentOptions && !aiSettings) { aiSettings = aiSettings || {}; aiSettings.paymentOptions = req.body.paymentOptions; } } catch(_) {}
  // Normalize and preserve existing AI settings when not provided in request
    let mergedAi = {};
    try {
      const existing = await getGroupConfig(groupId);
      const currentAi = (existing && existing.aiSettings) ? existing.aiSettings : {};
      // Normalize legacy payment keys on incoming aiSettings
      const normalizedIncoming = normalizeIncomingPayments(aiSettings || {});
      if (typeof aiSettings === 'undefined') {
        mergedAi = currentAi; // keep existing
      } else {
        // Merge incoming aiSettings into existing to avoid overwriting sibling keys
        mergedAi = mergeObjects(currentAi, normalizedIncoming || {});
      }
    } catch (_) {
      mergedAi = normalizeIncomingPayments(aiSettings || {});
    }

    // Ensure a groups row exists for this groupId (avoids foreign key constraint)
    try {
      const dbi = await getDb();
      dbi.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)').run(Number(groupId), `Group ${groupId}`);
    } catch (_) {}

    const cfg = await upsertGroupConfig(groupId, {
      brandName,
      aiSettings: mergedAi,
      rtpLink: rtpLink || null,
      livechatLicense: lcLicense || null,
      livechatGroupId: lcGroupId || null,
      livechatWidgetSrc: lcWidgetSrc || null,
      livechatClientId: lcClientId || null,
      livechatWebhookSecret: lcWebhookSecret || null
    });
  res.json({ success: true, config: cfg, message: 'Group config saved' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get group config (auth any role)
app.get('/api/groups/:id/config', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
  const cfg = await getGroupConfig(groupId);
  res.json({ success: true, config: cfg, message: 'AI settings saved' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Helper: shallow/deep merge for aiSettings (objects only, arrays overwritten)
function mergeObjects(base, patch) {
  if (!base || typeof base !== 'object') base = {};
  if (!patch || typeof patch !== 'object') return Object.assign({}, base);
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeObjects(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Normalize incoming aiSettings payloads: legacy keys like paymentOptions -> payments
function normalizeIncomingPayments(aiSettings) {
  if (!aiSettings || typeof aiSettings !== 'object') return aiSettings;
  try {
    // If payload contains paymentOptions, convert to payments
    if (aiSettings.paymentOptions && !aiSettings.payments) {
      const po = aiSettings.paymentOptions;
      const payments = {};
      // map banks / eWallets / qris variants
      if (Array.isArray(po.banks)) payments.banks = po.banks.map(String).filter(Boolean);
      if (Array.isArray(po.eWallets)) payments.ewallets = po.eWallets.map(String).filter(Boolean);
      if (typeof po.qris === 'boolean') payments.qris = po.qris;
      // also handle camel/snake variants
      if (Array.isArray(po.BANKS) && !payments.banks) payments.banks = po.BANKS.map(String).filter(Boolean);
      if (Array.isArray(po.E_WALLET) && !payments.ewallets) payments.ewallets = po.E_WALLET.map(String).filter(Boolean);
      if (payments && Object.keys(payments).length) aiSettings.payments = payments;
      // keep original paymentOptions for backward trace if needed
    }
    // Also support top-level paymentOptions object (not nested in aiSettings)
    if (aiSettings && aiSettings.payments == null && aiSettings.paymentOptions && typeof aiSettings.paymentOptions === 'object') {
      const po = aiSettings.paymentOptions;
      const payments = {};
      if (Array.isArray(po.banks)) payments.banks = po.banks.map(String).filter(Boolean);
      if (Array.isArray(po.eWallets)) payments.ewallets = po.eWallets.map(String).filter(Boolean);
      if (typeof po.qris === 'boolean') payments.qris = po.qris;
      if (Object.keys(payments).length) aiSettings.payments = payments;
    }
  } catch (e) {
    // ignore normalization errors
  }
  return aiSettings;
}

// Master/Owner: update only aiSettings for a group (used by UI Save Custom Rules)
app.get('/api/groups/:id/ai-settings', auth.authMiddleware(), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    console.log(`[DEBUG] GET /api/groups/${groupId}/ai-settings called by user=${req.user?.id}/${req.user?.role}`);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ success: false, error: 'Invalid group id' });
    }

    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) {
        console.warn(`[AUTH] GET /api/groups/${groupId}/ai-settings - forbidden for master user=${req.user.id}`);
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
    } else if (req.user.role !== 'owner') {
      console.warn(`[AUTH] GET /api/groups/${groupId}/ai-settings - forbidden for user=${req.user.id}/${req.user.role}`);
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const cfg = await getGroupConfig(groupId);
    const brandName = cfg && cfg.brandName ? cfg.brandName : 'GoodCasino';
    const aiSettings = cfg && cfg.aiSettings ? cfg.aiSettings : {};
    return res.json({ success: true, brandName, aiSettings });
  } catch (e) {
    console.error('Failed to load AI settings:', e?.message || e);
    res.status(500).json({ success: false, error: e?.message || 'Failed to load AI settings' });
  }
});

app.put('/api/groups/:id/ai-settings', auth.authMiddleware(), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    // Log the incoming request for debugging client wiring issues
    try { console.log(`[DEBUG] PUT /api/groups/${groupId}/ai-settings by user=${req.user?.id}/${req.user?.role} payload=`, JSON.stringify(req.body || {})); } catch(_) { console.log('[DEBUG] PUT /api/groups/:id/ai-settings - failed to stringify body'); }
    // Permission: masters may only edit groups they belong to
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) { console.warn(`[AUTH] PUT /api/groups/${groupId}/ai-settings - forbidden for master user=${req.user.id}`); return res.status(403).json({ success: false, error: 'Forbidden' }); }
    } else if (req.user.role !== 'owner') {
      // agents and others not allowed
      console.warn(`[AUTH] PUT /api/groups/${groupId}/ai-settings - forbidden for user=${req.user.id}/${req.user.role}`);
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

  let aiSettingsRaw = req.body && req.body.aiSettings ? req.body.aiSettings : {};
  // If caller sent paymentOptions at top-level, move it into aiSettingsRaw for normalization
  try { if (req.body && req.body.paymentOptions && !aiSettingsRaw.paymentOptions) aiSettingsRaw.paymentOptions = req.body.paymentOptions; } catch(_) {}
  // Normalize legacy payment keys if present (e.g., paymentOptions)
  const aiSettings = normalizeIncomingPayments(aiSettingsRaw || {});

  // Preserve existing group config values where not provided
  const existing = await getGroupConfig(groupId);
  const brandName = existing && existing.brandName ? existing.brandName : 'GoodCasino';
  const currentAi = (existing && existing.aiSettings) ? existing.aiSettings : {};
  // Merge incoming aiSettings into existing to preserve sibling keys
  const mergedAi = mergeObjects(currentAi, aiSettings || {});

    // Ensure a groups row exists for this groupId (avoids foreign key constraint)
    try {
      const dbi = await getDb();
      dbi.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)').run(Number(groupId), `Group ${groupId}`);
    } catch (_) {}

    const cfg = await upsertGroupConfig(groupId, {
      brandName,
      aiSettings: mergedAi,
      rtpLink: existing && existing.rtpLink ? existing.rtpLink : null,
      livechatLicense: existing && existing.livechatLicense ? existing.livechatLicense : null,
      livechatGroupId: existing && existing.livechatGroupId ? existing.livechatGroupId : null,
      livechatWidgetSrc: existing && existing.livechatWidgetSrc ? existing.livechatWidgetSrc : null,
      livechatClientId: existing && existing.livechatClientId ? existing.livechatClientId : null,
      livechatWebhookSecret: existing && existing.livechatWebhookSecret ? existing.livechatWebhookSecret : null,
      requirements: existing && existing.requirements ? existing.requirements : null
    });

    res.json({ success: true, config: cfg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Master/Owner: get or update payments settings for a group
app.get('/api/groups/:id/payments', auth.authMiddleware(), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isFinite(groupId)) return res.status(400).json({ success: false, error: 'Invalid group id' });

    // permission checks similar to other group routes
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) return res.status(403).json({ success: false, error: 'Forbidden' });
    } else if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const cfg = await getGroupConfig(groupId);
    const payments = cfg && cfg.aiSettings && cfg.aiSettings.payments ? cfg.aiSettings.payments : null;
    res.json({ success: true, payments });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/groups/:id/payments', auth.authMiddleware(), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isFinite(groupId)) return res.status(400).json({ success: false, error: 'Invalid group id' });

    // permission checks: master limited to their groups, owner allowed
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) return res.status(403).json({ success: false, error: 'Forbidden' });
    } else if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const incoming = req.body && req.body.payments ? req.body.payments : null;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ success: false, error: 'payments object required' });

    // Merge into existing aiSettings.payments
    const existing = await getGroupConfig(groupId);
    const currentAi = (existing && existing.aiSettings) ? existing.aiSettings : {};
    const mergedAi = mergeObjects(currentAi, { payments: incoming });

    const brandName = existing && existing.brandName ? existing.brandName : 'GoodCasino';
    // Ensure groups row exists
    try { const dbi = await getDb(); dbi.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)').run(Number(groupId), `Group ${groupId}`); } catch(_) {}

    const cfg = await upsertGroupConfig(groupId, {
      brandName,
      aiSettings: mergedAi,
      rtpLink: existing && existing.rtpLink ? existing.rtpLink : null,
      livechatLicense: existing && existing.livechatLicense ? existing.livechatLicense : null,
      livechatGroupId: existing && existing.livechatGroupId ? existing.livechatGroupId : null,
      livechatWidgetSrc: existing && existing.livechatWidgetSrc ? existing.livechatWidgetSrc : null,
      livechatClientId: existing && existing.livechatClientId ? existing.livechatClientId : null,
      livechatWebhookSecret: existing && existing.livechatWebhookSecret ? existing.livechatWebhookSecret : null,
      requirements: existing && existing.requirements ? existing.requirements : null
    });

    res.json({ success: true, payments: mergedAi.payments || null, config: cfg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner-only: reset AI settings for a group to defaults (keeps brand and other fields)
app.post('/api/groups/:id/ai/reset', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const existing = await getGroupConfig(gid);
    if (!existing) return res.status(404).json({ success: false, error: 'Group config not found' });
    const cfg = await upsertGroupConfig(gid, {
      brandName: existing.brandName || 'GoodCasino',
      aiSettings: {},
      rtpLink: existing.rtpLink || null,
      livechatLicense: existing.livechatLicense || null,
      livechatGroupId: existing.livechatGroupId || null,
      livechatWidgetSrc: existing.livechatWidgetSrc || null,
      livechatClientId: existing.livechatClientId || null,
      livechatWebhookSecret: existing.livechatWebhookSecret || null,
      requirements: existing.requirements || null
    });
    res.json({ success: true, config: cfg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner-only: reset AI settings across ALL groups
app.post('/api/groups/ai/reset-all', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const groups = await auth.listGroups();
    let resetCount = 0;
    let skippedWithoutConfig = 0;
    const resetGroups = [];
    for (const g of (groups || [])) {
      try {
        const existing = await getGroupConfig(g.id);
        if (!existing) { skippedWithoutConfig++; continue; }
        await upsertGroupConfig(g.id, {
          brandName: existing.brandName || 'GoodCasino',
          aiSettings: {},
          rtpLink: existing.rtpLink || null,
          livechatLicense: existing.livechatLicense || null,
          livechatGroupId: existing.livechatGroupId || null,
          livechatWidgetSrc: existing.livechatWidgetSrc || null,
          livechatClientId: existing.livechatClientId || null,
          livechatWebhookSecret: existing.livechatWebhookSecret || null,
          requirements: existing.requirements || null
        });
        resetCount++;
        resetGroups.push({ id: g.id, name: g.name });
      } catch (_) {
        // continue
      }
    }
    res.json({ success: true, totalGroups: (groups || []).length, resetCount, skippedWithoutConfig, resetGroups });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Owner/Master: group promotions CRUD
app.get('/api/groups/:id/promotions', auth.authMiddleware(), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    // Scope visibility for master/agent
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) return res.status(403).json({ success: false, error: 'Forbidden' });
    } else if (req.user.role === 'agent') {
      const allowed = await auth.getAgentGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const items = await listGroupPromotions(groupId);
    res.json({ success: true, promotions: items });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/groups/:id/promotions', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const groupId = Number(req.params.id);
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(groupId)) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
  const { title, description, discount, code, timeLimit, terms, howToClaim, eligibleItems, eligibleGames, endDate } = req.body || {};
    if (!title || !description) return res.status(400).json({ success: false, error: 'title and description required' });
  const created = await addGroupPromotion(groupId, { title, description, discount, code, timeLimit, terms, howToClaim, eligibleItems, eligibleGames, endDate });
    res.status(201).json({ success: true, promotion: created });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.put('/api/groups/:gid/promotions/:pid', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const gid = Number(req.params.gid);
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(gid)) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const pid = Number(req.params.pid);
    const updated = await updateGroupPromotion(gid, pid, req.body || {});
    if (!updated) return res.status(404).json({ success: false, error: 'Promotion not found' });
    res.json({ success: true, promotion: updated });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.delete('/api/groups/:gid/promotions/:pid', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const gid = Number(req.params.gid);
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (!allowedIds.has(gid)) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const pid = Number(req.params.pid);
    const ok = await deleteGroupPromotion(gid, pid);
    if (!ok) return res.status(404).json({ success: false, error: 'Promotion not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: list masters
app.get('/api/masters', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const db = await getDb();
  const masters = db.prepare("SELECT id, email, role, permissions FROM users WHERE role = 'master' ORDER BY id DESC").all();
    const groupRows = db.prepare('SELECT mg.user_id, g.id AS group_id, g.name FROM master_groups mg INNER JOIN groups g ON g.id = mg.group_id').all();
    const groupsByUser = groupRows.reduce((acc, r) => { (acc[r.user_id] ||= []).push({ id: r.group_id, name: r.name }); return acc; }, {});
    const result = masters.map(m => ({ id: m.id, email: m.email, role: m.role, permissions: (()=>{ try { return JSON.parse(m.permissions||'{}'); } catch(_) { return {}; } })(), groups: groupsByUser[m.id] || [] }));
    res.json({ success: true, masters: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: update master permissions
app.put('/api/masters/:id/permissions', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const permissions = req.body?.permissions || {};
    const db = await getDb();
  const upd = db.prepare("UPDATE users SET permissions = ? WHERE id = ? AND role = 'master'");
    const info = upd.run(JSON.stringify(permissions), id);
    if (info.changes === 0) return res.status(404).json({ success: false, error: 'Master not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: set master groups
app.put('/api/masters/:id/groups', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { groupIds = [] } = req.body || {};
    await auth.setMasterGroups(id, Array.isArray(groupIds) ? groupIds : []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: delete master
app.delete('/api/masters/:id', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = await getDb();
  const del = db.prepare("DELETE FROM users WHERE id = ? AND role = 'master'");
    const info = del.run(id);
    if (info.changes === 0) return res.status(404).json({ success: false, error: 'Master not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Master/Owner: create agent
app.post('/api/agents', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const { email, password, permissions = {}, groupIds = [] } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
    // Masters must assign at least one group so the agent is visible within their scope
    if (req.user.role === 'master' && (!Array.isArray(groupIds) || groupIds.length === 0)) {
      return res.status(400).json({ success: false, error: 'Masters must assign the new agent to at least one of their groups' });
    }
    // Masters can only assign agents to their own groups
    if (req.user.role === 'master' && Array.isArray(groupIds) && groupIds.length) {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      const invalid = groupIds.find(gid => !allowedIds.has(Number(gid)));
      if (invalid != null) return res.status(403).json({ success: false, error: 'Forbidden (invalid group assignment)' });
    }
    const id = await auth.registerAgent(String(email).trim(), String(password), permissions, groupIds);
    res.status(201).json({ success: true, id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Master/Owner: set agent groups
app.put('/api/agents/:id/groups', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const id = Number(req.params.id);
    const { groupIds = [] } = req.body || {};
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      const invalid = (Array.isArray(groupIds) ? groupIds : []).find(gid => !allowedIds.has(Number(gid)));
      if (invalid != null) return res.status(403).json({ success: false, error: 'Forbidden (invalid group assignment)' });
    }
    await auth.setAgentGroups(id, Array.isArray(groupIds) ? groupIds : []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Master/Owner: create/list groups
app.post('/api/groups', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const { name, livechatGroupId, livechat_group_id, lc_group_id } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const providedLcGroupId = [livechatGroupId, livechat_group_id, lc_group_id]
      .find((val) => val !== undefined && val !== null && String(val).trim() !== '');

    const id = await auth.createGroup(String(name).trim(), {
      livechatGroupId: providedLcGroupId != null ? String(providedLcGroupId).trim() : null
    });

    res.status(201).json({
      success: true,
      id,
      livechatGroupId: providedLcGroupId != null ? String(providedLcGroupId).trim() : null
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/groups', auth.authMiddleware(), async (req, res) => {
  try {
    let groups = await auth.listGroups();
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      groups = (groups || []).filter(g => allowedIds.has(g.id));
    } else if (req.user.role === 'agent') {
      const allowed = await auth.getAgentGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      groups = (groups || []).filter(g => allowedIds.has(g.id));
    }
    res.json({ success: true, groups });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Owner: delete a group
app.delete('/api/groups/:id', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const db = await getDb();
    const existing = db.prepare('SELECT id FROM groups WHERE id = ?').get(gid);
    if (!existing) return res.status(404).json({ success: false, error: 'Group not found' });

    // Defensive cascade for legacy DBs where FKs may not have ON DELETE CASCADE
    const deleteGroupCascade = db.transaction((groupId) => {
      try { db.prepare('DELETE FROM group_promotions WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM groups_config WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM agent_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM master_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM chat_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('UPDATE ai_usage SET group_id = NULL WHERE group_id = ?').run(groupId); } catch(_) {}
      const infoInner = db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
      return infoInner.changes > 0;
    });
    const deleted = deleteGroupCascade(gid);
    res.json({ success: true, deleted });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Fallback: some hosts/proxies block DELETE; provide POST-based deletion
app.post('/api/groups/:id/delete', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const gid = Number(req.params.id);
    const db = await getDb();
    const existing = db.prepare('SELECT id FROM groups WHERE id = ?').get(gid);
    if (!existing) return res.status(404).json({ success: false, error: 'Group not found' });
    const deleteGroupCascade = db.transaction((groupId) => {
      try { db.prepare('DELETE FROM group_promotions WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM groups_config WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM agent_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM master_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('DELETE FROM chat_groups WHERE group_id = ?').run(groupId); } catch(_) {}
      try { db.prepare('UPDATE ai_usage SET group_id = NULL WHERE group_id = ?').run(groupId); } catch(_) {}
      const infoInner = db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
      return infoInner.changes > 0;
    });
    const deleted = deleteGroupCascade(gid);
    res.json({ success: true, deleted, method: 'POST' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Master/Owner: list agents (with groups)
app.get('/api/agents', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const db = await getDb();
  const agents = db.prepare("SELECT id, email, role, permissions FROM users WHERE role = 'agent' ORDER BY id DESC").all();
    const groupRows = db.prepare('SELECT ag.user_id, g.id AS group_id, g.name FROM agent_groups ag INNER JOIN groups g ON g.id = ag.group_id').all();
    const groupsByUser = groupRows.reduce((acc, r) => { (acc[r.user_id] ||= []).push({ id: r.group_id, name: r.name }); return acc; }, {});
    let result = agents.map(a => ({
      id: a.id,
      email: a.email,
      role: a.role,
      permissions: (() => { try { return JSON.parse(a.permissions || '{}'); } catch(_) { return {}; } })(),
      groups: groupsByUser[a.id] || []
    }));
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      result = result
        .map(a => ({
          ...a,
          groups: (a.groups || []).filter(g => allowedIds.has(g.id))
        }))
        .filter(a => (a.groups || []).length > 0); // only agents with overlap
    }
    res.json({ success: true, agents: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Master/Owner: update agent permissions
app.put('/api/agents/:id/permissions', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const id = Number(req.params.id);
    const permissions = req.body?.permissions || {};
    const db = await getDb();
  const upd = db.prepare("UPDATE users SET permissions = ? WHERE id = ? AND role = 'agent'");
    const info = upd.run(JSON.stringify(permissions), id);
    if (info.changes === 0) return res.status(404).json({ success: false, error: 'Agent not found' });
    await auth.logAgentAction(req.user.id, 'agent_permissions_update', { targetId: id, permissions }, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Master/Owner: delete agent
app.delete('/api/agents/:id', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const id = Number(req.params.id);
    const db = await getDb();
  const del = db.prepare("DELETE FROM users WHERE id = ? AND role = 'agent'");
    const info = del.run(id);
    if (info.changes === 0) return res.status(404).json({ success: false, error: 'Agent not found' });
    await auth.logAgentAction(req.user.id, 'agent_delete', { targetId: id }, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Agent: my logs
app.get('/api/agents/me/logs', auth.authMiddleware(), async (req, res) => {
  try { const logs = await auth.listAgentLogs(req.user.id); res.json({ success: true, logs }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ Chat Mapping Endpoints ============

// Get all unmapped chats
app.get('/api/chats/unmapped', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Master or Owner role required' });
    }
    
    const db = await getDb();
    const unmappedChats = db.prepare(`
      SELECT DISTINCT m.chat_id, COUNT(m.id) as message_count, MAX(m.timestamp) as last_activity
      FROM messages m
      LEFT JOIN chat_groups cg ON cg.chat_id = m.chat_id
      WHERE cg.group_id IS NULL
      GROUP BY m.chat_id
      ORDER BY last_activity DESC
    `).all();
    
    res.json({ success: true, chats: unmappedChats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all chats with their group mappings
app.get('/api/chats', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Master or Owner role required' });
    }
    
    const db = await getDb();
    const chats = db.prepare(`
      SELECT 
        m.chat_id,
        cg.group_id,
        g.name as group_name,
        COUNT(m.id) as message_count,
        MAX(m.timestamp) as last_activity
      FROM messages m
      LEFT JOIN chat_groups cg ON cg.chat_id = m.chat_id
      LEFT JOIN groups g ON g.id = cg.group_id
      GROUP BY m.chat_id
      ORDER BY last_activity DESC
    `).all();
    
    res.json({ success: true, chats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Map a chat to a group
app.post('/api/chats/:chatId/map', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Master or Owner role required' });
    }
    
    const chatId = req.params.chatId;
    const { groupId } = req.body;
    
    if (!groupId) {
      return res.status(400).json({ success: false, error: 'groupId is required' });
    }
    
    const db = await getDb();
    
    // Verify group exists
    const group = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }
    
    // Verify chat exists
    const chatExists = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId);
    if (!chatExists || chatExists.count === 0) {
      return res.status(404).json({ success: false, error: 'Chat not found' });
    }
    
    // Insert or update mapping
    const stmt = db.prepare('INSERT OR REPLACE INTO chat_groups (chat_id, group_id) VALUES (?, ?)');
    stmt.run(chatId, groupId);
    
    // Log the action
    await auth.logAgentAction(req.user.id, 'chat_mapped', { chatId, groupId, groupName: group.name }, null);
    
    res.json({ 
      success: true, 
      message: `Chat ${chatId} mapped to group ${group.name}`,
      chatId,
      groupId: group.id,
      groupName: group.name
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Unmap a chat from its group
app.delete('/api/chats/:chatId/map', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'master' || req.user.role === 'owner')) {
      return res.status(403).json({ success: false, error: 'Master or Owner role required' });
    }
    
    const chatId = req.params.chatId;
    const db = await getDb();
    
    const stmt = db.prepare('DELETE FROM chat_groups WHERE chat_id = ?');
    const info = stmt.run(chatId);
    
    if (info.changes === 0) {
      return res.status(404).json({ success: false, error: 'Chat mapping not found' });
    }
    
    await auth.logAgentAction(req.user.id, 'chat_unmapped', { chatId }, null);
    
    res.json({ success: true, message: `Chat ${chatId} unmapped` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/livechat/webhook', async (req, res) => {
  if (String(process.env.DISABLE_LIVECHAT_WEBHOOK || '').toLowerCase() === 'true') {
    return res.json({ status: 'disabled' });
  }
  // Original request body fields
  const body = req.body || {};
  const { secret_key: bodySecret } = body;
  // action/payload may be present in some webhook formats; default to these
  let action = body.action;
  let payload = body.payload;
  const headerSecret = (req.headers['x-webhook-secret'] ?? req.headers['x-livechat-webhook-secret'] ?? req.headers['x-livechat-secret'] ?? '').toString().trim();

  // Temporary testing bypass: some LiveChat webhooks come in a different format
  // (they send event_type and license_id, and may not include the secret in the
  // expected header/body). Detect that format and bypass secret validation
  // for testing only. Be VERY careful - this is insecure and should be removed
  // after testing.
  const looksLikeLiveChatLegacy = (!!body && typeof body === 'object' && body.event_type && body.license_id);
  if (looksLikeLiveChatLegacy) {
    console.log('Temporary: accepting LiveChat-format webhook without secret validation (testing only)');
    // Map fields into the expected variables used later in the handler
    action = String(body.event_type || '').trim();
    // prefer chat object as payload if present
    payload = body.chat || body;
  }
  const directSecretCandidates = [bodySecret, headerSecret]
    .map((val) => (val == null ? '' : val).toString().trim())
    .filter(Boolean);
  // Accept either the global secret or any group's configured webhook secret
  let allowedSecrets = new Set();
  const secretToGroup = new Map();
  const globalSecret = (process.env.LIVECHAT_WEBHOOK_SECRET ?? '').toString().trim();
  if (globalSecret) allowedSecrets.add(globalSecret);
  try {
    const db = await getDb();
    const rows = db.prepare('SELECT group_id, livechat_webhook_secret FROM groups_config WHERE livechat_webhook_secret IS NOT NULL').all();
    for (const r of (rows || [])) { const s = (r.livechat_webhook_secret || '').toString().trim(); if (s) { allowedSecrets.add(s); secretToGroup.set(s, Number(r.group_id)); } }
  } catch (_) { /* ignore, fallback to env */ }

  // If this looks like a LiveChat legacy-format webhook and we're in testing
  // mode, bypass secret validation entirely (temporary).
  let matchedSecret = null;

  // Dev override: if set, accept all webhooks for local testing immediately.
  // WARNING: this is insecure and MUST NOT be enabled in production.
  const bypassEnv = String(process.env.BYPASS_WEBHOOK_SIGNATURE || '').toLowerCase() === 'true';
  if (bypassEnv) {
    console.warn('BYPASS_WEBHOOK_SIGNATURE is ENABLED Ã¢â‚¬â€ accepting webhooks without signature verification (dev/testing only).');
    matchedSecret = 'bypass';
  }

  if (!matchedSecret) {
    if (!looksLikeLiveChatLegacy) {
      for (const candidate of directSecretCandidates) {
        if (allowedSecrets.has(candidate)) {
          matchedSecret = candidate;
          break;
        }
      }
      if (!matchedSecret) {
        const signatureHeader = (req.headers['x-livechat-signature'] ?? req.headers['x-lc-signature'] ?? '').toString().trim();
        const rawBodyBuffer = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        matchedSecret = matchSecretFromSignature(signatureHeader, rawBodyBuffer, allowedSecrets);
        if (!matchedSecret) {
          console.warn('Invalid webhook secret/signature', {
            hasGlobal: !!globalSecret,
            totalAllowed: allowedSecrets.size,
            directSecretsReceived: directSecretCandidates.length,
            signaturePresent: !!signatureHeader
          });
          // If bypass env was not set, deny the request
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    } else {
      // mark that we accepted this via legacy bypass for logging purposes
      matchedSecret = 'legacy-bypass';
    }
  }
  console.log('Webhook action:', action);
  console.log('Webhook payload:', payload);
  
  // Ack immediately to prevent LiveChat retries
  res.json({ status: 'received' });

  // Hand off to Agent Chat Manager for efficient processing (observer only). If the
  // manager was removed, skip this step silently.
  try { if (typeof agentChatManager !== 'undefined' && agentChatManager && typeof agentChatManager.handleWebhookEvent === 'function') agentChatManager.handleWebhookEvent(action, payload); } catch(_) {}

  // If DISABLE_WEBHOOK_AUTO_REPLY is set, stop here. This prevents any
  // automatic AI reply processing while still acknowledging the webhook
  // and letting the AgentChatManager observe the event.
  if (String(process.env.DISABLE_WEBHOOK_AUTO_REPLY || '').toLowerCase() === 'true') {
    console.log('Ã°Å¸â€ºâ€˜ Webhook auto-reply DISABLED by environment variable; skipping auto-reply processing for this event');
    return;
  }

  // Process asynchronously to avoid timeouts/retries
  setImmediate(async () => {
    // Flag used to avoid duplicate reply systems (backend Global Auto AI vs webhook auto-reply)
    let backendAutoAiTriggered = false;
    try {
      // Enhanced ticket logging - show all ticket details immediately
      console.log('\nÃ°Å¸Å½Â« ===== NEW TICKET DETECTED =====');
      console.log(`Ã°Å¸â€œâ€¦ Timestamp: ${new Date().toISOString()}`);
      console.log(`Ã°Å¸â€â€ Action: ${action}`);
      console.log(`Ã°Å¸â€™Â¬ Chat ID: ${payload?.chat_id || payload?.chat?.id || payload?.id || 'Unknown'}`);
      
      // Extract and display customer information
      const chatId = payload?.chat_id || payload?.chat?.id || payload?.id;
      const customerInfo = {
        chatId: chatId,
        action: action,
        eventId: payload?.event?.id || payload?.message?.id || 'N/A',
        authorType: payload?.event?.author_type || payload?.message?.author_type || payload?.author_type || 'Unknown',
        messageText: payload?.event?.text || payload?.message?.text || 'No message',
        timestamp: new Date().toISOString(),
        groupId: payload?.chat?.group_id || payload?.group_id || 'Not specified',
        threadId: payload?.thread?.id || payload?.thread_id || 'N/A'
      };
      
      console.log('Ã°Å¸â€˜Â¤ Customer Info:');
      console.log(`   - Author Type: ${customerInfo.authorType}`);
      console.log(`   - Event ID: ${customerInfo.eventId}`);
      console.log(`   - Thread ID: ${customerInfo.threadId}`);
      console.log(`   - LiveChat Group: ${customerInfo.groupId}`);
      
      if (customerInfo.messageText && customerInfo.messageText !== 'No message') {
        console.log(`Ã°Å¸â€™Â­ Message: "${customerInfo.messageText.substring(0, 100)}${customerInfo.messageText.length > 100 ? '...' : ''}"`);
      }
      
      // Show ticket status
      console.log('Ã°Å¸Å½Â¯ Ticket Status:');
      console.log(`   - Type: ${action === 'chat_started' ? 'New Chat Started' : action === 'incoming_event' ? 'Customer Message' : action}`);
      console.log(`   - Auto-response: ${process.env.AUTO_RESPOND_TO_ALL_MESSAGES === 'true' ? 'Enabled' : 'Disabled'}`);
      console.log(`   - Webhook Secret: ${matchedSecret ? 'Valid' : 'Invalid'}`);
      console.log('Ã°Å¸Å½Â« ================================\n');

      // Proactive welcome on chat/thread start before first customer message
      // Also auto-map chat to group if webhook secret corresponds to a group,
      // or if payload contains a LiveChat group_id that matches groups_config.livechat_group_id
      if (action === 'chat_started' || action === 'thread_started') {
        console.log('Ã°Å¸â€ â€¢ Processing new chat/thread start...');
        try {
          const chatIdStart = payload?.chat_id || payload?.chat?.id || payload?.id;
          if (chatIdStart) {
            try {
              let gid = secretToGroup.get(matchedSecret);
              
              // ENHANCED: Try multiple locations for LiveChat Group ID
              let maybePayloadGroupId = null;
              if (!gid) {
                console.log('Ã°Å¸â€Â Attempting to extract LiveChat Group ID from payload...');
                
                // Try all possible locations where LiveChat might send group_id
                const groupIdCandidates = [
                  payload?.chat?.properties?.group,        // LiveChat properties
                  payload?.properties?.group,              // Root properties
                  payload?.chat?.group_id,                 // Direct chat property
                  payload?.chat?.group?.id,                // Nested group object
                  payload?.group_id,                       // Top-level
                  payload?.group?.id,                      // Top-level nested
                  payload?.event?.properties?.group,       // Event properties
                  payload?.thread?.properties?.group       // Thread properties
                ];
                
                console.log('Ã°Å¸â€œÅ  Group ID candidates found:', groupIdCandidates.filter(c => c != null));
                
                for (const candidate of groupIdCandidates) {
                  if (candidate) {
                    const normalized = String(candidate).trim();
                    if (normalized && normalized !== '0' && normalized !== 'null' && normalized !== 'undefined') {
                      maybePayloadGroupId = normalized;
                      console.log(`Ã¢Å“â€¦ Found LiveChat Group ID: "${maybePayloadGroupId}"`);
                      break;
                    }
                  }
                }
                
                if (maybePayloadGroupId) {
                  const db = await getDb();
                  const row = db.prepare('SELECT group_id FROM groups_config WHERE livechat_group_id = ?').get(maybePayloadGroupId);
                  
                  if (row && row.group_id) {
                    gid = Number(row.group_id);
                    console.log(`Matched LiveChat Group ID "${maybePayloadGroupId}" Ã¢â€ â€™ Internal Group ${gid}`);
                  } else {
                    console.warn(`LiveChat Group ID "${maybePayloadGroupId}" found but NO MATCH in groups_config table`);
                    console.warn('Check your group configuration: Make sure livechat_group_id is set');
                    
                    // Show all configured groups for debugging
                    const allGroups = db.prepare('SELECT g.id, g.name, gc.livechat_group_id FROM groups g LEFT JOIN groups_config gc ON gc.group_id = g.id').all();
                    console.warn('   Ã°Å¸â€œâ€¹ Configured groups:', allGroups.map(g => `Group ${g.id} "${g.name}" Ã¢â€ â€™ LC Group "${g.livechat_group_id || 'NOT SET'}"`));
                    
                    // Try to auto-bind this LiveChat group id to an internal group
                    try {
                      const licenseHint = payload?.chat?.access?.license_id || payload?.license_id || null;
                      const brandHint = payload?.chat?.properties?.brand || payload?.brand || payload?.chat?.brand_name || null;
                      let candidate = null;
                      if (licenseHint) {
                        candidate = db.prepare('SELECT group_id FROM groups_config WHERE livechat_license = ? LIMIT 1').get(String(licenseHint));
                      }
                      if (!candidate && brandHint) {
                        candidate = db.prepare('SELECT g.id AS group_id FROM groups g LEFT JOIN groups_config gc ON gc.group_id = g.id WHERE gc.brand_name = ? OR g.name = ? LIMIT 1').get(String(brandHint), String(brandHint));
                      }
                      if (candidate && candidate.group_id) {
                        const bindGroupId = Number(candidate.group_id);
                        console.log(`Auto-binding LiveChat Group ID "${maybePayloadGroupId}" to internal Group ${bindGroupId} based on hints`);
                        try {
                          const { setGroupLivechatGroupId, setChatGroup } = require('./db-utils.js');
                          await setGroupLivechatGroupId(bindGroupId, maybePayloadGroupId);
                          gid = bindGroupId;
                          await setChatGroup(String(chatIdStart), Number(gid));
                          console.log(`Auto-mapped chat ${chatIdStart} -> Group ${gid} and persisted LC group id`);
                        } catch (bindErr) {
                          console.warn('Auto-bind failed:', bindErr?.message || bindErr);
                        }
                      }
                    } catch (autoErr) {
                      console.warn('Auto-bind attempt failed:', autoErr?.message || autoErr);
                    }
                  }
                } else {
                  console.warn('No LiveChat Group ID found in webhook payload');
                  console.warn('   Payload structure:', JSON.stringify(payload, null, 2).substring(0, 500));
                }
              } else {
                console.log(`Mapped via webhook secret â†’ Internal Group ${gid}`);
              }
              
              // SAVE LiveChat metadata to database for future reference
              try {
                const { saveChatLivechatMetadata } = require('./db-utils.js');
                const metadata = {
                  livechat_group_id: maybePayloadGroupId || payload?.chat?.properties?.group || null,
                  livechat_license: payload?.chat?.access?.license_id || payload?.license_id || null,
                  access_group_ids: payload?.chat?.access?.group_ids || null,
                  webhook_action: action,
                  payload_snapshot: {
                    chat_id: chatIdStart,
                    properties: payload?.chat?.properties || payload?.properties || null,
                    access: payload?.chat?.access || null
                  }
                };
                await saveChatLivechatMetadata(String(chatIdStart), metadata);
                console.log(`Saved LiveChat metadata for chat ${chatIdStart} (LC Group: ${metadata.livechat_group_id || 'N/A'})`);
              } catch (metaErr) {
                console.warn('Failed to save LiveChat metadata:', metaErr.message);
              }
              
              if (gid) {
                const { setChatGroup } = require('./db-utils.js');
                await setChatGroup(String(chatIdStart), Number(gid));
                console.log(`🔗 Chat ${chatIdStart} successfully mapped to Group ${gid}`);
              } else {
                console.warn(`Chat ${chatIdStart} could NOT be mapped to any group`);
              }
            } catch (mapErr) { console.error('🛠️ Auto-map on chat_started failed:', mapErr?.message || mapErr, mapErr?.stack); }
            const dbCheck = await getDb();
            const existingMsg = dbCheck.prepare('SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1').get(chatIdStart);
            if (!existingMsg) {
              const welcome = await getConfiguredWelcomeMessageForChat(chatId);
              console.log('🔔 Sending proactive welcome for new chat', { chatId: chatIdStart });
              try {
                // Proactive automated welcome removed. Persist an audit entry
                try { await addMessage(dbCheck, chatIdStart, 'system', 'Proactive welcome skipped: automated replies are disabled.'); } catch(_) {}
                console.log('🔕 Proactive welcome skipped (auto-attend removed) for chat', chatIdStart);
              } catch(e) {
                console.warn('Failed to send proactive welcome', e?.response?.data || e?.message || e);
              }
            }
          }
        } catch(e) { console.warn('Proactive welcome flow failed (non-fatal):', e?.message || e); }
        // Continue; do not return so that first message (if also included) is still processed
      }

    const isCustomerMessageAction = action === 'customer_message';
    const isIncomingEventMessage = action === 'incoming_event' && payload?.event?.type === 'message';
    if (!isCustomerMessageAction && !isIncomingEventMessage) return;

    let eventPayload = isCustomerMessageAction ? (payload?.message || payload?.event || {}) : (payload?.event || {});
    // Update chatId with more comprehensive extraction for message processing
    const messageChatId = payload?.chat_id ||
      payload?.chat?.id ||
      eventPayload?.chat_id ||
      eventPayload?.chat?.id ||
      payload?.thread?.chat_id ||
      payload?.thread?.id || chatId;
    let text = (isCustomerMessageAction ? (payload?.message?.text ?? payload?.event?.text ?? '') : (payload?.event?.text ?? '')) || '';
    const authorIdRaw = eventPayload?.author_id || eventPayload?.author?.id || payload?.author_id || payload?.author?.id || null;
    const createdAtRaw = eventPayload?.created_at || eventPayload?.createdAt || payload?.event?.created_at || payload?.created_at || payload?.timestamp || null;
    // Defensive call: some runtime builds or modified deployments have triggered
    // ReferenceError: buildEventIdentity is not defined. Guard the call so the
    // webhook processing path remains resilient in such cases (log and fall
    // back to a minimal identity object).
    let eventIdentity;
    try {
      if (typeof buildEventIdentity === 'function') {
        eventIdentity = buildEventIdentity(
          messageChatId,
          eventPayload?.id || eventPayload?.custom_id,
          { text, authorId: authorIdRaw, createdAt: createdAtRaw }
        );
      } else {
        // Fallback: construct a minimal normalized ID + fingerprint
        const nid = eventPayload?.id || eventPayload?.custom_id || `anon:${messageChatId || ''}`;
        const fp = crypto.createHash('sha1').update(String(nid)).digest('hex');
        console.warn('buildEventIdentity is not available â€” using fallback identity');
        eventIdentity = { normalizedEventId: nid, fingerprint: fp };
      }
    } catch (e) {
      console.warn('buildEventIdentity call failed, using fallback identity:', e && e.message ? e.message : e);
      const nid = eventPayload?.id || eventPayload?.custom_id || `anon:${messageChatId || ''}`;
      const fp = crypto.createHash('sha1').update(String(nid)).digest('hex');
      eventIdentity = { normalizedEventId: nid, fingerprint: fp };
    }
    let webhookEventId = eventIdentity.normalizedEventId;
    const webhookFingerprint = eventIdentity.fingerprint;
    let customerSignature = buildCustomerMessageSignature(messageChatId, text, authorIdRaw);
    let webhookDedupeKeys = Array.from(new Set([webhookEventId, webhookFingerprint, customerSignature.signature].filter(Boolean)));
    let dbForChatState = null;
    let chatStateSnapshot = null;
    let autoAiStateSnapshot = null;
    let previousPersistentSignature = null;
    try {
      dbForChatState = await getDb();
      chatStateSnapshot = await getChatState(dbForChatState, messageChatId) || {};
      if (chatStateSnapshot && typeof chatStateSnapshot.__autoAi === 'object' && chatStateSnapshot.__autoAi !== null) {
        autoAiStateSnapshot = { ...chatStateSnapshot.__autoAi };
        previousPersistentSignature = autoAiStateSnapshot.lastCustomerSignature || null;
      }
    } catch (stateErr) {
      console.warn('Non-fatal: failed to load chat state for dedupe', stateErr?.message || stateErr);
    }

    const autoAiStateBeforeUpdate = autoAiStateSnapshot ? { ...autoAiStateSnapshot } : null;

    if (previousPersistentSignature && previousPersistentSignature === customerSignature.signature) {
      // Duplicate detected: mark processed but avoid logging the persistent signature
      console.log(`Ã°Å¸â€ºâ€˜ Duplicate message skipped via persistent signature for chat ${messageChatId}`);
      webhookDedupeKeys.forEach((key) => markAutoAiEventProcessed(messageChatId, key));
      return;
    }
    
    // Enhanced customer message logging
    if (text && messageChatId) {
      console.log('\nÃ°Å¸â€™Â¬ ===== CUSTOMER MESSAGE =====');
      console.log(`Ã°Å¸â€œÂ± Chat ID: ${messageChatId}`);
      console.log(`Ã°Å¸â€¢Â Time: ${new Date().toLocaleString()}`);
      console.log(`Ã°Å¸â€˜Â¤ Author: ${eventPayload?.author_type || 'customer'}`);
      console.log(`Ã°Å¸â€œÂ Message: "${text}"`);
      console.log(`Ã°Å¸â€ â€ Event ID: ${webhookEventId || 'N/A'}`);
      console.log(`Ã°Å¸â€œÅ  Message Length: ${text.length} characters`);
      
      // Detect message intent for early logging
      try {
        if (!Chatbot) throw new Error('Chatbot helpers unavailable');
        const { isDepositInquiry, isWithdrawalInquiry, isTurnoverInquiry, isOffTopicConversation, detectLanguage } = Chatbot;
        const detectedLang = detectLanguage(text);
        const intents = [];
        
        if (isDepositInquiry(text)) intents.push('Ã°Å¸â€™Â° DEPOSIT_INQUIRY');
        if (isWithdrawalInquiry(text)) intents.push('Ã°Å¸â€™Â¸ WITHDRAWAL_INQUIRY');
        if (isTurnoverInquiry(text)) intents.push('Ã°Å¸â€œÅ  TURNOVER_INQUIRY');
        if (isOffTopicConversation(text)) intents.push('Ã°Å¸â€â€ž OFF_TOPIC');
        
        console.log(`Ã°Å¸â€”Â£Ã¯Â¸Â  Language: ${detectedLang === 'id' ? 'Indonesian' : 'English'}`);
        console.log(`Ã°Å¸Å½Â¯ Detected Intent: ${intents.length > 0 ? intents.join(', ') : 'GENERAL_INQUIRY'}`);
        
        if (intents.length > 0) {
          console.log(`Auto-actions: ${intents.includes('🔹 DEPOSIT_INQUIRY') || intents.includes('🔹 WITHDRAWAL_INQUIRY') ? 'Support ping will be sent' : 'Standard AI response'}`);
        }
      } catch (e) {
        console.log('🔸 Intent detection: Standard processing');
      }

      console.log('🔗 =============================\n');
    }
    
      // Auto-map chat to group using webhook secret or payload group_id (if known)
      try {
        let gid = secretToGroup.get(matchedSecret);
        
        // ENHANCED: Try multiple locations for LiveChat Group ID
        if (!gid) {
          console.log('[incoming_event] Attempting to extract LiveChat Group ID from payload...');
          
          // Try all possible locations where LiveChat might send group_id
          const groupIdCandidates = [
            payload?.chat?.properties?.group,        // LiveChat properties
            payload?.properties?.group,              // Root properties
            payload?.chat?.group_id,                 // Direct chat property
            payload?.chat?.group?.id,                // Nested group object
            payload?.group_id,                       // Top-level
            payload?.group?.id,                      // Top-level nested
            payload?.event?.properties?.group,       // Event properties
            payload?.thread?.properties?.group       // Thread properties
          ];

          console.log('🔗 [incoming_event] Group ID candidates found:', groupIdCandidates.filter(c => c != null));

          let maybePayloadGroupId = null;
          for (const candidate of groupIdCandidates) {
            if (candidate) {
              const normalized = String(candidate).trim();
              if (normalized && normalized !== '0' && normalized !== 'null' && normalized !== 'undefined') {
                maybePayloadGroupId = normalized;
                console.log(`Ã¢Å“â€¦ [incoming_event] Found LiveChat Group ID: "${maybePayloadGroupId}"`);
                break;
              }
            }
          }
          
          if (maybePayloadGroupId) {
            const db = await getDb();
            const row = db.prepare('SELECT group_id FROM groups_config WHERE livechat_group_id = ?').get(maybePayloadGroupId);
            
            if (row && row.group_id) {
              gid = Number(row.group_id);
              console.log(`[incoming_event] Matched LiveChat Group ID "${maybePayloadGroupId}" → Internal Group ${gid}`);
            } else {
              console.warn(`🔍 [incoming_event] LiveChat Group ID "${maybePayloadGroupId}" found but NO MATCH in groups_config`);
              // Attempt auto-bind based on license or brand hints
              try {
                const licenseHint = payload?.chat?.access?.license_id || payload?.license_id || null;
                const brandHint = payload?.chat?.properties?.brand || payload?.brand || payload?.chat?.brand_name || null;
                let candidate = null;
                if (licenseHint) {
                  candidate = db.prepare('SELECT group_id FROM groups_config WHERE livechat_license = ? LIMIT 1').get(String(licenseHint));
                }
                if (!candidate && brandHint) {
                  candidate = db.prepare('SELECT g.id AS group_id FROM groups g LEFT JOIN groups_config gc ON gc.group_id = g.id WHERE gc.brand_name = ? OR g.name = ? LIMIT 1').get(String(brandHint), String(brandHint));
                }
                if (candidate && candidate.group_id) {
                  const bindGroupId = Number(candidate.group_id);
                  console.log(`[incoming_event] Auto-binding LiveChat Group ID "${maybePayloadGroupId}" to internal Group ${bindGroupId}`);
                  try {
                    const { setGroupLivechatGroupId } = require('./db-utils.js');
                    await setGroupLivechatGroupId(bindGroupId, maybePayloadGroupId);
                    gid = bindGroupId;
                    console.log(`[incoming_event] Persisted LC group id and will map subsequent chats to Group ${gid}`);
                  } catch (bindErr) {
                    console.warn(`🔒 [incoming_event] Auto-bind failed:`, bindErr?.message || bindErr);
                  }
                }
              } catch (autoErr) {
                console.warn(`🔍 [incoming_event] Auto-bind attempt failed:`, autoErr?.message || autoErr);
              }
            }
          } else {
            console.warn(`🔍 [incoming_event] No LiveChat Group ID found in webhook payload`);
          }
          // If no gid resolved yet, try deriving from request headers or default env
          if (!gid) {
            try {
              const deriveGroupIdFromHeaders = (headers) => {
                if (!headers) return null;
                const host = String(headers.host || headers.hostname || '').toLowerCase();
                const brand = String(headers['x-brand'] || headers['x-bbrand'] || headers['x-company'] || '').toLowerCase();
                if (host.includes('samcasino') || brand === 'sam') return 2;
                if (host.includes('goodcasino') || brand === 'good') return 1;
                if (host.includes('xyzcasino') || brand === 'xyz') return 3;
                // Try Authorization bearer that encodes brand/license (best-effort)
                const auth = String(headers.authorization || headers['Authorization'] || headers.Authorization || '').toLowerCase();
                if (auth.includes('sam')) return 2;
                if (auth.includes('good')) return 1;
                return null;
              };
              const derived = deriveGroupIdFromHeaders(req && req.headers ? req.headers : {});
              if (derived != null) {
                gid = Number(derived);
                console.log(`[incoming_event] Derived groupId from headers â†’ Internal Group ${gid}`);
              } else if (process.env.DEFAULT_GROUP_ID) {
                const def = Number(process.env.DEFAULT_GROUP_ID);
                if (!Number.isNaN(def)) {
                  gid = def;
                  console.log(`[incoming_event] Using DEFAULT_GROUP_ID from env â†’ Internal Group ${gid}`);
                }
              }
            } catch (hdrErr) { /* ignore header derivation errors */ }
          }
        } else {
          console.log(`[incoming_event] Mapped via webhook secret → Internal Group ${gid}`);
        }
        
        if (gid && messageChatId) {
          const { setChatGroup } = require('./db-utils.js');
          try {
            // Ensure chat row exists before mapping (non-fatal)
            try { await updateChatState(await getDb(), String(messageChatId), {}); } catch (_) {}
            await setChatGroup(String(messageChatId), Number(gid));
            console.log(`[incoming_event] Chat ${messageChatId} successfully mapped to Group ${gid}`);
          } catch (setErr) {
            console.warn(`🔒 [incoming_event] Failed persisting chat->group mapping (non-fatal):`, setErr?.message || setErr);
          }
        } else if (!gid) {
          console.warn(`🔍 [incoming_event] Chat ${messageChatId} could NOT be mapped to any group`);
        }
      } catch (mapErr) { console.error(`🔍 [incoming_event] Auto-map on incoming_event failed:`, mapErr?.message || mapErr); }
      
      if (webhookDedupeKeys.some((key) => hasProcessedAutoAiEvent(messageChatId, key))) {
        console.log(`🔍 [incoming_event] Ignored duplicate event (memory cache)`, { chatId: messageChatId, keys: webhookDedupeKeys });
        return;
      }
      if (isDuplicateEvent(webhookEventId)) {
        console.log(`🔍 [incoming_event] Ignored duplicate event`, webhookEventId);
        return;
      }

      // Update chat activity and store incoming message with enhanced logging
      try {
        await updateChatActivity(messageChatId, 'livechat');
        const dbi = dbForChatState || await getDb();
        if (text) {
          await addMessage(dbi, messageChatId, 'user', text);
          console.log(`🔒 [incoming_event] Stored customer message in database: Chat ${messageChatId}, Length: ${text.length}`);
          trackMessage(messageChatId, 'user');
        }
      } catch (e) {
        console.warn('Non-fatal: failed to persist incoming message', e?.message || e);
      }
        let previousEventId = null;
        try {
          previousEventId = await getLastCustomerEventId(messageChatId);
        } catch (err) {
          console.warn('Non-fatal: failed to read previous customer event id (webhook)', err?.message || err);
        }
        try {
          await updateLastCustomerEventId(messageChatId, webhookEventId);
        } catch (err) {
          console.warn('Non-fatal: failed to persist last customer event id (webhook)', err?.message || err);
        }
      // Avoid loops: ignore events created by this app/client_id only when not from a customer author
      const sourceInfo = eventPayload?.properties?.source || {};
      const sourceClient = sourceInfo?.client_id;
      const sourceTypeLower = String(sourceInfo?.type || '').toLowerCase();
      const authorTypeRaw = (isCustomerMessageAction ? (payload?.message?.author_type || payload?.message?.author?.type || null) : null) ||
                            payload?.event?.author_type ||
                            payload?.author_type ||
                            payload?.event?.author ||
                            sourceInfo?.type ||
                            null;
      const authorType = authorTypeRaw ? String(authorTypeRaw) : null;
      const authorTypeLower = authorType ? authorType.toLowerCase() : '';
      const allowedAuthorTypes = new Set(['customer']);
      if (sourceClient) {
        // Ignore messages created by our own clients (global or any group-level client IDs)
        const globalClient = (process.env.LIVECHAT_CLIENT_ID ?? '').toString().trim();
        let clientIds = new Set();
        if (globalClient) clientIds.add(globalClient);
        try {
          const db = await getDb();
          const rows = db.prepare('SELECT livechat_client_id FROM groups_config WHERE livechat_client_id IS NOT NULL').all();
          for (const r of (rows || [])) { const cid = (r.livechat_client_id || '').toString().trim(); if (cid) clientIds.add(cid); }
        } catch (_) { /* ignore */ }
        const fromOwnIntegration = clientIds.has(String(sourceClient));
        if (fromOwnIntegration && !allowedAuthorTypes.has(authorTypeLower) && !allowedAuthorTypes.has(sourceTypeLower)) {
          console.log('Ignored own message (sourceClient loop prevention)', {
            chatId,
            sourceClient,
            authorType: authorType || null,
            sourceType: sourceInfo?.type || null
          });
          return;
        }
      }
      if (authorType && !allowedAuthorTypes.has(authorTypeLower)) {
          console.log('Ã°Å¸â€ºâ€˜ Ignored message due to authorType not in allowed list', { chatId: messageChatId, authorType, allowed: Array.from(allowedAuthorTypes) });
        return;
      } else {
        console.log('Ã¢Å“â€¦ Accepted inbound message', { chatId: messageChatId, authorType: authorType || sourceInfo?.type || 'unknown', action });
      }

      // Cooldown per chat to avoid rapid-fire replies (can be disabled via env)
      const cooldownMs = parseInt(process.env.LIVECHAT_REPLY_COOLDOWN_MS || '1000', 10);
      const disableCd = String(process.env.DISABLE_WEBHOOK_COOLDOWN || '').toLowerCase() === 'true';
      if (!global.__lastReplyByChat) global.__lastReplyByChat = new Map();
      const now = Date.now();
      const last = global.__lastReplyByChat.get(messageChatId) || 0;
      const forceReply = String(process.env.FORCE_WEBHOOK_REPLY || '').toLowerCase() === 'true';
      if (!disableCd && !forceReply && now - last < cooldownMs) {
        console.log('Ã°Å¸â€¢â€™ Cooldown active; skipping reply', { chatId: messageChatId, waited: now - last, cooldownMs, forceReply });
        return;
      } else if (forceReply) {
        console.log('FORCE_WEBHOOK_REPLY active Ã¢â‚¬â€œ bypassing cooldown', { chatId: messageChatId });
      }
      global.__lastReplyByChat.set(messageChatId, now);

      // === Per-group Global Auto AI check (backend-driven) ===
      try {
        const { getGlobalAutoAi } = require('./db-utils.js');
        const { mapChatToGroup } = require('./livechat-group-helpers.js');
        let mapped = await mapChatToGroup({ chat_id: messageChatId, chat: payload?.chat, thread: payload?.thread, event: eventPayload, message: payload?.message });
        const mappedGroupId = mapped && mapped.internalGroupId ? Number(mapped.internalGroupId) : null;
        const perGroup = mappedGroupId ? await getGlobalAutoAi(mappedGroupId) : null;
        const perGroupEnabled = perGroup ? !!perGroup.enabled : null;
        const backendGlobal = global.__globalAutoAiState || {};

        // If global disabled or group explicitly disabled, skip backend auto-AI.
          const batchWindowMs_check = Math.max(0, parseInt(process.env.LIVECHAT_BATCH_WINDOW_MS || '3000', 10));
          if (!backendGlobal.enabled) {
            console.log('Global Auto AI globally disabled - continuing with webhook processing');
          } else if (perGroupEnabled === false) {
            console.log('Global Auto AI disabled for group - continuing with webhook processing', mappedGroupId);
          } else if (batchWindowMs_check > 0) {
            // If batching is enabled, skip backend auto-AI to avoid duplicate immediate replies.
            console.log('Batching enabled; skipping backend Global Auto AI to avoid duplicate replies');
          } else {
          // Backend Global Auto AI processing removed Ã¢â‚¬â€ webhook-based auto-reply will handle responses exclusively
        }
      } catch (e) {
        console.warn('Failed per-group Global Auto AI check (non-fatal):', e?.message || e);
      }

      // If backend auto-AI was triggered above, skip webhook auto-reply to avoid duplicates
      if (backendAutoAiTriggered) {
        console.log('🔍 Skipping webhook auto-reply because backend Global Auto AI already triggered for this message', { chatId: messageChatId });
        return;
      }
      // ============================================================================
      // WEBHOOK AUTO-REPLY RE-ENABLED - Primary response mechanism
      // ============================================================================
      // Webhook-based responses are now the primary auto-reply system.
      // This ensures immediate responses to customer messages via webhooks.
      // ============================================================================
      
      console.log(' Webhook auto-reply ENABLED - processing customer message');
      console.log('   Chat:', messageChatId, '| Message:', text.slice(0, 50) + '...');
      
      // Option: prefer the /api/bot/chat style reply first for webhooks
      const preferApiReply = String(process.env.PREFER_API_BOT_CHAT_REPLY_FIRST || '').toLowerCase() === 'true';

      // If configured to prefer API bot replies, attempt the centralized response now
      if (preferApiReply) {
        try {
          const messageIdForAiImmediate = webhookEventId || `${messageChatId}_${Date.now()}`;
          const replyContextImmediate = {
            chat_id: messageChatId,
            chat: payload?.chat,
            event: eventPayload,
            thread: payload?.thread,
            group_id: payload?.group_id || payload?.chat?.group_id || null
          };

          const sendEvalImmediate = evaluateChatIdForSend(messageChatId, req, payload);
          if (sendEvalImmediate.skip) {
            console.log('Skipping LiveChat send (local/test detected) [prefer-api-reply]', { chatId: messageChatId, reason: sendEvalImmediate.reason });
            webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
          } else {
            try {
              const { getChatStatus } = require('./db-utils.js');
              const chatStatusNow = await getChatStatus(messageChatId);
              const allowWhenInProgressNow = String(process.env.ALLOW_WEBHOOK_REPLY_WHEN_IN_PROGRESS || '').toLowerCase() === 'true';
              if (chatStatusNow === 'in_progress' && !allowWhenInProgressNow && !forceReply) {
                console.log(' Skipping webhook auto-reply because chat is currently handled by an agent [prefer-api-reply]', { status: chatStatusNow, chatId: messageChatId });
                webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
                if (previousEventId !== null) {
                  try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
                }
              } else {
                // Auto replies removed: skip calling the model and do not send a reply
                try {
                  console.log(`Skipping prefer-api immediate AI reply for chat ${messageChatId} (auto-attend removed).`);
                  try { const dbi3 = await getDb(); await addMessage(dbi3, messageChatId, 'system', 'Prefer-api immediate AI reply skipped (auto-attend removed).'); } catch(_) {}
                } catch (skipErr) {
                  console.warn('Non-fatal: failed while skipping prefer-api immediate AI reply:', skipErr?.message || skipErr);
                }
              }
            } catch (e) {
              console.warn('Failed to evaluate pre-send conditions for prefer-api-reply, continuing to fallback (non-fatal):', e?.message || e);
            }
          }
        } catch (e) {
          console.warn('Failed to perform prefer-api-reply immediate flow (continuing with standard flow):', e?.message || e);
        }
      }

      // Continue to webhook auto-reply processing
      

      webhookDedupeKeys = Array.from(new Set((webhookDedupeKeys || []).filter(Boolean)));

  const processingStartTime = Date.now();
  let aiProcessingTime = 0;
  let usedAiResponse = false;
  let maybeReply = null;
  let __skipSend = false;
      console.log('\nÃ°Å¸Â¤â€“ ===== AI PROCESSING STARTED =====');
      console.log(`Ã°Å¸â€œÂ± Chat ID: ${messageChatId}`);
      console.log(`Ã¢ÂÂ° Started: ${new Date().toLocaleString()}`);
      console.log(`Ã°Å¸â€œÂ Processing message: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
      console.log(`Ã°Å¸â€Â§ AI Mode: ${process.env.UNRESTRICTED_BOT === 'true' ? 'Unrestricted GPT' : 'Structured Bot'}`);

      // Controlled AI reply generation: attempt to generate a reply via the
      // Chatbot module when ENABLE_AUTO_BOT=true. Otherwise fall back to a
      // deterministic audit message indicating automation is disabled.
      let finalText = '';
      const enableAutoBot = String(process.env.ENABLE_AUTO_BOT || '').toLowerCase() === 'true';
  if (!enableAutoBot) {
        try {
          console.log(`Webhook AI processing skipped for chat ${messageChatId} (ENABLE_AUTO_BOT not set).`);
          try { const dbi = await getDb(); await addMessage(dbi, messageChatId, 'system', 'Webhook AI processing skipped (auto-attend disabled).'); } catch(_) {}
        } catch (skipErr) {
          console.warn('Non-fatal: failed to log skipped webhook AI processing:', skipErr?.message || skipErr);
        }
  finalText = await getConfiguredWelcomeMessageForChat(messageChatId);
      } else {
        // Try to generate AI reply; if it fails, fall back to the audit message
        try {
          console.log(`Ã°Å¸Â¤â€“ Webhook AI enabled: generating reply for chat ${messageChatId}`);
          const aiStartInner = Date.now();
            const stopTyping = startTypingWhileBusy(messageChatId);
            try {
              // PRE-AI GUARD: do not invoke LLMs when chat has been escalated to
              // human support (needs_human) or there is an active support ping.
              // This prevents the assistant from continuing to generate replies
              // after it has already issued a WAIT/processing message.
              try {
                const _status = (typeof getChatStatus === 'function') ? await getChatStatus(messageChatId).catch(() => null) : null;
                if (_status === 'needs_human') {
                  console.log(`[incoming_event] Skipping AI generation because chat ${messageChatId} is marked needs_human`);
                  __skipSend = true;
                } else {
                  // If an active in-memory support ping exists for this chat, skip generating AI as well
                  try {
                    if (Array.isArray(supportPings) && supportPings.some(p => String(p.chatId) === String(messageChatId) && !p.resolved && !p.read)) {
                      console.log(`[incoming_event] Skipping AI generation because active support ping exists for chat ${messageChatId}`);
                      __skipSend = true;
                    }
                  } catch (_) { }
                }
              } catch (_) { }

              if (!__skipSend) {
                if (groupReply && typeof groupReply.aggregateAndReply === 'function') {
                  const context = { chat: payload?.chat, thread: payload?.thread, group_id: payload?.group_id || payload?.chat?.group_id || null };
                  maybeReply = await groupReply.aggregateAndReply(messageChatId, text, context);
                }
                if (!maybeReply) { maybeReply = await gcGetResponse(messageChatId, text, webhookEventId || `${messageChatId}_${Date.now()}`); }
              }
            } finally {
              try { await stopTyping(); } catch (_) {}
            }
          aiProcessingTime = Date.now() - aiStartInner;
          finalText = '';
          if (maybeReply) {
            if (typeof maybeReply === 'object' && maybeReply.skip === true) {
              finalText = '';
              __skipSend = true;
            } else if (typeof maybeReply === 'string') {
              finalText = maybeReply.trim();
            } else if (typeof maybeReply === 'object' && maybeReply.reply) {
              const replyObj = maybeReply.reply;
              if (typeof replyObj === 'string') {
                finalText = replyObj.trim();
              } else if (replyObj && typeof replyObj === 'object') {
                if (typeof replyObj.reply === 'string') {
                  finalText = replyObj.reply.trim();
                } else if (typeof replyObj.text === 'string') {
                  finalText = replyObj.text.trim();
                } else if (typeof replyObj.content === 'string') {
                  finalText = replyObj.content.trim();
                } else if (typeof replyObj.message === 'string') {
                  finalText = replyObj.message.trim();
                } else {
                  try { finalText = JSON.stringify(replyObj); } catch { finalText = ''; }
                }
              } else {
                try { finalText = String(replyObj).trim(); } catch { finalText = ''; }
              }
            }
          }
          usedAiResponse = !!(finalText && finalText.length);
        } catch (aiErr) {
          console.warn('AI reply generation failed (falling back):', aiErr && aiErr.message ? aiErr.message : aiErr);
          try { const dbi = await getDb(); await addMessage(dbi, messageChatId, 'system', 'AI reply generation failed; fallback used.'); } catch(_) {}
          finalText = await getConfiguredWelcomeMessageForChat(messageChatId);
          usedAiResponse = false;
        }
      }
      // If this webhook call is a follower in an aggregated burst, skip sending entirely
      if (__skipSend) {
        console.log('Aggregation follower detected for chat', messageChatId, '- skipping send to ensure single consolidated reply');
        return;
      }

      // If no reply produced, prefer group-specific aiSettings messages; no generic fallbacks
      if (!finalText) {
        try {
          const dbiTmp = await getDb();
          const hasAny = dbiTmp.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND role = ? LIMIT 1').get(messageChatId, 'assistant');
          const isFirstInteraction = !hasAny;

          // Resolve internal group id for this chat
          let internalGroupId = null;
          try {
            const row = await getChatGroup(messageChatId).catch(() => null);
            if (row != null) {
              const val = row.group_id ?? row.groupId ?? row.GROUP_ID ?? row;
              const num = Number(val);
              if (!Number.isNaN(num)) internalGroupId = num;
            }
          } catch (_) { internalGroupId = null; }

          // Load aiSettings for the group and choose a message
          if (internalGroupId != null) {
            try {
              const cfg = await dbUtils.getGroupConfig(internalGroupId);
              const ai = (cfg && cfg.aiSettings) ? cfg.aiSettings : {};
              const cm = (ai && ai.customMessages && typeof ai.customMessages === 'object') ? ai.customMessages : {};

              // First message: use group welcome message if available
              if (isFirstInteraction) {
                finalText = (ai.welcomeMessage || cm.welcomeMessage || '').toString().trim();
              }

              // For subsequent messages (or if welcome missing), use a group-defined wait/hold message if present
              if (!finalText) {
                finalText = (ai.waitMessage || cm.waitMessage || '').toString().trim();
              }
            } catch (_) { /* keep empty if loading fails */ }
          }

          // If still empty, skip sending instead of generic fallback
          if (!finalText) {
            __skipSend = true;
          }
        } catch(_) {
          // On DB errors, also skip sending any generic text
          __skipSend = true;
        }
      }
      
      console.log('Ã°Å¸Â¤â€“ ===== AI RESPONSE READY =====');
      console.log(`Ã°Å¸â€œÂ Response: "${finalText}"`);
      console.log(`Ã°Å¸â€œÅ  Length: ${finalText.length} characters`);
      console.log(`Ã¢ÂÂ±Ã¯Â¸Â  Total processing time: ${Date.now() - processingStartTime}ms`);
      
      // Real-time performance tracking and monitoring
      const totalProcessingTime = Date.now() - processingStartTime;
      const performanceMetrics = {
        aiTime: aiProcessingTime || 0,
        totalTime: totalProcessingTime,
        messageLength: text.length,
        responseLength: finalText.length,
        chatId: messageChatId,
        timestamp: new Date().toISOString(),
        hasAiResponse: !!usedAiResponse,
        fallbackUsed: !usedAiResponse
      };
      
      // Log performance warnings for monitoring
      if (totalProcessingTime > 10000) {
        console.warn('🚨 SLOW RESPONSE WARNING: Total processing exceeded 10 seconds');
      } else if (totalProcessingTime > 5000) {
        console.warn('⚠️ Response time above 5 seconds - consider optimization');
      } else if (totalProcessingTime < 1000) {
        console.log('🎉 FAST RESPONSE: Under 1 second total processing time');
      }
      
      // Store performance metrics for real-time analytics
      try {
        if (!global.__performanceMetrics) global.__performanceMetrics = [];
        global.__performanceMetrics.push(performanceMetrics);
        
        // Keep only last 100 metrics in memory for dashboard
        if (global.__performanceMetrics.length > 100) {
          global.__performanceMetrics = global.__performanceMetrics.slice(-100);
        }
      } catch(e) {
        console.warn('Failed to store performance metrics:', e.message);
      }
      
      const sendEval = evaluateChatIdForSend(messageChatId, req, payload);
  let webhookSendSucceeded = false;
  let persistedSignatureState = false;
      const replyContext = {
        chat_id: messageChatId,
        chat: payload?.chat,
        event: eventPayload,
        thread: payload?.thread,
        group_id: payload?.group_id || payload?.chat?.group_id || null
      };
      let replyMapping = { lcGroupId: null, internalGroupId: null };
      try {
        const mapped = await mapChatToGroup(replyContext);
        if (mapped) {
          replyMapping = mapped;
        }
      } catch (err) {
        console.warn('Reply mapping failed', { chatId: messageChatId, error: err?.message || err });
      }

      // If mapping failed (no livechat group id or internal group), persist
      // the entire incoming payload for later inspection. This helps debug
      // cases where extractGroupId returns empty (e.g. T22OGTLCZZ / T237EGBEDT).
      try {
        if (!replyMapping || (!replyMapping.lcGroupId && !replyMapping.internalGroupId)) {
          const { saveChatLivechatMetadata } = require('./db-utils.js');
          const meta = {
            livechat_group_id: replyContext.group_id || payload?.chat?.properties?.group || payload?.chat?.group_id || null,
            livechat_license: payload?.chat?.access?.license_id || payload?.license_id || null,
            access_group_ids: payload?.chat?.access?.group_ids || null,
            webhook_action: action,
            // keep a compact snapshot but include full payload for debugging
            payload_snapshot: {
              chat_id: messageChatId,
              raw_payload: payload,
              event: eventPayload || null,
              message: payload?.message || null,
              thread: payload?.thread || null,
              captured_at: Date.now()
            }
          };
          await saveChatLivechatMetadata(String(messageChatId), meta);
          try { console.log(`Ã°Å¸â€™Â¾ Saved LiveChat metadata for chat ${messageChatId} due to missing mapping (for debugging)`); } catch(_) {}
        }
      } catch (metaSaveErr) {
        console.warn('Failed to persist webhook payload metadata on mapping failure:', metaSaveErr?.message || metaSaveErr);
      }

      // Check persisted chat status to avoid replying while an agent is handling the chat.
      // This reproduces the behaviour you observed in logs and can be overridden with
      // the environment variable ALLOW_WEBHOOK_REPLY_WHEN_IN_PROGRESS=true for testing.
      try {
        const { getChatStatus } = require('./db-utils.js');
        const chatStatus = await getChatStatus(messageChatId);
        const allowWhenInProgress = String(process.env.ALLOW_WEBHOOK_REPLY_WHEN_IN_PROGRESS || '').toLowerCase() === 'true';
        // Also treat 'needs_human' as a blocking status for auto-replies so
        // the assistant does not continue after issuing a WAIT/processing message.
        if ((chatStatus === 'in_progress' || chatStatus === 'needs_human') && !allowWhenInProgress && !forceReply) {
          console.log('Skipping webhook auto-reply because chat is currently handled by an agent', { status: chatStatus, chatId: messageChatId });
          // Clean up any dedupe keys and restore previous event id if needed
          webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
          if (previousEventId !== null) {
            try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
          }
          return;
        } else if (chatStatus === 'in_progress' && allowWhenInProgress) {
          console.log('🎉 ALLOW_WEBHOOK_REPLY_WHEN_IN_PROGRESS is set – proceeding to send reply despite in_progress', { chatId: messageChatId });
        }
      } catch (e) {
        console.warn('Non-fatal: failed to evaluate chat status before send', e?.message || e);
      }

      if (sendEval.skip) {
        console.log('Skipping LiveChat send (local/test detected)', {
          chatId: messageChatId,
          reason: sendEval.reason,
          match: sendEval.match || null,
          allowOverride: sendEval.allowFake
        });
        console.log('Ã°Å¸Â¤â€“ ===================================\n');
        webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
        if (previousEventId !== null) {
          try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
        }
      } else {
        try {
          const dbForUpdate = dbForChatState || await getDb();
          const updatedAutoAiState = Object.assign({}, autoAiStateSnapshot || {}, {
            lastCustomerSignature: customerSignature.signature,
            lastCustomerSignatureAt: Date.now(),
            lastCustomerAuthor: customerSignature.normalizedAuthor,
            lastCustomerTextPreview: customerSignature.normalizedText.slice(0, 160)
          });
          // Merge persisted snapshot with live in-memory Chatbot state (if available)
          // This ensures transient flows (like depositState) are persisted so
          // follow-up messages are handled correctly across webhook events.
          let liveChatState = {};
          try {
            if (typeof gcGetChatState === 'function') {
              liveChatState = gcGetChatState(messageChatId) || {};
            }
          } catch (_) { liveChatState = {}; }

          const chatStatePayload = Object.assign({}, chatStateSnapshot || {}, liveChatState || {});
          chatStatePayload.__autoAi = updatedAutoAiState;
          try {
            await updateChatState(dbForUpdate, messageChatId, chatStatePayload);
            persistedSignatureState = true;
          } catch (persistErr) {
            console.warn('Non-fatal: failed to persist customer signature before send', persistErr?.message || persistErr);
          }

          // If the generated AI reply object requested USER ID or signals a
          // deposit/withdraw/password_reset intent, create a support ping
          // server-side and suppress sending. This ensures pings created by
          // the LLM (or its parsed JSON) prevent the assistant from posting
          // into the chat while human support is required.
          try {
            let _pingCreatedFromAiSignal = false;
            try {
              if (maybeReply && typeof maybeReply === 'object') {
                const mrIntent = String(maybeReply.intent || '').toLowerCase();
                const contextProcessing = !!(maybeReply.context && (maybeReply.context.processing === true || maybeReply.context.processing === 'true'));
                const isProcessingIntent = ['processing', 'still_processing'].includes(mrIntent) || contextProcessing || (maybeReply.status && String(maybeReply.status).toLowerCase() === 'processing');
                if (isProcessingIntent) {
                  const pingType = 'deposit_check';
                  try {
                    if (typeof createSupportPing === 'function') {
                      const amount = (maybeReply.context && maybeReply.context.amount) ? maybeReply.context.amount : null;
                      createSupportPing({ type: pingType, chatId: String(messageChatId), userId: 'livechat', amount: amount || null, language: (maybeReply.context && maybeReply.context.language) ? maybeReply.context.language : 'id', message: finalText });
                      _pingCreatedFromAiSignal = true;
                      try { await setChatStatus(messageChatId, 'needs_human'); } catch(_) {}
                      console.log(`[incoming_event] Created support ping (from AI signal) for chat ${messageChatId} type=${pingType}`);
                    }
                  } catch (e) { /* swallow */ }
                }
              }
            } catch (_) { /* swallow */ }
            if (_pingCreatedFromAiSignal) {
              console.log(`[incoming_event] Suppressing auto-reply for chat ${messageChatId} because AI signalled human handoff`);
              webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
              if (previousEventId !== null) {
                try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
              }
              return;
            }
            // Also inspect the finalText for a WAIT/processing message (e.g. "tunggu sebentar", "lagi dicek")
            try {
              const txt = String(finalText || '').toLowerCase();
              const waitPatterns = [/tunggu\s*(sebentar|ya|dulu)?/, /lagi\s*(dicek|diproses|diperiksa)/, /sedang\s*(diproses|dicek)/, /please\s+wait/, /wait\s+please/, /lagi\s+dicek/];
              if (txt && waitPatterns.some(rx => rx.test(txt))) {
                try {
                  if (typeof createSupportPing === 'function') {
                    createSupportPing({ type: 'deposit_check', chatId: String(messageChatId), userId: 'livechat', amount: null, language: 'id', message: finalText });
                    try { await setChatStatus(messageChatId, 'needs_human'); } catch(_) {}
                    console.log(`[incoming_event] Created support ping (from finalText WAIT prompt) for chat ${messageChatId}`);
                  }
                } catch (_) {}
                console.log(`[incoming_event] Suppressing auto-reply for chat ${messageChatId} because assistant issued WAIT/processing message`);
                webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
                if (previousEventId !== null) {
                  try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
                }
                return;
              }
            } catch (_) {}
          } catch (_) {}

          // If there's an active support ping for this chat, suppress auto-reply
          try {
            let _hasActiveSupportPing = false;
            try {
              if (Array.isArray(supportPings)) {
                _hasActiveSupportPing = supportPings.some(p => String(p.chatId) === String(messageChatId) && !p.resolved && !p.read);
              }
            } catch (_) { _hasActiveSupportPing = false; }
            if (_hasActiveSupportPing) {
              console.log(`[incoming_event] Suppressing auto-reply for chat ${messageChatId} due to active support ping`);
              webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
              if (previousEventId !== null) {
                try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
              }
              return;
            }
          } catch (_) {}

          // Send immediately: no buffering/combining window
          addReplyToBuffer({
            chatId: messageChatId,
            threadId: (payload?.thread?.id || payload?.thread_id || null),
            text: finalText,
            replyContextFactory: () => ({
              chat_id: messageChatId,
              chat: payload?.chat,
              event: eventPayload,
              thread: payload?.thread,
              group_id: payload?.group_id || payload?.chat?.group_id || null
            })
          });
          // Immediate send path used; no combined timer
          webhookSendSucceeded = false;
          console.log('dY-ï¿½ Buffered bot reply for combine window');
          console.log('dY\u000f- ===================================\\n');
        } catch (e) {
          console.error('Ã¢ÂÅ’ Failed sending bot reply to LiveChat:', e?.response?.data || e.message);
          if (persistedSignatureState) {
            try {
              const dbForRollback = dbForChatState || await getDb();
              const revertStatePayload = Object.assign({}, chatStateSnapshot || {});
              if (autoAiStateBeforeUpdate) {
                revertStatePayload.__autoAi = autoAiStateBeforeUpdate;
              } else if (Object.prototype.hasOwnProperty.call(revertStatePayload, '__autoAi')) {
                delete revertStatePayload.__autoAi;
              }
              await updateChatState(dbForRollback, messageChatId, revertStatePayload);
            } catch (rollbackErr) {
              console.warn('Non-fatal: failed to roll back customer signature state', rollbackErr?.message || rollbackErr);
            }
          }
          webhookDedupeKeys.forEach((key) => removeDuplicateEvent(key));
          if (previousEventId !== null) {
            try { await updateLastCustomerEventId(messageChatId, previousEventId); } catch(_) {}
          }
          console.log('Ã°Å¸Â¤â€“ ===================================\n');
        }
      }

      if (webhookSendSucceeded) {
        try {
          const dbi2 = await getDb();
          await addMessage(dbi2, messageChatId, 'assistant', finalText);
          console.log('Ã°Å¸â€”â€žÃ¯Â¸Â Stored assistant reply', { chatId: messageChatId, len: finalText.length });
        } catch (e) {
          console.warn('Failed storing assistant reply', e?.message || e);
        }

        webhookDedupeKeys.forEach((key) => markAutoAiEventProcessed(messageChatId, key));

        rememberAssistantMessage(messageChatId, finalText, { senderId: 'webhook-auto' });
        trackMessage(messageChatId, 'assistant');

        // Immediate dedupe protection: set a short-lived in-memory flag so other
        // processing paths skip this chat for a short window.
        try {
          if (!global.__recentWebhookHandled) global.__recentWebhookHandled = new Map();
          global.__recentWebhookHandled.set(messageChatId, Date.now());
          setTimeout(() => { try { global.__recentWebhookHandled.delete(messageChatId); } catch(_) {} }, 5000);
        } catch (e) {
          console.warn('Non-fatal: failed to set recentWebhookHandled flag', e?.message || e);
        }

        // Update chat ticket status to in_progress after bot replies
        try { await setChatStatus(messageChatId, 'in_progress'); } catch(_) {}

        // AFTER AI reply, evaluate if escalation to human support is required
        try {
          const evt = detectSupportEvent(text);
          if (evt) {
            if (!global.__lastSupportPingByChat) global.__lastSupportPingByChat = new Map();
            const map = global.__lastSupportPingByChat;
            const key = `${chatId}:${evt.type}`;
            const nowTs = Date.now();
            const lastPing = map.get(key) || 0;
            const minIntervalMs = parseInt(process.env.SUPPORT_PING_MIN_INTERVAL_MS || '180000', 10); // default 3 minutes
            if (nowTs - lastPing >= minIntervalMs) {
              createSupportPing({
                type: evt.type,
                chatId,
                userId: 'livechat',
                amount: evt.amount || null,
                language: 'id',
                message: text
              });
              map.set(key, nowTs);
              console.log(`Ã°Å¸â€œÂ£ Support ping created for chat ${chatId} (reason: ${evt.type})`);
              // Reflect needs_human in persisted status
              try { await setChatStatus(chatId, 'needs_human'); } catch(_) {}
            } else {
              console.log(`Ã°Å¸â€¢â€™ Skipping support ping (cooldown) chat=${chatId} reason=${evt.type}`);
            }
          }
        } catch (e) {
          console.warn('Support escalation check failed (non-fatal):', e?.message || e);
        }
      }
    } catch (err) {
      console.error('Error processing webhook:', err.response?.data || err.message);
    }
  });
});

// Diagnostic: analyze why a bot reply may not have been sent
app.get('/api/livechat/diagnose/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return; // allow JWT
  const { chatId } = req.params;
  try {
    const threads = await livechatPost('/agent/action/list_threads', { chat_id: chatId }, {});
    if (!threads.ok) return res.status(threads.status).json({ success:false, error: threads.error, details: threads.raw });
    const threadList = threads.data?.threads || threads.data?.data?.threads || [];
    const events = threadList.flatMap(t => t.events || []);
    const messages = events.filter(e => e.type === 'message');
    const lastMsg = messages[messages.length - 1];
    let reason = 'unknown';
    if (!lastMsg) reason = 'no_messages';
    else if (!lastMsg.author_id) reason = 'last_event_no_author_id';
    else if (/agent|bot/i.test(lastMsg.author_id)) reason = 'last_message_already_agent_or_bot';
    else {
      // Check cooldown condition
      const cooldownMs = parseInt(process.env.LIVECHAT_REPLY_COOLDOWN_MS || '3000', 10);
      const lastTs = global.__lastReplyByChat?.get(chatId) || 0;
      const since = Date.now() - lastTs;
      if (since < cooldownMs) reason = 'cooldown_active'; else reason = 'should_have_replied';
    }
    res.json({ success:true, chatId, reason, lastMessageAuthor: lastMsg?.author_id || null, lastMessageText: lastMsg?.text || null, eventCount: events.length });
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

// Manual test endpoint to force a bot reply to a given chat (owner/master only or BOT_SECRET)
app.post('/api/livechat/bot/reply', async (req, res) => {
  if (!requireBotSecret(req, res)) return; // allow JWT or secret
  try {
    const { chatId, message } = req.body || {};
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId required' });
    const userMsg = message || 'hello';
    // Manual bot reply: generate using Chatbot logic if available
    try {
  const startManual = Date.now();
  const stopTyping = startTypingWhileBusy(chatId);
  let reply = null;
        try {
          reply = await gcGetResponse(chatId, userMsg, `${chatId}_${Date.now()}`);
        } finally {
          try { await stopTyping(); } catch (_) {}
        }
        const manualElapsed = Date.now() - startManual;
        console.log(`\u23f1 /api/livechat/bot/reply AI generation took ${manualElapsed}ms for chat ${chatId}`);
        const finalText = (() => {
          if (!reply) return 'No automated reply generated.';
          if (typeof reply === 'string') return reply.trim() || 'No automated reply generated.';
          if (typeof reply === 'object' && reply.reply) return String(reply.reply).trim() || 'No automated reply generated.';
          return 'No automated reply generated.';
        })();

        // Respect STRICT_WEBHOOK_ONLY: do not send from manual/admin endpoints when enabled
        const strictWebhookOnly = String(process.env.STRICT_WEBHOOK_ONLY || '').toLowerCase() === 'true';
        if (strictWebhookOnly) {
          try { const dbi2 = await getDb(); await addMessage(dbi2, chatId, 'assistant', `[SUPPRESSED - STRICT_WEBHOOK_ONLY] ${finalText}`); } catch(_) {}
          return res.json({ success: true, chatId, sent: false, suppressed: true, reply: finalText });
        }

      const groupMapping = await getChatGroup(chatId);
      const internalGroupId = groupMapping ? (groupMapping.group_id ?? groupMapping.groupId ?? null) : null;
      const lcGroupId = internalGroupId ? await getGroupLivechatGroupId(internalGroupId) : null;
      let sent = false;
      try {
        await sendReply(
          {
            chat_id: chatId,
            chat: { id: chatId, group_id: lcGroupId }
          },
          finalText,
          {
            internalGroupId,
            groupId: lcGroupId
          }
        );
        sent = true;
      } catch (e) {
        return res.status(502).json({ success: false, error: 'Failed to send via LiveChat', details: e?.response?.data || e.message, reply: finalText });
      }

      try { const dbi2 = await getDb(); await addMessage(dbi2, chatId, 'assistant', finalText); console.log('Ã°Å¸â€”â€žÃ¯Â¸Â Stored assistant reply (manual endpoint)', { chatId, len: finalText.length }); } catch (e) { console.warn('Failed storing assistant reply (manual endpoint)', e?.message || e); }
      return res.json({ success: true, chatId, sent, reply: finalText });
    } catch (e) {
      console.error('Error generating/sending manual bot reply:', e && e.message ? e.message : e);
      return res.status(500).json({ success: false, error: e && e.message ? e.message : 'Failed to generate reply' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Manual: force proactive welcome if none sent yet
app.post('/api/livechat/bot/welcome', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  try {
    const { chatId } = req.body || {};
    if (!chatId) return res.status(400).json({ success:false, error:'chatId required' });
    const dbi = await getDb();
    const existing = dbi.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND role = ? LIMIT 1').get(chatId, 'assistant');
    if (existing) return res.json({ success:true, skipped:true, reason:'assistant message already exists' });
  const welcome = await getConfiguredWelcomeMessageForChat(chatId);
    const groupMapping = await getChatGroup(chatId);
    const internalGroupId = groupMapping ? (groupMapping.group_id ?? groupMapping.groupId ?? null) : null;
    const lcGroupId = internalGroupId ? await getGroupLivechatGroupId(internalGroupId) : null;
    try {
      // Centralized finalizer removed for automated replies. Send a simple
      // informational system message to the DB instead of posting an assistant reply.
      try { await addMessage(dbi, chatId, 'system', 'Welcome flow skipped: automated replies are disabled.'); } catch(_) {}
    } catch(e) { return res.status(502).json({ success:false, error:'send_failed', details: e?.response?.data || e.message }); }
    res.json({ success:true, sent:false, chatId, message: 'Welcome flow skipped: automated replies disabled.' });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// REMOVED: Global Auto AI polling endpoint - now using webhook-based responses only
// The /api/livechat/bot/attend endpoint has been completely removed to disable polling functionality

// New: webhook-only attend proxy
// This endpoint accepts an attend request and proxies it into the local
// `/livechat/webhook` handler using the configured webhook secret. This lets
// the Global Auto AI / UI "attend" flow use the webhook processing path
// instead of performing LiveChat auth (accept/join/send) flows.
// /api/livechat/bot/attend is intentionally disabled.
// Historically the UI called this to 'attend' chats which proxied into the webhook
// processing pipeline and could trigger the assistant. To prevent automatic
// assistant invocations from the client, this endpoint now returns 410 Gone.
app.post('/api/livechat/bot/attend', auth.authMiddleware(), async (req, res) => {
  return res.status(410).json({ success: false, error: 'disabled', message: 'Client-initiated auto-attend has been disabled. Use webhooks or server-side automation controls.' });
});

// Global Auto AI state management
// Global Auto AI state management
app.get('/api/auto-ai/global', auth.authMiddleware(), async (req, res) => {
  try {
  global.__globalAutoAiState = Object.assign({}, global.__globalAutoAiState, state || {});
  // Agent Chat Manager remains enabled for webhook-based responses
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/auto-ai/global', auth.authMiddleware(), async (req, res) => {

  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const desiredEnabled = !!req.body?.enabled;
    const scope = req.body?.scope || null;
    const now = new Date().toISOString();
    const currentState = await getGlobalAutoAiState();
    const currentUserId = Number(req.user.id);

    if (desiredEnabled) {
      // Lock Global Auto AI to this user and scope
      const dbLock = await getDb();
      const updateResult = dbLock.prepare(`
        UPDATE auto_ai_settings 
        SET enabled = 1, 
            locked_by_user_id = ?,
            locked_by_email = ?,
            locked_by_role = ?,
            locked_scope = ?,
            locked_at = ?,
            last_updated = ?
        WHERE id = 1
      `).run(currentUserId, req.user.email, req.user.role, scope || null, now, now);

      global.__globalAutoAiState = {
        enabled: true,
        lockedByUserId: currentUserId,
        lockedByEmail: req.user.email,
        lockedByRole: req.user.role,
        lockedScope: scope,
        lockedAt: now,
        lastUpdated: now
      };
      
      console.log('Ã¢Å“â€¦ Global Auto AI enabled and locked', {
        userId: currentUserId,
        email: req.user.email,
        role: req.user.role,
        scope: scope || 'all'
      });

      res.json({
        success: true,
        enabled: true,
        lockedByUserId: currentUserId,
        lockedByEmail: req.user.email,
        lockedByRole: req.user.role,
        lockedScope: scope,
        message: 'Global Auto AI enabled successfully - Agent Chat Manager remains active for webhook-based responses'
      });

    } else {
      // Disable Global Auto AI
      const dbDisable = await getDb();
      const disableResult = dbDisable.prepare(`
        UPDATE auto_ai_settings 
        SET enabled = 0, 
            locked_by_user_id = NULL,
            locked_by_email = NULL,
            locked_by_role = NULL,
            locked_scope = NULL,
            locked_at = NULL,
            last_updated = ?
        WHERE id = 1
      `).run(now);

      global.__globalAutoAiState = {
        enabled: false,
        lockedByUserId: null,
        lockedByEmail: null,
        lockedByRole: null,
        lockedScope: null,
        lockedAt: null,
        lastUpdated: now
      };
      
      console.log('Ã¢Å“â€¦ Global Auto AI disabled', {
        disabledBy: req.user.email,
        role: req.user.role
      });

      res.json({
        success: true,
        enabled: false,
        message: 'Global Auto AI disabled successfully - Agent Chat Manager remains active for webhook-based responses'
      });
    }

  } catch (e) {
    console.error('Failed to toggle Global Auto AI:', e?.message || e);
    res.status(500).json({ success: false, error: e?.message || 'Internal server error' });
  }
});

// Global Auto AI state management
// Global Auto AI endpoints removed. Manage automated flows via server-side
// scripts or reintroduce a controlled API behind authentication if needed.

// --- Admin: Clear chats and tickets (Owner only) ---
app.post('/api/admin/clear', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const db = await getDb();
    let deletedChats = 0, deletedMessages = 0, deletedChatGroups = 0;
    const tx = db.transaction(() => {
      try { const info = db.prepare('DELETE FROM messages').run(); deletedMessages = info.changes || 0; } catch(_) {}
      try { const info = db.prepare('DELETE FROM chats').run(); deletedChats = info.changes || 0; } catch(_) {}
      try { const info = db.prepare('DELETE FROM chat_groups').run(); deletedChatGroups = info.changes || 0; } catch(_) {}
    });
    tx();
    // Clear in-memory support pings and activity maps if present
    try {
      if (Array.isArray(supportPings)) { supportPings.length = 0; }
      if (global.__lastSupportPingByChat) global.__lastSupportPingByChat = new Map();
      if (global.__lastReplyByChat) global.__lastReplyByChat = new Map();
    } catch(_) {}
    res.json({ success: true, deleted: { chats: deletedChats, messages: deletedMessages, chatGroups: deletedChatGroups } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- Chat status APIs ----
// Get status for one or many chatIds (?ids=a,b,c) -> { map: {id: status} }
app.get('/api/chat-status', auth.authMiddleware(), async (req, res) => {
  try {
    const idsRaw = String(req.query.ids || '').trim();
    if (!idsRaw) return res.json({ success: true, map: {} });
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const map = await getChatStatusMap(ids);
    res.json({ success: true, map });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Set status for a chat: body { status: 'in_progress'|'completed'|'needs_human' }
app.put('/api/chat/:id/status', auth.authMiddleware(), async (req, res) => {
  try {
    const id = String(req.params.id);
    const status = String(req.body?.status || '').trim();
    if (!id || !status) return res.status(400).json({ success: false, error: 'id and status required' });
    const s = await setChatStatus(id, status);
    res.json({ success: true, id, status: s });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// API endpoint to get dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');

    const now = Math.floor(Date.now() / 1000);
    const activeWindowSec = parseInt(process.env.DASHBOARD_ACTIVE_WINDOW_SEC || '900', 10); // default 15 minutes
    const openWindowSec = parseInt(process.env.DASHBOARD_OPEN_WINDOW_SEC || '86400', 10); // default 24 hours
    const sinceActive = now - activeWindowSec;
    const sinceOpen = now - openWindowSec;
    const groupIdParam = req.query.groupId ? Number(req.query.groupId) : null;

    // Active users = distinct chats with a recent user message
    let activeUsersRow;
    if (groupIdParam) {
      activeUsersRow = db.prepare(
        'SELECT COUNT(DISTINCT m.chat_id) AS c FROM messages m JOIN chat_groups cg ON cg.chat_id = m.chat_id WHERE m.role = ? AND m.timestamp >= ? AND cg.group_id = ?'
      ).get('user', sinceActive, groupIdParam);
    } else {
      activeUsersRow = db.prepare(
        'SELECT COUNT(DISTINCT chat_id) AS c FROM messages WHERE role = ? AND timestamp >= ?'
      ).get('user', sinceActive);
    }
  const activeUsersRaw = (activeUsersRow && activeUsersRow.c) ? activeUsersRow.c : 0;

    // Open tickets = chats with recent activity
    let openTicketsRow;
    if (groupIdParam) {
      openTicketsRow = db.prepare(
        'SELECT COUNT(*) AS c FROM chats c JOIN chat_groups cg ON cg.chat_id = c.id WHERE c.last_activity >= ? AND cg.group_id = ?'
      ).get(sinceOpen, groupIdParam);
    } else {
      openTicketsRow = db.prepare(
        'SELECT COUNT(*) AS c FROM chats WHERE last_activity >= ?'
      ).get(sinceOpen);
    }
  const openTickets = (openTicketsRow && openTicketsRow.c) ? openTicketsRow.c : 0;
  // Fallback: if no recorded user messages yet (e.g., server restarted) but there are open tickets, approximate active users by open tickets
  const activeUsers = (activeUsersRaw === 0 && openTickets > 0) ? openTickets : activeUsersRaw;

    // AI responses count (assistant messages)
    let aiRespRow;
    if (groupIdParam) {
      aiRespRow = db.prepare(
        `SELECT COUNT(*) AS c
         FROM messages m
         JOIN chat_groups cg ON cg.chat_id = m.chat_id
         WHERE m.role = 'assistant' AND cg.group_id = ?`
      ).get(groupIdParam);
    } else {
      aiRespRow = db.prepare(
        `SELECT COUNT(*) AS c
         FROM messages WHERE role = 'assistant'`
      ).get();
    }
    const aiResponses = (aiRespRow && aiRespRow.c) ? aiRespRow.c : 0;

    // Total tickets (chats) received lifetime
    let totalTicketsRow;
    if (groupIdParam) {
      totalTicketsRow = db.prepare(
        `SELECT COUNT(*) AS c FROM chat_groups WHERE group_id = ?`
      ).get(groupIdParam);
    } else {
      totalTicketsRow = db.prepare(`SELECT COUNT(*) AS c FROM chats`).get();
    }
    const totalTickets = (totalTicketsRow && totalTicketsRow.c) ? totalTicketsRow.c : 0;

    // Token usage totals (owner-focused metric)
    let tokenTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
      const { getAiUsageTotals } = require('./db-utils.js');
      tokenTotals = await getAiUsageTotals({ since: null, groupId: groupIdParam || null });
    } catch (_) {}

    console.log(' Dashboard stats computed', { activeUsers, activeUsersRaw, openTickets, aiResponses, totalTickets, sinceActive, sinceOpen });
    res.json({ success: true, activeUsers, openTickets, aiResponses, totalTickets, tokenTotals, timestamp: Date.now(), rawActiveUsers: activeUsersRaw });
  } catch (error) {
    console.error('Error getting dashboard stats:', error);
    res.status(500).json({ success: false, error: 'Failed to get dashboard stats' });
  }
});

// Owner-only: AI usage totals with optional filters (?sinceMs=..&groupId=..)
app.get('/api/admin/ai-usage', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : null;
    const groupId = req.query.groupId ? Number(req.query.groupId) : null;
    const { getAiUsageTotals } = require('./db-utils.js');
    const totals = await getAiUsageTotals({ since: sinceMs, groupId });
    res.json({ success: true, totals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Owner-only: Reset AI token usage to 0
app.post('/api/admin/reset-tokens', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const dbi = await getDb();
    // Delete all records from ai_usage table
    const result = dbi.prepare('DELETE FROM ai_usage').run();
    console.log(`Ã°Å¸â€â€ž AI token usage reset by user ${req.user.id} (${req.user.email}). Deleted ${result.changes} records.`);
    res.json({ success: true, message: 'AI token usage reset to 0', deletedRecords: result.changes });
  } catch (e) {
    console.error('Error resetting AI token usage:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin: Agent activity logs (owner/master)
// Query params: sinceMs (optional), agentId (optional), limit (default 100)
app.get('/api/admin/agent-activity', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const dbi = await getDb();
    const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : null;
    const agentId = req.query.agentId ? Number(req.query.agentId) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));

    let sql = `SELECT l.id, l.user_id, u.email, l.chat_id, l.action, l.details, l.timestamp
               FROM agent_logs l
               JOIN users u ON u.id = l.user_id
               WHERE u.role = 'agent'`;
    const params = [];
    if (sinceMs) { sql += ' AND l.timestamp >= ?'; params.push(Math.floor(sinceMs / 1000)); }
    if (agentId) { sql += ' AND l.user_id = ?'; params.push(agentId); }

    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      if (allowedIds.size === 0) return res.json({ success: true, logs: [] });
      const rows = dbi.prepare(`SELECT DISTINCT ag.user_id AS agent_id
                                FROM agent_groups ag
                                WHERE ag.group_id IN (${Array.from(allowedIds).map(()=>'?').join(',')})`).all(...Array.from(allowedIds));
      const allowedAgentIds = new Set(rows.map(r => r.agent_id));
      sql += ' ORDER BY l.id DESC LIMIT ?'; params.push(limit);
      const raw = dbi.prepare(sql).all(...params);
      const logs = raw.filter(r => allowedAgentIds.has(r.user_id) || r.user_id === req.user.id)
        .map(r => ({ id: r.id, userId: r.user_id, email: r.email, chatId: r.chat_id, action: r.action, details: safeParse(r.details), timestamp: r.timestamp }));
      return res.json({ success: true, logs });
    }

    sql += ' ORDER BY l.id DESC LIMIT ?'; params.push(limit);
    const rows = dbi.prepare(sql).all(...params);
    const logs = rows.map(r => ({ id: r.id, userId: r.user_id, email: r.email, chatId: r.chat_id, action: r.action, details: safeParse(r.details), timestamp: r.timestamp }));
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function safeParse(jsonStr){ try { return jsonStr ? JSON.parse(jsonStr) : {}; } catch(_) { return {}; } }

// Temporary debug: list recent user message rows (remove in production)
app.get('/api/debug/messages', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ success:false, error:'db not init'});
    const rows = db.prepare('SELECT chat_id, role, content, timestamp FROM messages ORDER BY id DESC LIMIT 20').all();
    res.json({ success:true, rows });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// In-memory support ping store
const supportPings = [];

// Helper: create a support ping entry
function createSupportPing({ type = 'deposit_check', chatId, userId = 'anonymous', amount = null, language = 'id', message = '' }) {
  // chatId is required; userId is optional and will default to 'anonymous'
  if (!chatId) return;
  const ping = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    type,
    chatId,
    userId: userId || 'anonymous',
    amount,
    language,
    message,
    timestamp: Date.now(),
  read: false,
  resolved: false
  };
  supportPings.push(ping);
  return ping;
}

// Expose a local in-process support-ping creator so other modules running in
// the same Node.js process (like Chatbot) can create pings directly without
// performing an HTTP POST to /support-ping. This mirrors the behavior used
// for deposit-detection pings which are created server-side.
try {
  if (!global.__createSupportPing) global.__createSupportPing = createSupportPing;
} catch (_) {}

// Helper: detect support-worthy events from a free-text message
function detectSupportEvent(textRaw) {
  if (!textRaw) return null;
  const text = String(textRaw).toLowerCase();
  
  // Password reset
  if (/reset\s*password|password\s*reset|forgot\s*password|lupa\s*(password|sandi)/i.test(text)) {
    return { type: 'password_reset' };
  }
  // Deposit checking
  if (/(deposit|setor|top\s*up|topup|dp\b|isi\s*saldo)/i.test(text)) {
    return { type: 'deposit_check' };
  }
  // Account registration
  if (/register|registration|signup|sign\s*up|daftar\s*akun|buat\s*akun/i.test(text)) {
    return { type: 'account_registration' };
  }
  // Withdraw checking
  if (/withdraw|wd\b|tarik\s*tunai|penarikan|pencairan/i.test(text)) {
    // Try to capture an amount if present (e.g., 100, 100k, 1.5m, Rp 100.000)
    const amountMatch = text.match(/(rp\s*)?([0-9][0-9\.,]*)\s*(k|m|jt)?/i);
    return { type: 'withdraw_check', amount: amountMatch ? amountMatch[0] : null };
  }
  // Turnover inquiry
  if (/turn\s*over|turnover|omset|rollover/i.test(text)) {
    return { type: 'turnover' };
  }
  return null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'web-chat.html'));
});

// Simple route to the GoodCasino web chat UI
app.get('/web-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'web-chat.html'));
});

// Public promotions page
app.get('/promotions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'promotions.html'));
});

// LiveChat API helper: prefer Basic auth (username/password or base64 PAT), fallback to Bearer
const { getHeaderVariants } = require('./livechatAuth.js');
async function livechatPost(path, body, { timeout = 15000 } = {}) {
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    return { ok: false, error: 'LiveChat credentials not set', status: 401 };
  }
  let lastErr = null;
  for (const headers of headerVariants) {
    try {
      const { data } = await axios.post(
        `https://api.livechatinc.com/v3.5${path}`,
        body,
        { headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout }
      );
      return { ok: true, data };
    } catch (error) {
      lastErr = error;
      const status = error.response?.status;
      // Only try next variant on auth errors
      if (status === 401 || status === 403) {
        continue;
      }
      break;
    }
  }
  const msg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Unknown error';
  const code = lastErr?.response?.status || 500;
  return { ok: false, error: msg, status: code, raw: lastErr?.response?.data };
}

// Typing indicator helpers: use LiveChat server API to send typing state repeatedly
async function setTypingIndicator(chatId, isTyping, visibility = 'all') {
  if (!chatId) return { ok: false, error: 'no chatId' };
  try {
    // Best-effort: call the LiveChat typing endpoint
    const body = { chat_id: chatId, is_typing: !!isTyping, visibility };
    const resp = await livechatPost('/agent/action/send_typing_indicator', body, { timeout: 7000 });
    return resp;
  } catch (e) {
    // swallow errors to avoid surfacing transient typing failures
    return { ok: false, error: e?.message || e };
  }
}

function startTypingWhileBusy(chatId, visibility = 'all') {
  if (!chatId) {
    return async function stopNoop() { return; };
  }
  let stopped = false;
  // Immediately notify typing ON, then repeat every ~7s (server accepts periodic keepalive)
  const tick = async () => {
    if (stopped) return;
    try { await setTypingIndicator(chatId, true, visibility); } catch (_) {}
  };
  // Fire first tick without waiting
  tick().catch(() => {});
  const handle = setInterval(() => tick().catch(() => {}), 7000);
  // Return async stopper that clears interval and sends typing=false once
  return async function stopTyping() {
    if (stopped) return;
    stopped = true;
    try { clearInterval(handle); } catch (_) {}
    try { await setTypingIndicator(chatId, false, visibility); } catch (_) {}
  };
}

// Import promotions module
const { 
  getPromotions, 
  addPromotion, 
  updatePromotion, 
  deletePromotion,
  formatPromotions
} = require('./promotions.js');

// Promotions API endpoints
app.get('/api/promotions', async (req, res) => {
  try {
    const promotions = await getPromotions();
    if (!promotions || promotions.length === 0) {
      return res.json({ success: true, message: 'There are no active promotions at the moment.', promotions: [] });
    }
    res.json({ success: true, promotions });
  } catch (error) {
    console.error('Error getting promotions:', error);
    res.status(500).json({ success: false, error: 'Failed to get promotions' });
  }
});

app.post('/api/promotions', auth.authMiddleware(), async (req, res) => {
  try {
    // Permission: edit promotion
    if (!auth.hasPermission(req.user, 'edit_promotion') && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'No permission to edit promotions' });
    }
    const { 
      title, 
      description, 
      discount, 
      code,
      timeLimit,
      terms,
      howToClaim,
      eligibleItems,
      eligibleGames,
      endDate
    } = req.body;
    
    if (!title || !description || discount === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // Normalize eligible items/games
    let elig = eligibleItems || eligibleGames || [];
    if (typeof elig === 'string') {
      elig = elig.split(',').map(s => s.trim()).filter(Boolean);
    }
    
    // Normalize howToClaim to array or string
    let how = howToClaim;
    if (typeof how === 'string') {
      // Split by newlines if a textarea string was sent
      const arr = how.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      how = arr.length ? arr : how.trim();
    }

    const promotionData = { 
      title, 
      description, 
      discount: Number(discount), 
      code: code || null,
      timeLimit: timeLimit || null,
      terms: terms || null,
      howToClaim: how || null,
      endDate: endDate || null,
      // Store under both keys for compatibility with different consumers
      eligibleItems: Array.isArray(elig) ? elig : [],
      eligibleGames: Array.isArray(elig) ? elig : []
    };
    
  const newPromotion = await addPromotion(promotionData);
  // Log
  await auth.logAgentAction(req.user.id, 'promotion_add', { title }, null);
    res.status(201).json({ success: true, promotion: newPromotion });
  } catch (error) {
    console.error('Error adding promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to add promotion' });
  }
});

app.put('/api/promotions/:id', auth.authMiddleware(), async (req, res) => {
  try {
    if (!auth.hasPermission(req.user, 'edit_promotion') && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'No permission to edit promotions' });
    }
    const { id } = req.params;
    const updatesRaw = req.body || {};
    // Normalize howToClaim if provided as string
    const updates = { ...updatesRaw };
    if (typeof updates.howToClaim === 'string') {
      const arr = updates.howToClaim.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      updates.howToClaim = arr.length ? arr : updates.howToClaim.trim();
    }
    const updated = await updatePromotion(Number(id), updates);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
    await auth.logAgentAction(req.user.id, 'promotion_update', { id, updates }, null);
    res.json({ success: true, promotion: updated });
  } catch (error) {
    console.error('Error updating promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to update promotion' });
  }
});

app.delete('/api/promotions/:id', auth.authMiddleware(), async (req, res) => {
  try {
    if (!auth.hasPermission(req.user, 'edit_promotion') && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'No permission to delete promotions' });
    }
    const { id } = req.params;
    const success = await deletePromotion(Number(id));
    if (!success) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
    await auth.logAgentAction(req.user.id, 'promotion_delete', { id }, null);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to delete promotion' });
  }
});

// RTP link persistence and endpoints
const RTP_FILE = path.join(__dirname, 'rtp.json');
let rtpLink = process.env.RTP_LINK || 'https://example.com/rtp';

async function loadRtpLink() {
  try {
    const raw = await fs.readFile(RTP_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.rtpLink === 'string' && data.rtpLink.trim()) {
      rtpLink = data.rtpLink.trim();
    }
  } catch (_) {
    // ignore, use default/env
  }
}

async function saveRtpLink(newLink) {
  const data = { rtpLink: newLink };
  await fs.writeFile(RTP_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Load on startup
loadRtpLink().catch(() => {});

// RTP endpoints (JSON). Alias /api/trp provided for compatibility.
app.get('/api/rtp', (req, res) => {
  res.json({ success: true, rtpLink });
});
app.get('/api/trp', (req, res) => {
  res.json({ success: true, rtpLink, note: 'alias of /api/rtp' });
});
app.post('/api/rtp', (req, res) => {
  res.json({ success: true, rtpLink });
});
app.post('/api/trp', (req, res) => {
  res.json({ success: true, rtpLink, note: 'alias of /api/rtp' });
});
app.put('/api/rtp', async (req, res) => {
  try {
    const { rtpLink: incoming } = req.body || {};
    if (!incoming || typeof incoming !== 'string') {
      return res.status(400).json({ success: false, error: 'rtpLink (string) is required' });
    }
    const trimmed = incoming.trim();
    // Basic validation: must start with http(s)
    if (!/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ success: false, error: 'rtpLink must start with http:// or https://'});
    }
    rtpLink = trimmed;
    await saveRtpLink(rtpLink);
    res.json({ success: true, rtpLink });
  } catch (e) {
    console.error('Failed to update RTP link:', e.message);
    res.status(500).json({ success: false, error: 'Failed to update RTP link' });
  }
});

// In-memory settings for templates and brand name (persisted to settings.json)
let settings = {
  brandName: 'Cekipos Payment Assistant',
  welcomeMessage: 'Hello! I\'m here to help you with your Cekipos payment, bro. Can you share your CID?',
  waitMessage: 'Alright boss, please wait while we check this for you Ã°Å¸ËœÅ ',
  endMessage: 'Thank you boss, we wish you good luck! Ã°Å¸ËœËœ'
};
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
async function loadSettingsFromFile() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      settings = { ...settings, ...data };
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      try { await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (_) {}
    }
  }
}
async function saveSettingsToFile() {
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to persist settings.json:', e?.message || e);
  }
}
loadSettingsFromFile().catch(() => {});

// (Note) LiveChat send is handled via helper in livechatApi.js

// Removed: /send-message endpoint that relied on smart-payment-ai. Payment-AI functionality
// has been removed from this server build.

// New endpoint to get chat state information
app.get('/chat-state/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
  const dbi = await getDb();
  const chatState = await getChatState(dbi, chatId);
    
    if (!chatState) {
      return res.status(404).json({ success: false, error: 'Chat not found' });
    }
    
    // Get chat messages
  const messages = await getChatMessages(dbi, chatId);
    
    // Parse the chat state from JSON string if needed
    const parsedState = typeof chatState.state === 'string' ? JSON.parse(chatState.state) : chatState.state;
    
    res.json({
      success: true,
      chatState: {
        payment_state: parsedState.payment_state,
        context: parsedState.context,
        offTopicWarningCount: parsedState.offTopicWarningCount,
        validation: parsedState.validation,
        messages
      }
    });
  } catch (error) {
    console.error('Error getting chat state:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Removed: /test-smart-ai endpoint

// Get all promotions (legacy routes kept for UI compatibility)
app.get('/promotions', async (req, res) => {
  try {
    const promos = await getPromotions();
    res.json({ success: true, promotions: promos });
  } catch (error) {
    console.error('Error getting promotions:', error);
    res.status(500).json({ success: false, error: 'Failed to get promotions' });
  }
});

// Add a promotion (legacy)
app.post('/promotions', async (req, res) => {
  try {
  const { title, description, discount, code, timeLimit, terms, howToClaim, eligibleItems, eligibleGames, endDate } = req.body;
    if (!title || !description || discount == null) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    // Normalize eligible items/games
    let elig = eligibleItems || eligibleGames || [];
    if (typeof elig === 'string') {
      elig = elig.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Normalize howToClaim
    let how = howToClaim;
    if (typeof how === 'string') {
      const arr = how.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      how = arr.length ? arr : how.trim();
    }
    const newPromo = await addPromotion({
      title,
      description,
      discount: Number(discount),
      code: code || null,
      timeLimit: timeLimit || null,
      terms: terms || null,
      howToClaim: how || null,
      endDate: endDate || null,
      eligibleItems: Array.isArray(elig) ? elig : [],
      eligibleGames: Array.isArray(elig) ? elig : []
    });
    res.json({ success: true, promotion: newPromo });
  } catch (error) {
    console.error('Error adding promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to add promotion' });
  }
});

// Delete a promotion (legacy)
app.delete('/promotions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const success = await deletePromotion(id);
    if (!success) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to delete promotion' });
  }
});

// Settings endpoints
app.get('/api/settings', auth.authMiddleware(), async (req, res) => {
  // Permission: Only owner and master can view settings
  if (req.user.role !== 'owner' && req.user.role !== 'master') {
    return res.status(403).json({ success: false, error: 'No permission to view settings' });
  }

  try {
    // Optional: when a groupId is provided, prefer group-specific values for
    // brandName, welcome/wait/end messages, deposit/withdrawal limits and rtpLink.
    const groupId = req.query.groupId ? Number(req.query.groupId) : null;
    if (!groupId) {
      return res.json({ success: true, settings });
    }

    // Fetch group config and merge
    let cfg = null;
    try {
      cfg = await getGroupConfig(groupId);
    } catch (e) {
      // non-fatal: return global settings if group fetch fails
      console.warn('Failed to load group config for settings merge:', e?.message || e);
      return res.json({ success: true, settings });
    }

    const merged = Object.assign({}, settings || {});

    // Brand/Site name
    if (cfg && cfg.brandName) merged.brandName = cfg.brandName;

    // RTP link: prefer group rtpLink if set
    if (cfg && cfg.rtpLink) merged.rtpLink = cfg.rtpLink;

    // Custom messages: group.aiSettings.customMessages overrides global messages
    try {
      const ai = cfg && cfg.aiSettings ? cfg.aiSettings : {};
      const cm = ai && ai.customMessages ? ai.customMessages : {};
      if (cm.welcomeMessage) merged.welcomeMessage = cm.welcomeMessage;
      if (cm.waitMessage) merged.waitMessage = cm.waitMessage;
      if (cm.endMessage) merged.endMessage = cm.endMessage;
      // Allow group-level limits under aiSettings.limits (optional)
      if (ai && ai.limits && typeof ai.limits === 'object') {
        merged.minDeposit = ai.limits.minDeposit ?? merged.minDeposit ?? null;
        merged.maxDeposit = ai.limits.maxDeposit ?? merged.maxDeposit ?? null;
        merged.minWithdrawal = ai.limits.minWithdrawal ?? merged.minWithdrawal ?? null;
        merged.maxWithdrawal = ai.limits.maxWithdrawal ?? merged.maxWithdrawal ?? null;
      }
    } catch (_) {}

    return res.json({ success: true, settings: merged, groupConfig: cfg });
  } catch (e) {
    console.error('Failed to get settings:', e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || 'Failed to get settings' });
  }
});

// --- GoodCasino Bot (Chatbot) local chat endpoint ---
app.get('/api/bot/health', (req, res) => {
  res.json({ status: 'ok' });
});
// Preflight for CORS
app.options('/api/bot/chat', (req, res) => res.sendStatus(204));
// Simple GET support for convenience/testing
app.get('/api/bot/chat', async (req, res) => {
  try {
    const requiredSecret = process.env.BOT_SECRET || '';
    if (requiredSecret) {
      const provided = req.headers['x-bot-secret'];
      if (!provided || provided !== requiredSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    }
    const id = (req.query.chatId && String(req.query.chatId).trim()) || `web_${Date.now()}`;
    const message = (req.query.message && String(req.query.message)) || '';
    if (!message) return res.status(400).json({ success: false, error: 'message is required' });
  // Persist user message and record audit that auto replies are disabled
  try { await updateChatActivity(id, 'web'); const dbi = await getDb(); await addMessage(dbi, id, 'user', message); await addMessage(dbi, id, 'system', 'GET /api/bot/chat invoked but automatic replies are disabled.'); } catch (_) {}
  return res.json({ success: true, chatId: id, reply: '' });
  } catch (e) {
    console.error('Error in GET /api/bot/chat:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});
app.post('/api/bot/chat', async (req, res) => {
  try {
    const requiredSecret = process.env.BOT_SECRET || '';
    if (requiredSecret) {
      const provided = req.headers['x-bot-secret'];
      if (!provided || provided !== requiredSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    }
    const { chatId, message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message is required' });
    }
  const id = chatId && String(chatId).trim() ? String(chatId).trim() : `web_${Date.now()}`;
  // Persist user message and record audit that auto replies are disabled
    try {
      await updateChatActivity(id, 'web');
      const dbi = await getDb();
      await addMessage(dbi, id, 'user', message);
      // Generate a bot reply using the Chatbot module (if available)
      let reply = '';
      try {
        const aiStartLocal = Date.now();
        const stopTyping = startTypingWhileBusy(id);
        let maybeReply = null;
        try {
          maybeReply = await gcGetResponse(id, message, `${id}_${Date.now()}`);
        } finally {
          try { await stopTyping(); } catch (_) {}
        }
        const aiElapsedLocal = Date.now() - aiStartLocal;
        console.log(`\u23f1 /api/bot/chat AI generation took ${aiElapsedLocal}ms for chat ${id}`);
        reply = maybeReply || '';
      } catch (err) {
        console.error('gcGetResponse error for /api/bot/chat:', err && err.message ? err.message : err);
        reply = '';
      }
      // Extract text from structured reply objects
      if (typeof reply === 'object' && reply !== null) {
        if (typeof reply.reply === 'string') {
          reply = reply.reply.trim();
        } else {
          reply = String(reply).trim();
        }
      }
      // Persist agent reply to DB for audit/history
      if (reply) {
        try { await addMessage(dbi, id, 'agent', reply); } catch (_) {}
      }
      // Also persist a system audit record
      try { await addMessage(dbi, id, 'system', '/api/bot/chat invoked and processed by bot.'); } catch (_) {}
      return res.json({ success: true, chatId: id, reply });
    } catch (e) {
      console.error('Error in /api/bot/chat:', e && e.message ? e.message : e);
      return res.status(500).json({ success: false, error: e.message });
    }
  } catch (e) {
    console.error('Error in /api/bot/chat:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// --- LiveChat debug/admin endpoints (guarded by optional BOT_SECRET) ---
function requireBotSecret(req, res) {
  // Allow authenticated JWT users (owner/master/agent) to access without BOT_SECRET
  try {
    const hdr = req.headers['authorization'] || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (token) {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
      if (payload && payload.sub) {
        return true;
      }
    }
  } catch (_) {
    // fall through to BOT_SECRET check
  }
  const required = process.env.BOT_SECRET || '';
  if (!required) return true;
  const provided = req.headers['x-bot-secret'];
  if (!provided || provided !== required) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Simple cache for chat list (5 second TTL to reduce API load)
let chatListCache = { data: null, timestamp: 0, ttl: 5000 };

// List chats with optional ?status=active,queued,pending (defaults to active,queued,pending)
app.get('/api/livechat/chats', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const statuses = (req.query.status || 'active,queued,pending')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const includeUnmapped = String(req.query.includeUnmapped || '').toLowerCase() === 'true';
  const requestedGroupId = req.query.groupId ? Number(req.query.groupId) : null;
  const body = { filters: { status: statuses }, limit: 50 };
  
  // Use cache if available and fresh (reduces LiveChat API load)
  const now = Date.now();
  let resp;
  if (chatListCache.data && (now - chatListCache.timestamp) < chatListCache.ttl) {
    console.log('Ã°Å¸â€œÂ¦ Using cached chat list');
    resp = chatListCache.data;
  } else {
    resp = await livechatPost('/agent/action/list_chats', body, {});
    if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
    // Cache the response
    chatListCache = { data: resp, timestamp: now, ttl: 5000 };
  }
  
  let chats = resp.data?.chats_summary || resp.data?.chats || resp.data?.data?.chats || resp.data?.results || resp.data;
  // Build mapping for all chats once
  const idsAll = Array.isArray(chats) ? chats.map(c => c.id || c.chat?.id).filter(Boolean) : [];
  const { getChatGroupMap } = require('./db-utils.js');
  let chatGroupMap = {};
  try { chatGroupMap = await getChatGroupMap(idsAll); } catch(_) { chatGroupMap = {}; }
  // Optional: filter by agent groups if JWT is supplied (agents only)
  try {
    const hdr = req.headers['authorization'] || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (token) {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
      const user = await auth.findUserById(payload.sub);
      if (user && (user.role === 'agent' || user.role === 'master')) {
        const groups = user.role === 'agent' ? await auth.getAgentGroups(user.id) : await auth.getMasterGroups(user.id);
        const allowedGroupIds = new Set(groups.map(g => g.id));
        // If a specific groupId is requested, further restrict to that group
        if (requestedGroupId) {
          if (!allowedGroupIds.has(requestedGroupId) && user.role !== 'owner') {
            // deny if not allowed
            return res.status(403).json({ success: false, error: 'Forbidden (group not assigned)' });
          }
        }
        // Filter by allowed groups and group selection; exclude unmapped by default
        chats = (Array.isArray(chats) ? chats : []).filter(c => {
          const id = c.id || c.chat?.id;
          const gid = chatGroupMap[id];
          if (requestedGroupId && Number(gid) !== requestedGroupId) return false;
          if (!gid && !includeUnmapped) return false;
          return allowedGroupIds.has(Number(gid));
        });
      }
    }
  } catch (_) {}
  // For owner/anonymous callers: apply generic filter Ã¢â‚¬â€ exclude unmapped unless explicitly included; honor groupId
  if (!Array.isArray(chats)) chats = [];
  chats = chats.filter(c => {
    const id = c.id || c.chat?.id;
    const gid = chatGroupMap[id];
    if (requestedGroupId) return Number(gid) === requestedGroupId;
    return includeUnmapped ? true : !!gid;
  });
  res.json({ success: true, count: Array.isArray(chats) ? chats.length : 0, chats });
});

// Group-scoped RTP endpoints
app.get('/api/groups/:id/rtp', auth.authMiddleware(), async (req, res) => {
  try {
    const gid = Number(req.params.id);
    // Scope check for master/agent
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const ids = new Set((allowed||[]).map(g=>g.id)); if (!ids.has(gid)) return res.status(403).json({ success:false, error:'Forbidden' });
    } else if (req.user.role === 'agent') {
      const allowed = await auth.getAgentGroups(req.user.id);
      const ids = new Set((allowed||[]).map(g=>g.id)); if (!ids.has(gid)) return res.status(403).json({ success:false, error:'Forbidden' });
    }
    const cfg = await getGroupConfig(gid);
    res.json({ success:true, rtpLink: cfg?.rtpLink || null });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/groups/:id/rtp', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success:false, error:'Forbidden' });
    }
    const gid = Number(req.params.id);
    const { rtpLink: link } = req.body || {};
    if (!link || typeof link !== 'string' || !/^https?:\/\//i.test(link.trim())) {
      return res.status(400).json({ success:false, error:'Valid rtpLink (http/https) required' });
    }
    // Masters can only update their groups
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const ids = new Set((allowed||[]).map(g=>g.id)); if (!ids.has(gid)) return res.status(403).json({ success:false, error:'Forbidden' });
    }
    const existing = await getGroupConfig(gid) || { brandName: 'GoodCasino', aiSettings: {} };
    const cfg = await upsertGroupConfig(gid, { brandName: existing.brandName, aiSettings: existing.aiSettings || {}, rtpLink: link.trim() });
    res.json({ success:true, rtpLink: cfg.rtpLink });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// Get single chat status
app.get('/api/livechat/chat/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const { chatId } = req.params;
  const resp = await livechatPost('/agent/action/get_chat', { chat_id: chatId }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  res.json({ success: true, chat: resp.data?.chat || resp.data?.data?.chat || resp.data });
});

// Accept a queued/pending chat
app.post('/api/livechat/accept/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const { chatId } = req.params;
  const resp = await livechatPost('/agent/action/accept_chat', { chat_id: chatId }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  res.json({ success: true, result: resp.data });
});

// Join a chat as participant
app.post('/api/livechat/join/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const { chatId } = req.params;
  const resp = await livechatPost('/agent/action/join_chat', { chat_id: chatId }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  res.json({ success: true, result: resp.data });
});

// Send a message to a chat
app.post('/api/livechat/send/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const { chatId } = req.params;
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'text is required' });
  }
  // Safety: allow disabling agent/manual sends via environment variable.
  // Default: disabled (true) to prevent accidental agent messages while testing webhook-only flows.
  const disableAgentSends = String(process.env.DISABLE_AGENT_SENDS || 'true').toLowerCase() === 'true';
  if (disableAgentSends) {
    console.log('Ã¢â€ºâ€ Agent/manual sends blocked by DISABLE_AGENT_SENDS=true (request ignored)', { chatId, textPreview: String(text || '').slice(0,80) });
    return res.status(403).json({ success: false, error: 'Agent/manual sends are disabled by server configuration' });
  }

  // CHANGED: Allow human messages even when Global Auto AI is enabled
  // This enables collaborative mode where both AI and agents can respond together
  // Removed the blocking check to allow agents to work alongside AI

  const resp = await livechatPost('/agent/action/send_event', {
    chat_id: chatId,
    event: { type: 'message', text, recipients: 'all' }
  }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  // Persist and log the outgoing message for visibility
  try { await updateChatActivity(chatId, 'agent'); const dbi = await getDb(); await addMessage(dbi, chatId, 'assistant', text); } catch (_) {}
  console.log(`Agent reply sent to ${chatId}: ${text}`);
  // If an authenticated agent sent this, log
  try { if (req.headers.authorization) {
    const mid = await (async () => { try { const tok = req.headers.authorization.split(' ')[1]; const jwt = require('jsonwebtoken'); const payload = jwt.verify(tok, process.env.JWT_SECRET || 'dev_secret_change_me'); return payload.sub; } catch (_) { return null; } })();
    if (mid) await auth.logAgentAction(mid, 'chat_reply', { text }, chatId);
  } } catch (_) {}
  res.json({ success: true, result: resp.data });
});

// Get chat threads/events
app.get('/api/livechat/threads/:chatId', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const { chatId } = req.params;
  const resp = await livechatPost('/agent/action/list_threads', { chat_id: chatId }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  res.json({ success: true, threads: resp.data?.threads || resp.data?.data?.threads || [] });
});

// --- SSE LiveChat Integration ---
// SSE endpoint for AI to connect to LiveChat events (alternative to webhooks)
app.get('/api/livechat/sse', (req, res) => {
  if (global.__sseDisabled) {
    return res.status(503).json({ error: 'SSE has been disabled by the owner' });
  }
  if (!liveChatSSE) {
    return res.status(404).json({ error: 'SSE not enabled. Set ENABLE_LIVECHAT_SSE=true' });
  }

  console.log('Ã°Å¸â€Å’ SSE: New LiveChat AI connection');
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Add to SSE clients in manager
  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res, lastPing: Date.now() };
  
  if (liveChatSSE.sseClients) {
    liveChatSSE.sseClients.add(client);
  }
  
  // Send connection confirmation
  const sseData = `event: connected\ndata: ${JSON.stringify({
    message: 'Connected to LiveChat SSE',
    clientId,
    timestamp: new Date().toISOString()
  })}\n\n`;
  res.write(sseData);

  // Handle disconnect
  req.on('close', () => {
    if (liveChatSSE.sseClients) {
      liveChatSSE.sseClients.delete(client);
    }
    console.log(`Ã°Å¸â€Å’ SSE: LiveChat AI disconnected (${clientId})`);
  });
});

// SSE status endpoint
app.get('/api/livechat/sse/status', (req, res) => {
  if (!liveChatSSE) {
    return res.json({
      success: true,
      sseEnabled: false,
      message: 'SSE not enabled. Set ENABLE_LIVECHAT_SSE=true'
    });
  }

  res.json({
    success: true,
    sseEnabled: true,
    connections: liveChatSSE.sseClients?.size || 0,
    activeChats: liveChatSSE.activeChatPolling?.size || 0,
    chats: Array.from(liveChatSSE.activeChatPolling?.keys() || [])
  });
});

// Helper: close all active SSE client connections (non-blocking)
function closeAllSseClients() {
  try {
    if (!liveChatSSE || !liveChatSSE.sseClients) return 0;
    const clients = Array.from(liveChatSSE.sseClients);
    for (const client of clients) {
      try {
        // Attempt to politely close the connection
        try { client.res.write('event: server_shutdown\ndata: {"message":"SSE disabled by owner"}\n\n'); } catch (_) {}
        try { client.res.end(); } catch (_) {}
      } catch (err) {
        // ignore per-client errors
      }
      liveChatSSE.sseClients.delete(client);
    }
    return clients.length;
  } catch (err) {
    console.warn('Error while closing SSE clients:', err?.message || err);
    return 0;
  }
}

// Owner-only admin endpoints to disable/enable SSE
app.post('/api/admin/sse/disable', auth.authMiddleware('owner'), async (req, res) => {
  try {
    if (global.__sseDisabled) return res.json({ success: true, message: 'SSE already disabled' });
    global.__sseDisabled = true;
    const closed = closeAllSseClients();
    console.log(`Ã°Å¸â€ºâ€˜ Owner disabled SSE. Closed ${closed} active connections.`);
    return res.json({ success: true, message: 'SSE disabled', closed });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/sse/enable', auth.authMiddleware('owner'), async (req, res) => {
  try {
    if (!global.__sseDisabled) return res.json({ success: true, message: 'SSE already enabled' });
    global.__sseDisabled = false;
    console.log('Ã¢Å“â€¦ Owner enabled SSE');
    return res.json({ success: true, message: 'SSE enabled' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/sse/status', auth.authMiddleware('owner'), async (req, res) => {
  try {
    return res.json({ success: true, disabled: !!global.__sseDisabled, sseManagerPresent: !!liveChatSSE, connections: liveChatSSE?.sseClients?.size || 0 });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// --- Chat -> Group mapping endpoints ---
// Set mapping (owner or master)
app.put('/api/chat-groups', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const { chatId, groupId } = req.body || {};
    if (!chatId || !groupId) {
      return res.status(400).json({ success: false, error: 'chatId and groupId are required' });
    }
    const db = await getDb();
    const g = db.prepare('SELECT id FROM groups WHERE id = ?').get(Number(groupId));
    if (!g) return res.status(404).json({ success: false, error: 'Group not found' });
    if (req.user.role === 'master') {
      const allowed = await auth.getMasterGroups(req.user.id);
      const ids = new Set((allowed || []).map(gr => gr.id));
      if (!ids.has(Number(groupId))) return res.status(403).json({ success: false, error: 'Forbidden (group not assigned to this master)' });
    }
    const { setChatGroup } = require('./db-utils.js');
    await setChatGroup(String(chatId), Number(groupId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get mapping for specific chat ids (comma-separated query ?ids=a,b,c)
app.get('/api/chat-groups', auth.authMiddleware(), async (req, res) => {
  try {
    const idsParam = String(req.query.ids || '').trim();
    const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : [];
    const { getChatGroupMap } = require('./db-utils.js');
    let map = await getChatGroupMap(ids);
    // Scope: agents see only their groups; masters see only their groups as well
    if (req.user.role === 'agent' || req.user.role === 'master') {
      const allowed = req.user.role === 'agent' ? await auth.getAgentGroups(req.user.id) : await auth.getMasterGroups(req.user.id);
      const allowedIds = new Set((allowed || []).map(g => g.id));
      map = Object.fromEntries(Object.entries(map).filter(([cid, gid]) => allowedIds.has(Number(gid))));
    }
    res.json({ success: true, map });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Owner: bulk reset passwords to a temporary value (dangerous). Requires confirm=true.
app.post('/api/owner/reset-all-passwords', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const { tempPassword, confirm } = req.body || {};
    if (!confirm) return res.status(400).json({ success: false, error: 'confirm=true required' });
    if (!tempPassword || String(tempPassword).length < 8) return res.status(400).json({ success: false, error: 'tempPassword min 8 chars required' });
    const db = await getDb();
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(String(tempPassword), 10);
    const info = db.prepare("UPDATE users SET password_hash = ? WHERE role IN ('agent','master')").run(hash);
    res.json({ success: true, updated: info.changes });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/settings', auth.authMiddleware(), async (req, res) => {
  try {
    // Permission: Only owner and master can edit settings
    if (req.user.role !== 'owner' && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'No permission to edit settings' });
    }

    const { 
      brandName, 
      welcomeMessage, 
      minDeposit,
      maxDeposit,
      minWithdrawal,
      maxWithdrawal,
      groupId,
      rtpLink: incomingRtpLink
    } = req.body || {};

    if (!brandName || !welcomeMessage) {
      return res.status(400).json({ success: false, error: 'Basic fields (brandName, welcomeMessage) are required' });
    }

    // If groupId provided, persist group-specific overrides to groups_config
    if (groupId) {
      try {
        const gid = Number(groupId);
        const existing = await getGroupConfig(gid) || { brandName: 'GoodCasino', aiSettings: {} };
        const newAi = Object.assign({}, existing.aiSettings || {});
        newAi.customMessages = Object.assign({}, newAi.customMessages || {}, {
          welcomeMessage: welcomeMessage || null
        });
        // Allow persisting limits per-group under aiSettings.limits
        newAi.limits = Object.assign({}, newAi.limits || {}, {
          minDeposit: minDeposit ? parseInt(minDeposit) : (newAi.limits ? newAi.limits.minDeposit : null),
          maxDeposit: maxDeposit ? parseInt(maxDeposit) : (newAi.limits ? newAi.limits.maxDeposit : null),
          minWithdrawal: minWithdrawal ? parseInt(minWithdrawal) : (newAi.limits ? newAi.limits.minWithdrawal : null),
          maxWithdrawal: maxWithdrawal ? parseInt(maxWithdrawal) : (newAi.limits ? newAi.limits.maxWithdrawal : null)
        });

        const cfg = await upsertGroupConfig(gid, {
          brandName: brandName || existing.brandName || 'GoodCasino',
          aiSettings: newAi,
          rtpLink: (incomingRtpLink && String(incomingRtpLink).trim()) ? String(incomingRtpLink).trim() : (existing.rtpLink || null)
        });
        // Clear in-process caches so running AI uses new group settings immediately
        try {
        if (Chatbot && typeof Chatbot.clearGroupCaches === 'function') {
          Chatbot.clearGroupCaches(gid);
          }
        } catch (_) {}
        return res.json({ success: true, settings: null, groupConfig: cfg });
      } catch (ge) {
        console.warn('Failed to persist group settings:', ge?.message || ge);
        return res.status(500).json({ success: false, error: 'Failed to persist group settings' });
      }
    }
    // Global settings are deprecated: require groupId so settings are stored per-group.
    return res.status(400).json({ success: false, error: 'Settings must be saved per-group. Please provide groupId and save under group aiSettings.' });
  } catch (e) {
    console.error('Failed to save settings:', e?.message || e);
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});

// --- Support Ping Endpoints ---
// Create a new support ping (e.g., when a user says they've deposited)
app.post('/support-ping', (req, res) => {
  try {
    const { type = 'deposit_check', chatId, userId = 'anonymous', amount = null, language = 'id', message } = req.body || {};
    try { console.debug && console.debug('[DEBUG] /support-ping received from', req.ip || req.headers['x-forwarded-for'] || 'local', 'body=', req.body); } catch(_) {}
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId is required' });
    }
    // For certain types, amount is recommended but not strictly required
    const ping = createSupportPing({ type, chatId, userId, amount, language, message: message || '' });
    return res.json({ success: true, ping });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Get unread support pings; optional query markRead=true to mark them as read
app.get('/support-pings', (req, res) => {
  try {
    const { markRead, scope, all } = req.query;
    // Default behavior kept for backward compatibility: only unread
    let list;
    if ((scope && String(scope).toLowerCase() === 'unresolved') || (all && String(all).toLowerCase() === 'true')) {
      // Include any ping that hasn't been resolved yet (read or unread)
      list = supportPings.filter(p => !p.resolved).sort((a, b) => a.timestamp - b.timestamp);
    } else {
      // Unread only
      list = supportPings.filter(p => !p.read).sort((a, b) => a.timestamp - b.timestamp);
    }
    if (markRead === 'true') {
      list.forEach(p => { p.read = true; });
    }
    return res.json({ success: true, pings: list });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// --- Support Quick Replies ---
// Predefined quick replies by support type
const SUPPORT_QUICK_REPLIES = {
  deposit_check: [
    { key: 'deposit_processed', label: 'Deposit processed', reply: 'Deposit sudah kami proses, silakan cek saldo Anda ya bosku.' },
    { key: 'deposit_not_received', label: 'Deposit not received yet', reply: 'Maaf bosku, deposit belum kami terima. Mohon tunggu beberapa menit atau kirim bukti transfer.' }
  ],
  withdraw_check: [
    { key: 'withdraw_processed', label: 'Withdraw processed', reply: 'Penarikan sudah diproses. Silakan cek rekening Anda dalam beberapa menit.' },
    { key: 'withdraw_pending', label: 'Withdraw pending', reply: 'Penarikan masih dalam antrian. Mohon ditunggu ya bosku.' }
  ],
  password_reset: [
    { key: 'password_reset_steps', label: 'Send reset steps', reply: 'Untuk reset password, silakan gunakan fitur Ã¢â‚¬Å“Lupa PasswordÃ¢â‚¬Â di aplikasi atau hubungi kami dengan data verifikasi.' }
  ],
  turnover: [
    { key: 'turnover_info', label: 'Explain turnover', reply: 'Turnover adalah total nilai taruhan. Kami bisa cekkan untuk Anda jika berikan ID akun.' }
  ]
};

// Get quick replies for a type
app.get('/support-quick-replies', auth.authMiddleware(), (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const items = type ? (SUPPORT_QUICK_REPLIES[type] || []) : SUPPORT_QUICK_REPLIES;
    res.json({ success: true, replies: items, type: type || null });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send a quick reply to a chat (agent/master/owner)
app.post('/support-quick-replies/send', auth.authMiddleware(), async (req, res) => {
  try {
    const { chatId, type, key } = req.body || {};
    if (!chatId || !type || !key) return res.status(400).json({ success: false, error: 'chatId, type, key required' });
    const items = SUPPORT_QUICK_REPLIES[type] || [];
    const item = items.find(r => r.key === key);
    if (!item) return res.status(404).json({ success: false, error: 'Quick reply not found' });
    const groupMapping = await getChatGroup(String(chatId));
    const internalGroupId = groupMapping ? (Number(groupMapping.group_id ?? groupMapping.groupId ?? groupMapping) || null) : null;
    const lcGroupId = internalGroupId ? await getGroupLivechatGroupId(internalGroupId) : null;
      try {
        // Respect STRICT_WEBHOOK_ONLY: if enabled, do not send Quick Replies
        const strictWebhookOnly = String(process.env.STRICT_WEBHOOK_ONLY || '').toLowerCase() === 'true';
        if (strictWebhookOnly) {
          try { const dbi = await getDb(); await addMessage(dbi, String(chatId), 'assistant', `[SUPPRESSED - STRICT_WEBHOOK_ONLY] ${item.reply}`); await addMessage(dbi, String(chatId), 'system', 'Quick reply suppressed due to STRICT_WEBHOOK_ONLY.'); } catch (_) {}
        } else {
          // Auto-rewrite removed: send the raw quick-reply text directly and
          // persist an audit entry noting automated rewrite is disabled.
          await sendReply(
            {
              chat_id: String(chatId),
              chat: { id: String(chatId), group_id: lcGroupId }
            },
            item.reply,
            {
              internalGroupId,
              groupId: lcGroupId
            }
          );
          try { const dbi = await getDb(); await addMessage(dbi, String(chatId), 'assistant', item.reply); await addMessage(dbi, String(chatId), 'system', 'Quick reply sent; automated rewrite disabled.'); } catch (_) {}
        }
      } catch (sendErr) {
        return res.status(502).json({ success: false, error: 'Failed to send via LiveChat', details: sendErr?.response?.data || sendErr.message });
      }
    try { await auth.logAgentAction(req.user.id, 'support_quick_reply', { type, key }, String(chatId)); } catch (_) {}
    // Optionally mark related ping as read/resolved client-side
    res.json({ success: true, sent: true, chatId, reply: item.reply });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Mark a support ping as resolved with a selected action (optional helper)
app.post('/support-pings/:id/resolve', auth.authMiddleware(), (req, res) => {
  try {
    const id = String(req.params.id);
    const { resolution = null } = req.body || {};
    const p = supportPings.find(x => x.id === id);
    if (!p) return res.status(404).json({ success: false, error: 'Ping not found' });
    p.read = true;
    p.resolved = true;
    p.resolution = resolution;
    res.json({ success: true, ping: p });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get LiveChat metadata for a specific chat
app.get('/api/chat/:chatId/livechat-metadata', auth.authMiddleware(), async (req, res) => {
  try {
    const { chatId } = req.params;
    const { getChatLivechatMetadata } = require('./db-utils.js');
    const metadata = await getChatLivechatMetadata(chatId);
    
    if (!metadata) {
      return res.json({ 
        success: true, 
        metadata: null,
        message: 'No LiveChat metadata found (chat may have come in before metadata tracking was enabled)'
      });
    }
    
    res.json({ success: true, metadata });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get AI capabilities
app.get('/ai-capabilities', (req, res) => {
  res.json({
    success: true,
    capabilities: {
      paymentProcessing: false,
      cidExtraction: false,
      planTypeDetection: false,
      currencyConversion: false,
      offTopicDetection: true,
      bilingualSupport: true,
      stateMachine: false,
      smartResponseGeneration: true,
      paymentStates: [],
      supportedLanguages: ['en', 'id'],
      supportedCurrencies: ['USDT', 'IDR'],
      supportedPlans: ['EXTEND', 'UPGRADE', 'DOWNGRADE']
    }
  });
});

// Debug endpoint: Show chat-to-group mappings
app.get('/api/debug/chat-mapping', auth.authMiddleware('owner'), async (req, res) => {
  try {
    const db = await getDb();
    
    // Get all mapped chats with group details
    const mappedChats = db.prepare(`
      SELECT 
        cg.chat_id,
        cg.group_id,
        g.name as group_name,
        gc.livechat_group_id,
        gc.brand_name,
        gc.livechat_license
      FROM chat_groups cg
      LEFT JOIN groups g ON g.id = cg.group_id
      LEFT JOIN groups_config gc ON gc.group_id = cg.group_id
      ORDER BY cg.chat_id DESC
      LIMIT 100
    `).all();
    
    // Get all group configurations
    const groupConfigs = db.prepare(`
      SELECT 
        g.id,
        g.name,
        gc.brand_name,
        gc.livechat_group_id,
        gc.livechat_license,
        gc.livechat_client_id
      FROM groups g
      LEFT JOIN groups_config gc ON gc.group_id = g.id
      ORDER BY g.id
    `).all();
    
    // Count chats per group
    const chatCounts = db.prepare(`
      SELECT group_id, COUNT(*) as count
      FROM chat_groups
      GROUP BY group_id
    `).all();
    
    const countMap = {};
    chatCounts.forEach(c => {
      countMap[c.group_id] = c.count;
    });
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        totalMappedChats: mappedChats.length,
        totalGroups: groupConfigs.length,
        groupsWithChats: chatCounts.length
      },
      mappedChats: mappedChats.map(c => ({
        chatId: c.chat_id,
        internalGroupId: c.group_id,
        groupName: c.group_name || 'Unknown',
        brandName: c.brand_name || 'N/A',
        livechatGroupId: c.livechat_group_id || 'NOT CONFIGURED',
        livechatLicense: c.livechat_license || 'N/A'
      })),
      groupConfigs: groupConfigs.map(g => ({
        id: g.id,
        name: g.name,
        brandName: g.brand_name || 'N/A',
        livechatGroupId: g.livechat_group_id || 'NOT SET - Chats will NOT be mapped!',
        livechatLicense: g.livechat_license || 'Not configured',
        livechatClientId: g.livechat_client_id || 'Not configured',
        mappedChatsCount: countMap[g.id] || 0,
        status: g.livechat_group_id ? 'Ready' : 'Missing LiveChat Group ID'
      }))
    });
  } catch (e) {
    console.error('Error in /api/debug/chat-mapping:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Real-time performance monitoring endpoint
app.get('/api/performance/metrics', auth.authMiddleware(), (req, res) => {
  try {
    const metrics = global.__performanceMetrics || [];
    const recentMetrics = metrics.slice(-50); // Last 50 responses
    
    // Calculate performance statistics
    const stats = {
      totalResponses: metrics.length,
      recentResponses: recentMetrics.length,
      averageResponseTime: recentMetrics.length > 0 ? 
        Math.round(recentMetrics.reduce((sum, m) => sum + m.totalTime, 0) / recentMetrics.length) : 0,
      averageAiTime: recentMetrics.length > 0 ? 
        Math.round(recentMetrics.reduce((sum, m) => sum + m.aiTime, 0) / recentMetrics.length) : 0,
      fastResponses: recentMetrics.filter(m => m.totalTime < 1000).length,
      slowResponses: recentMetrics.filter(m => m.totalTime > 5000).length,
      aiSuccessRate: recentMetrics.length > 0 ? 
        Math.round((recentMetrics.filter(m => m.hasAiResponse).length / recentMetrics.length) * 100) : 0,
      fallbackRate: recentMetrics.length > 0 ? 
        Math.round((recentMetrics.filter(m => m.fallbackUsed).length / recentMetrics.length) * 100) : 0
    };
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      statistics: stats,
      recentMetrics: recentMetrics,
      serverUptime: Math.round(process.uptime())
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Reset performance metrics (for testing)
app.post('/api/performance/reset', auth.authMiddleware(), (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'Only owners can reset metrics' });
    }
    global.__performanceMetrics = [];
    res.json({ success: true, message: 'Performance metrics reset' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Agent Chat Manager status and control endpoints
app.get('/api/agent-chat/status', auth.authMiddleware(), (req, res) => {
  try {
    try {
      const status = (typeof agentChatManager !== 'undefined' && agentChatManager && typeof agentChatManager.getStatus === 'function') ? agentChatManager.getStatus() : { enabled: false, mode: 'removed' };
      res.json({
        success: true,
        agentChatManager: status,
        timestamp: new Date().toISOString()
      });
    } catch (inner) {
      res.json({ success: true, agentChatManager: { enabled: false, mode: 'error' }, timestamp: new Date().toISOString() });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Force bubble check (manual trigger)
app.post('/api/agent-chat/check-bubbles', auth.authMiddleware(), async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    
    console.log(' Manual bubble check triggered by user:', req.user.email);
    try {
      const chats = (typeof agentChatManager !== 'undefined' && agentChatManager && typeof agentChatManager.getActiveChats === 'function') ? await agentChatManager.getActiveChats() : [];
      res.json({
        success: true,
        message: 'Bubble check completed',
        activeBubbles: chats.length,
        chats: chats.map(chat => ({
          id: chat.id,
          status: chat.status,
          hasUnread: chat.has_unread_messages
        }))
      });
    } catch (inner) {
      res.json({ success: true, message: 'Bubble check completed', activeBubbles: 0, chats: [] });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test webhook processing (for development and testing)
app.post('/api/webhook/test', auth.authMiddleware(), async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'master') {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    
    const { chatId, message, skipLiveChat = true } = req.body;
    
    if (!chatId || !message) {
      return res.status(400).json({ success: false, error: 'chatId and message are required' });
    }
    
    console.log('\nÃ°Å¸Â§Âª ===== WEBHOOK TEST STARTED =====');
    console.log(`Ã°Å¸â€œÂ± Test Chat ID: ${chatId}`);
    console.log(`Ã°Å¸â€œÂ Test Message: "${message}"`);
    console.log(`Ã¢ÂÂ° Started: ${new Date().toLocaleString()}`);
    
    const startTime = Date.now();
    
    // Tests invoking the AI are disabled. Record an audit entry instead and
    // return a deterministic response to the API caller.
    try { const dbi = await getDb(); await addMessage(dbi, chatId, 'system', `AI test invoked but automatic AI is disabled (message: ${String(message).slice(0,200)})`); } catch(_) {}
    const processingTime = Date.now() - startTime;
    const result = {
      success: true,
      testResults: {
        chatId,
        inputMessage: message,
        aiResponse: null,
        processingTimeMs: processingTime,
        timestamp: new Date().toISOString(),
        performanceRating: 'Disabled'
      },
      note: 'AI test ran in audit-only mode; no AI was invoked.'
    };
    res.json(result);
    
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== API TOOLS ENDPOINTS ====================

// Get all API tools
app.get('/api/tools', auth.authMiddleware(), async (req, res) => {
  try {
    const { getAllApiTools } = require('./db-utils');
    const activeOnly = req.query.active === 'true';
    const tools = await getAllApiTools(activeOnly);
    res.json({ success: true, tools });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get specific API tool with full configuration
app.get('/api/tools/:id', auth.authMiddleware(), async (req, res) => {
  try {
    const { getApiTool } = require('./db-utils');
    const tool = await getApiTool(req.params.id);
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    res.json({ success: true, tool });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Create new API tool
app.post('/api/tools', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { createApiTool } = require('./db-utils');
    const { name, description, webhook_address, max_tool_calls, api_key_bearer } = req.body;
    
    if (!name || !description || !webhook_address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: name, description, webhook_address' 
      });
    }
    
    const tool = await createApiTool({
      name,
      description,
      webhook_address,
      max_tool_calls: max_tool_calls || 30,
      api_key_bearer
    }, req.user.id);
    
    res.json({ success: true, tool });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'Tool name already exists' });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// Update API tool
app.put('/api/tools/:id', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { updateApiTool } = require('./db-utils');
    const success = await updateApiTool(req.params.id, req.body);
    
    if (!success) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete API tool
app.delete('/api/tools/:id', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { deleteApiTool } = require('./db-utils');
    const success = await deleteApiTool(req.params.id);
    
    if (!success) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Add field to API tool
app.post('/api/tools/:id/fields', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { addApiToolField } = require('./db-utils');
    const { field_name, field_type, description, is_required, enum_values, default_value } = req.body;
    
    if (!field_name || !field_type || !description) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: field_name, field_type, description' 
      });
    }
    
    if (!['text', 'number', 'boolean', 'phone'].includes(field_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid field_type. Must be: text, number, boolean, or phone' 
      });
    }
    
    const field = await addApiToolField(req.params.id, {
      field_name,
      field_type,
      description,
      is_required: Boolean(is_required),
      enum_values,
      default_value
    });
    
    res.json({ success: true, field });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'Field name already exists for this tool' });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// Update tool field
app.put('/api/tools/:toolId/fields/:fieldId', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { updateApiToolField } = require('./db-utils');
    const success = await updateApiToolField(req.params.fieldId, req.body);
    
    if (!success) {
      return res.status(404).json({ success: false, error: 'Field not found' });
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete tool field
app.delete('/api/tools/:toolId/fields/:fieldId', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { deleteApiToolField } = require('./db-utils');
    const success = await deleteApiToolField(req.params.fieldId);
    
    if (!success) {
      return res.status(404).json({ success: false, error: 'Field not found' });
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Add payload field to API tool
app.post('/api/tools/:id/payload', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { addApiToolPayload } = require('./db-utils');
    const { key_name, value_type, static_value } = req.body;
    
    if (!key_name) {
      return res.status(400).json({ success: false, error: 'Missing required field: key_name' });
    }
    
    const payload = await addApiToolPayload(req.params.id, {
      key_name,
      value_type: value_type || 'static',
      static_value
    });
    
    res.json({ success: true, payload });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'Payload key already exists for this tool' });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test API tool
app.post('/api/tools/:id/test', auth.authMiddleware(), async (req, res) => {
  try {
    const { getApiTool, logApiToolUsage } = require('./db-utils');
    const tool = await getApiTool(req.params.id);
    
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    
    const testData = req.body.testData || {};
    const startTime = Date.now();
    
    try {
      // Execute the API tool
      const result = await executeApiTool(tool, testData, 'TEST_CHAT_ID');
      const executionTime = Date.now() - startTime;
      
      // Log the test
      await logApiToolUsage(
        tool.id,
        'TEST_CHAT_ID',
        testData,
        result,
        true,
        null,
        executionTime
      );
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Log the failed test
      await logApiToolUsage(
        tool.id,
        'TEST_CHAT_ID',
        testData,
        null,
        false,
        error.message,
        executionTime
      );
      
      res.json({ 
        success: false, 
        error: error.message,
        execution_time_ms: executionTime,
        test_mode: true
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get tool usage statistics
app.get('/api/tools/:id/stats', auth.authMiddleware(), async (req, res) => {
  try {
    if (!(req.user.role === 'owner' || req.user.role === 'master')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    
    const { getApiToolUsageStats } = require('./db-utils');
    const days = parseInt(req.query.days) || 30;
    const stats = await getApiToolUsageStats(req.params.id, days);
    
    res.json({ success: true, stats, period_days: days });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== END API TOOLS ENDPOINTS ====================

// API Tool execution function
async function executeApiTool(tool, inputData, chatId) {
  const axios = require('axios');
  
  // Build payload from input fields and additional payload
  const payload = {};
  
  // Add input field values
  if (tool.fields && Array.isArray(tool.fields)) {
    for (const field of tool.fields) {
      const value = inputData[field.field_name];
      
      // Validate required fields
      if (field.is_required && (value === undefined || value === null || value === '')) {
        throw new Error(`Required field missing: ${field.field_name}`);
      }
      
      // Type validation and conversion
      if (value !== undefined && value !== null && value !== '') {
        switch (field.field_type) {
          case 'number':
            const numValue = Number(value);
            if (isNaN(numValue)) {
              throw new Error(`Invalid number for field: ${field.field_name}`);
            }
            payload[field.field_name] = numValue;
            break;
          case 'boolean':
            payload[field.field_name] = Boolean(value);
            break;
          case 'text':
          case 'phone':
          default:
            payload[field.field_name] = String(value);
            break;
        }
      } else if (field.default_value !== null && field.default_value !== undefined) {
        payload[field.field_name] = field.default_value;
      }
    }
  }
  
  // Add additional payload fields
  if (tool.payload && Array.isArray(tool.payload)) {
    for (const payloadField of tool.payload) {
      switch (payloadField.value_type) {
        case 'static':
          payload[payloadField.key_name] = payloadField.static_value;
          break;
        case 'phone_number':
          // This would need integration with user data - placeholder for now
          payload[payloadField.key_name] = '+6281234567890'; // Example
          break;
        case 'user_data':
          // This would need integration with user data - placeholder for now
          payload[payloadField.key_name] = null;
          break;
        default:
          payload[payloadField.key_name] = payloadField.static_value;
          break;
      }
    }
  }
  
  // Prepare HTTP request
  const requestConfig = {
    method: 'POST',
    url: tool.webhook_address,
    data: payload,
    timeout: 30000, // 30 second timeout
    headers: {
      'Content-Type': 'application/json'
    }
  };
  
  // Add Bearer token if configured
  if (tool.api_key_bearer) {
    requestConfig.headers['Authorization'] = `Bearer ${tool.api_key_bearer}`;
  }
  
  try {
    const response = await axios(requestConfig);
    return {
      status: response.status,
      data: response.data,
      headers: response.headers
    };
  } catch (error) {
    if (error.response) {
      // Server responded with error status
      throw new Error(`API Error ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
    } else if (error.request) {
      // Request timeout or network error
      throw new Error(`Network Error: ${error.message}`);
    } else {
      // Other error
      throw new Error(`Request Error: ${error.message}`);
    }
  }
}

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// 404 handler for API routes to return JSON consistently
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Helper function to get local IP address
function getLocalIpAddress() {
  const interfaces = require('os').networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      const { address, family, internal } = iface;
      if (family === 'IPv4' && !internal) {
        return address;
      }
    }
  }
  return 'localhost';
}

// Track if we're already shutting down
let isShuttingDown = false;

// Handle process termination
const gracefulShutdown = () => {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\nÃ°Å¸â€˜â€¹ Shutting down server...');
  try {
    console.log('Graceful shutdown triggered; stack trace:');
    console.log(new Error().stack);
  } catch (_) {}
  
  // Close server instance first (guard against double-close and non-listening state)
  try {
    if (serverInstance && serverInstance.listening) {
      console.log('Ã°Å¸â€ºâ€˜ Closing server...');
      try {
        serverInstance.close((err) => {
          if (err) {
            console.error('Error closing server:', err);
          } else {
            console.log('Ã¢Å“â€¦ Server has been stopped');
          }

          // Close database connection after server is closed
          if (db) {
            console.log('Ã°Å¸â€â€™ Closing database connection...');
            try {
              // better-sqlite3 uses synchronous close()
              if (typeof db.close === 'function') db.close();
              console.log('Ã¢Å“â€¦ Database connection closed');
            } catch (dbError) {
              console.error('Error during database close:', dbError);
            }
          }
          process.exit(0);
        });
      } catch (closeErr) {
        // Some Node versions may throw when closing an already-closed server
        console.warn('Warning closing server (caught):', closeErr && closeErr.message ? closeErr.message : closeErr);
        if (db && typeof db.close === 'function') {
          try { db.close(); } catch (_) {}
        }
        process.exit(0);
      }

      // Force close after 5 seconds if server doesn't close gracefully
      setTimeout(() => {
        console.warn('Forcing server shutdown...');
        try { if (db && typeof db.close === 'function') db.close(); } catch(_) {}
        process.exit(0); // Use exit code 0 to prevent error reporting
      }, 5000);
    } else {
      // No server instance or not listening: close DB synchronously and exit
      if (db && typeof db.close === 'function') {
        console.log('Ã°Å¸â€â€™ Closing database connection...');
        try { db.close(); console.log('Ã¢Å“â€¦ Database connection closed'); } catch (dbError) { console.error('Error closing database:', dbError); }
      }
      process.exit(0);
    }
  } catch (err) {
    console.error('Unexpected error during graceful shutdown:', err);
    try { if (db && typeof db.close === 'function') db.close(); } catch(_) {}
    process.exit(0);
  }
};

// Register signal handlers only when explicitly enabled via env.
// Some hosting/test environments send signals unexpectedly; make this opt-in
// to avoid premature shutdowns during debugging. To enable set
// ENABLE_GRACEFUL_SHUTDOWN=true in the environment.
try {
  if (String(process.env.ENABLE_GRACEFUL_SHUTDOWN || '').toLowerCase() === 'true') {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  } else {
    console.log('Graceful shutdown handlers are DISABLED. Set ENABLE_GRACEFUL_SHUTDOWN=true to enable them.');
  }
} catch (e) {
  // If anything goes wrong, avoid crashing the server during startup
  console.warn('Failed to register graceful shutdown handlers:', e?.message || e);
}





