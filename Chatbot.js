const axios = require('axios');
// OpenAI (ESM-only) will be loaded dynamically below to keep CJS compatibility
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ override: true });
const { getPromotions, formatPromotions } = require('./promotions');
// Also keep the full module reference for helper methods added recently
const promotions = require('./promotions');
const { getDb, addMessage, getChatMessages, getChatGroup, getGroupConfig, listGroupPromotions, updateChatState, setChatStatus } = require('./db-utils');
const rtpConfig = require('./rtp.json');
// Centralized OpenAI wrapper (governance + usage logging)
const aiClient = require('./utils/aiClient');
// Fast AI client for quicker responses
const fastAiClient = require('./utils/fastAiClient');
// Typing indicator helper (best-effort)
const { setTyping } = require('./livechat-group-helpers.js');

// Supported banks for deposits and withdrawals
const SUPPORTED_BANKS = ['BCA', 'Mandiri', 'BNI', 'BRI', 'CIMB Niaga', 'Permata', 'Danamon'];

// Constants for settings and branding
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const DEFAULT_BRAND_NAME = 'VIP sec 45';
let globalBrandName = DEFAULT_BRAND_NAME;

// Suppress logs related to summarizer/rewriter for cleaner output
try {
  const _origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
      if (
        msg.includes('LLM rewrite failed') ||
        msg.includes('Combined summarizer failed') ||
        msg.includes('sendAgentReply rewrite failed')
      ) {
        return; // drop noisy rewriter/summarizer warnings
      }
    } catch (_) {}
    _origWarn(...args);
  };
} catch (_) {}

// Fallback deposit amount formatter (used when handlers/depositHandler isn't available)
function formatDepositAmount(n) {
  try {
    if (n == null) return '';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return num.toLocaleString('id-ID');
  } catch (_) { return String(n); }
}

// Helper to build meta passed to aiClient.chatCompletion so aiClient can
// inject group-specific aiSettings. Returns { chatId, groupId, source, ...extra }
async function buildMeta(chatId, source, extra = {}) {
  let gid = null;
  try {
    if (chatId != null) gid = await getGroupIdForChat(chatId).catch(() => null);
  } catch (_) { gid = null; }
  const out = Object.assign({ chatId: chatId != null ? chatId : null, groupId: gid != null ? (Number(gid) || gid) : null, source: source || null }, extra || {});
  return out;
}

// Inline deterministic intent detection helpers
// These replace the external ./handlers/intentDetection module per feature request.
function containsAny(text, patterns) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  const norm = lower.replace(/["'`~!@#$^&*()_+=\[\]{}\\|;:\\/,<>?]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const p of patterns) {
    if (!p) continue;
    if (typeof p === 'string') {
      const ps = p.toLowerCase().trim();
      if (!ps) continue;
      if (lower.includes(ps) || norm.includes(ps)) return true;
      continue;
    }
    if (p instanceof RegExp) {
      try {
        if (p.test(text)) return true;
      } catch (_) {}
    }
  }
  return false;
}

// Deterministic intent helpers (simple, local heuristics)
function isDepositInquiry(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  // common deposit keywords and slang
  if (/\b(deposit|depo|dp|top\s?up|topup|isi saldo|setor|cek deposit|cek depo)\b/i.test(t)) return true;
  // short tokens that look like user IDs or amounts often indicate deposit follow-ups
  if (/\b(\d+[\.,]?\d*\s*(k|rb|ribu|jt|juta|m)?)\b/i.test(t)) return true;
  if (/\b(user\s*id|userid|id)[:=\s]/i.test(t)) return true;
  return false;
}

function isWithdrawalInquiry(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (/\b(withdraw|wd|tarik|penarikan|withdrawal|wd status|tarik duit)\b/i.test(t)) return true;
  if (/\b(bank|rekening|no rek|nomor rekening|transfer keluar)\b/i.test(t)) return true;
  return false;
}

function isTurnoverInquiry(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (/\b(turnover|omset|to\b|omzet|playthrough)\b/i.test(t)) return true;
  return false;
}

function isPasswordResetInquiry(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (/\b(password|kata sandi|lupa password|reset password|reset kata sandi)\b/i.test(t)) return true;
  if (/\b(login problem|login issues|masuk error|gagal masuk|akun lupa)\b/i.test(t)) return true;
  return false;
}

function isOffTopicConversation(text) {
  try {
    const det = detectOffTopic(String(text || ''));
    return !!(det && det.isOffTopic);
  } catch (_) {
    return false;
  }
}

// Minimal conversation context analyzer fallback.
// The real implementation may be more sophisticated; this keeps callers safe during tests.
function analyzeConversationContext(chatState) {
  try {
    if (!chatState || typeof chatState !== 'object') return { topic: null, lastIntent: null };
    const ctx = chatState.context || {};
    const last = Array.isArray(ctx.conversationHistory) && ctx.conversationHistory.length ? ctx.conversationHistory[ctx.conversationHistory.length - 1] : null;
    return {
      topic: chatState.lastResponseType || (last && last.type) || null,
      lastIntent: chatState.lastIntent || null,
      recentMessages: Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory.slice(-6) : []
    };
  } catch (e) {
    return { topic: null, lastIntent: null };
  }
}

// Minimal detectFollowUp implementation used by getCustomerServiceResponse.
function detectFollowUp(message, contextAnalysis) {
  try {
    const txt = String(message || '').trim();
    if (!txt) return { isFollowUp: false };
    // Simple heuristics: single-token numeric or short messages likely follow-ups
    const isShort = txt.length <= 40;
    const isAmountOnly = /^\s*(?:rp\.?\s*)?(\d+[\.,]?\d*)(\s*(k|rb|ribu|jt|juta|m)?)\s*$/i.test(txt);
    const isYesNo = /^(ya|tidak|yes|no|y|n|oke|ok|iya|gak|ga)$/i.test(txt);
    return { isFollowUp: isShort && (isAmountOnly || isYesNo), indicators: { isAmountOnly, isShort, isYesNo } };
  } catch (e) {
    return { isFollowUp: false };
  }
}

// Minimal promo and rtp detectors as fallbacks used in multiple locations.
function isPromoRequest(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return /\b(promo|promosi|bonus|bnz|kode promo|ada promo|ada promosi)\b/i.test(t) || /\b(ada promo|ada bonus|promo baru)\b/.test(t);
}

function isRtpRequest(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return /\brtp\b|\b(daftar game|game apa|slot apa|gacor)\b/i.test(t) || /\b(keuntungan rumah|return to player|rtp link)\b/i.test(t);
}

// Minimal buildSmartResponse fallback: return null (no smart response)
function buildSmartResponse(message, contextAnalysis, followUpInfo) {
  // The production implementation may return a string or structured object.
  // For deterministic tests we default to null so message flows continue to template handlers.
  return null;
}

// Minimal addContextualTip fallback: append a small contextual hint based on type
function addContextualTip(text, type, context = {}) {
  try {
    if (!text || typeof text !== 'string') return text;
    // Keep it minimal to avoid changing UX: only add tip when explicit flag set in context
    if (context && context._suppressTips) return text;
    // Provide tiny helpful suffix for limits and banking
    if (type === 'limits') return text + '\n\nButuh bantuan lain? Tanya saya ya 😊';
    if (type === 'banking') return text + '\n\nButuh informasi rekening lain?';
    if (type === 'promotion') return text + '\n\nMau klaim promo ini? Saya bantu.';
    return text;
  } catch (e) { return text; }
}

// Minimal personality enhancer: apply lightweight personality tweaks without altering meaning
function enhanceResponsePersonality(text, chatState) {
  try {
    if (!text || typeof text !== 'string') return text;
    // Keep short responses unchanged; append a friendly token for longer messages
    if (text.length > 100) return `${text.trim()} \n\nSalam, tim ${getFallbackBrandName()}`;
    return text;
  } catch (e) { return text; }
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 1 minute for missing entries
const chatGroupCache = new Map();
const groupConfigCache = new Map();
const groupPromotionsCache = new Map();

function setCachedValue(map, key, value, ttl = CACHE_TTL_MS) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

function getCachedValue(map, key) {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function getFallbackBrandName() {
  // First try globalBrandName
  if (globalBrandName && globalBrandName.trim()) {
    return globalBrandName.trim();
  }
  // Fallback to loading from settings.json
  try {
    const globalSettings = require(SETTINGS_PATH);
    if (globalSettings && typeof globalSettings.brandName === 'string' && globalSettings.brandName.trim()) {
      return globalSettings.brandName.trim();
    }
  } catch (_) {}
  // Final fallback to DEFAULT_BRAND_NAME
  return DEFAULT_BRAND_NAME;
}

// --- Deposit & Withdrawal Limits Configuration ---------------------------------

// Load deposit and withdrawal limits from settings, prefer group-specific limits when chatId is provided
async function getDepositWithdrawalLimits(chatId = null) {
  try {
    // Always require group-specific limits. Do NOT fall back to global settings.json.
    if (chatId != null) {
      try {
        const aiSettings = await getGroupAiSettingsForChat(chatId);
        if (aiSettings && aiSettings.limits && typeof aiSettings.limits === 'object') {
          const l = aiSettings.limits;
          return {
            minDeposit: l.minDeposit != null ? l.minDeposit : null,
            maxDeposit: l.maxDeposit != null ? l.maxDeposit : null,
            minWithdrawal: l.minWithdrawal != null ? l.minWithdrawal : null,
            maxWithdrawal: l.maxWithdrawal != null ? l.maxWithdrawal : null
          };
        }
      } catch (e) {
        console.warn('Failed to load group aiSettings limits:', e && e.message ? e.message : e);
      }
    }

    // No group-level settings available: do NOT use global settings.json. Return nulls.
    return {
      minDeposit: null,
      maxDeposit: null,
      minWithdrawal: null,
      maxWithdrawal: null
    };
  } catch (e) {
    console.warn('Failed to load deposit/withdrawal limits:', e && e.message ? e.message : e);
    return {
      minDeposit: null,
      maxDeposit: null,
      minWithdrawal: null,
      maxWithdrawal: null
    };
  }
}

// Load custom messages from settings
async function getCustomMessages() {
  // Deprecated global settings access. Always prefer group-specific custom messages.
  // Provide a thin wrapper that returns nulls when no chatId is provided. Use
  // getGroupAiSettingsForChat for group-level custom messages.
  return async function _getCustomMessagesForChat(chatId = null) {
    try {
      if (chatId != null) {
        const aiSettings = await getGroupAiSettingsForChat(chatId);
        if (aiSettings && aiSettings.customMessages && typeof aiSettings.customMessages === 'object') {
          const cm = aiSettings.customMessages;
          return {
            welcomeMessage: cm.welcomeMessage || null,
            waitMessage: cm.waitMessage || null,
            endMessage: cm.endMessage || null
          };
        }
      }
    } catch (e) {
      console.warn('Failed to load group custom messages:', e && e.message ? e.message : e);
    }
    return { welcomeMessage: null, waitMessage: null, endMessage: null };
  };
}

// Format amount with Indonesian number formatting
// formatAmount is now imported as formatDepositAmount from handlers/depositHandler.js

// Generate deposit limits text in Indonesian or English
function getDepositLimitsText(limits, language = 'id') {
  const { minDeposit, maxDeposit } = limits;
  
  if (!minDeposit && !maxDeposit) return '';
  
  if (language === 'en') {
    if (minDeposit && maxDeposit) {
      return `Deposit limits: minimum Rp ${formatDepositAmount(minDeposit)}, maximum Rp ${formatDepositAmount(maxDeposit)}.`;
    } else if (minDeposit) {
      return `Minimum deposit: Rp ${formatDepositAmount(minDeposit)}.`;
    } else if (maxDeposit) {
      return `Maximum deposit: Rp ${formatDepositAmount(maxDeposit)}.`;
    }
  } else {
    if (minDeposit && maxDeposit) {
      return `Batas deposit: minimal Rp ${formatDepositAmount(minDeposit)}, maksimal Rp ${formatDepositAmount(maxDeposit)}.`;
    } else if (minDeposit) {
      return `Minimal deposit: Rp ${formatDepositAmount(minDeposit)}.`;
    } else if (maxDeposit) {
      return `Maksimal deposit: Rp ${formatDepositAmount(maxDeposit)}.`;
    }
  }
  
  return '';
}

// Generate withdrawal limits text in Indonesian or English
function getWithdrawalLimitsText(limits, language = 'id') {
  const { minWithdrawal, maxWithdrawal } = limits;
  
  if (!minWithdrawal && !maxWithdrawal) return '';
  
  if (language === 'en') {
    if (minWithdrawal && maxWithdrawal) {
      return `Withdrawal limits: minimum Rp ${formatDepositAmount(minWithdrawal)}, maximum Rp ${formatDepositAmount(maxWithdrawal)}.`;
    } else if (minWithdrawal) {
      return `Minimum withdrawal: Rp ${formatDepositAmount(minWithdrawal)}.`;
    } else if (maxWithdrawal) {
      return `Maximum withdrawal: Rp ${formatDepositAmount(maxWithdrawal)}.`;
    }
  } else {
    if (minWithdrawal && maxWithdrawal) {
      return `Batas penarikan: minimal Rp ${formatDepositAmount(minWithdrawal)}, maksimal Rp ${formatDepositAmount(maxWithdrawal)}.`;
    } else if (minWithdrawal) {
      return `Minimal penarikan: Rp ${formatDepositAmount(minWithdrawal)}.`;
    } else if (maxWithdrawal) {
      return `Maksimal penarikan: Rp ${formatDepositAmount(maxWithdrawal)}.`;
    }
  }
  
  return '';
}

// Build dynamic welcome message including brand name
async function buildWelcomeMessage(chatId) {
  try {
    const groupId = await getChatGroup(chatId);
    let brandName = globalBrandName;
    
    if (groupId) {
      const groupConfig = await getGroupConfig(groupId);
      if (groupConfig && groupConfig.brand_name) {
        brandName = groupConfig.brand_name;
      }
    }
    
    // Check for custom welcome message in group aiSettings
    const getCustomMessagesForChat = await getCustomMessages();
    const customMessages = await getCustomMessagesForChat(chatId);
    if (customMessages.welcomeMessage && customMessages.welcomeMessage.trim()) {
      try { console.log('[DEBUG] buildWelcomeMessage: using group custom welcome for chat', chatId); } catch(_) {}
      return customMessages.welcomeMessage.trim();
    }
    // If no group custom welcome, prefer settings.json welcomeMessage if present
    try {
      const globalSettings = require(SETTINGS_PATH);
      if (globalSettings && typeof globalSettings.welcomeMessage === 'string' && globalSettings.welcomeMessage.trim()) {
        try { console.log('[DEBUG] buildWelcomeMessage: using settings.json welcomeMessage for chat', chatId); } catch(_) {}
        return globalSettings.welcomeMessage.trim();
      }
    } catch (_) {}
    
    return `Halo! Selamat datang di ${brandName}! Ada yang bisa saya bantu?`;
  } catch (e) {
    return `Halo! Selamat datang di ${globalBrandName}! Ada yang bisa saya bantu?`;
  }
}

// Build deposit/withdrawal limits response
async function buildLimitsResponse(chatId, language = 'id') {
  try {
  const limits = await getDepositWithdrawalLimits(chatId);
    const brandName = await getBrandNameForChat(chatId);
    
    const lines = [];
    
    if (language === 'id') {
      lines.push(`💰 Informasi Batas Transaksi ${brandName} 💰\n`);
      
      // Deposit limits
      if (limits.minDeposit || limits.maxDeposit) {
        lines.push('📥 *Deposit:*');
        if (limits.minDeposit) {
          lines.push(`   • Minimal: Rp ${formatDepositAmount(limits.minDeposit)}`);
        }
        if (limits.maxDeposit) {
          lines.push(`   • Maksimal: Rp ${formatDepositAmount(limits.maxDeposit)}`);
        }
        lines.push('');
      }
      
      // Withdrawal limits
      if (limits.minWithdrawal || limits.maxWithdrawal) {
        lines.push('📤 *Withdrawal:*');
        if (limits.minWithdrawal) {
          lines.push(`   • Minimal: Rp ${formatDepositAmount(limits.minWithdrawal)}`);
        }
        if (limits.maxWithdrawal) {
          lines.push(`   • Maksimal: Rp ${formatDepositAmount(limits.maxWithdrawal)}`);
        }
        lines.push('');
      }
      
      if (lines.length <= 1) {
        return 'Untuk informasi batas deposit dan withdrawal, silakan hubungi CS kami ya bosku! 😊';
      }
      
      lines.push('Ada yang bisa saya bantu lagi bosku? 😊');
    } else {
      // English version
      lines.push(`💰 ${brandName} Transaction Limits 💰\n`);
      
      // Deposit limits
      if (limits.minDeposit || limits.maxDeposit) {
        lines.push('📥 *Deposit:*');
        if (limits.minDeposit) {
          lines.push(`   • Minimum: Rp ${formatDepositAmount(limits.minDeposit)}`);
        }
        if (limits.maxDeposit) {
          lines.push(`   • Maximum: Rp ${formatDepositAmount(limits.maxDeposit)}`);
        }
        lines.push('');
      }
      
      // Withdrawal limits
      if (limits.minWithdrawal || limits.maxWithdrawal) {
        lines.push('📤 *Withdrawal:*');
        if (limits.minWithdrawal) {
          lines.push(`   • Minimum: Rp ${formatDepositAmount(limits.minWithdrawal)}`);
        }
        if (limits.maxWithdrawal) {
          lines.push(`   • Maximum: Rp ${formatDepositAmount(limits.maxWithdrawal)}`);
        }
        lines.push('');
      }
      
      if (lines.length <= 1) {
        return 'For information about deposit and withdrawal limits, please contact our CS team! 😊';
      }
      
      lines.push('Is there anything else I can help you with? 😊');
    }
    
    return lines.join('\n');
  } catch (error) {
    console.error('Error building limits response:', error.message);
    return language === 'id' 
      ? 'Maaf bosku, terjadi kendala saat menampilkan informasi batas. Silakan hubungi CS kami ya! 😊'
      : 'Sorry boss, there was an issue displaying limit information. Please contact our CS team! 😊';
  }
}

// Build bank info response
async function buildBankInfoResponse(chatId, getBrandNameForChat) {
  try {
    const brandName = await getBrandNameForChat(chatId);
    const payments = await getPaymentsForChat(chatId);
    
    let banks = [];
    if (payments && Array.isArray(payments.banks) && payments.banks.length > 0) {
      banks = payments.banks;
    } else {
      // Fallback to global SUPPORTED_BANKS if available
      banks = SUPPORTED_BANKS || ['BCA', 'Mandiri', 'BNI', 'BRI', 'CIMB Niaga', 'Permata', 'Danamon'];
    }
    
    const bankList = banks.join(', ');
    const response = `Kami terima transfer dari bank ${bankList} dan banyak lagi bosku! 🏦💰 Mau ganti rekening? Nanti kami pandu verifikasinya ya 😊`;
    
    return response;
  } catch (error) {
    console.error('Error building bank info response:', error.message);
    return 'Maaf bosku, terjadi kendala saat menampilkan informasi bank. Silakan hubungi CS kami ya! 😊';
  }
}

// Build RTP response
async function buildRtpResponse(chatId) {
  try {
    const cfg = await getGroupConfigForChat(chatId);
    let rtpLink = null;
    
    if (cfg && cfg.rtpLink && String(cfg.rtpLink).trim()) {
      rtpLink = String(cfg.rtpLink).trim();
    } else if (rtpConfig && rtpConfig.rtpLink) {
      rtpLink = String(rtpConfig.rtpLink).trim();
    }
    
    if (rtpLink) {
      const response = `🧠 Cheat code RTP hari ini: ${rtpLink}\n\nButuh bantuan? Kasih tahu saya ya 😊`;
      return response;
    } else {
      return 'Maaf bosku, saat ini belum ada informasi RTP yang tersedia. Apakah ada yang bisa dibantu?';
    }
  } catch (error) {
    console.error('Error building RTP response:', error.message);
    return 'Maaf bosku, terjadi kendala saat menampilkan RTP. Coba lagi sebentar ya. 🙏';
  }
}

function updateGlobalBrandName(name) {
  // Global settings are deprecated. Prefer group-specific aiSettings stored in DB.
  console.warn('updateGlobalBrandName called but global settings are disabled. Use group-level aiSettings instead (update group config in DB).');
}

async function getGroupIdForChat(chatId) {
  if (chatId == null) return null;
  // Normalize chatId for cache and DB lookup to avoid mismatches from whitespace or prefixes
  const key = String(chatId);
  const normalizedKey = key == null ? null : key.trim();
  const cached = getCachedValue(chatGroupCache, normalizedKey);
  if (cached !== undefined) return cached;
  try {
    const row = await getChatGroup(normalizedKey);
    const groupId = row && (row.group_id ?? row.groupId ?? row.GROUP_ID);
    const normalized = groupId != null ? Number(groupId) : null;
    if (normalized != null && !Number.isNaN(normalized)) {
      setCachedValue(chatGroupCache, normalizedKey, normalized, CACHE_TTL_MS);
      return normalized;
    }
    setCachedValue(chatGroupCache, normalizedKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  } catch (error) {
    console.warn('getGroupIdForChat failed:', error.message || error);
    setCachedValue(chatGroupCache, normalizedKey, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
}

async function getGroupConfigForChat(chatId) {
  const groupId = await getGroupIdForChat(chatId);
  if (groupId == null) return null;
  const key = Number(groupId);
  const cached = getCachedValue(groupConfigCache, key);
  if (cached !== undefined) return cached;
  try {
    const config = await getGroupConfig(Number(groupId));
  // suppressed getGroupConfigForChat debug logging
    setCachedValue(groupConfigCache, key, config || null, config ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
    return config || null;
  } catch (error) {
    console.warn('getGroupConfigForChat failed:', error.message || error);
    setCachedValue(groupConfigCache, key, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
}

async function getBrandNameForChat(chatId) {
  const cfg = await getGroupConfigForChat(chatId);
  if (cfg && typeof cfg.brandName === 'string' && cfg.brandName.trim()) {
    return cfg.brandName.trim();
  }
  return getFallbackBrandName();
}

async function getGroupNameForChat(chatId) {
  return getBrandNameForChat(chatId);
}

async function getGroupAiSettingsForChat(chatId) {
  const cfg = await getGroupConfigForChat(chatId);
  // suppressed getGroupAiSettingsForChat debug logging
  if (cfg && cfg.aiSettings && typeof cfg.aiSettings === 'object') {
    return cfg.aiSettings;
  }
  return {};
}

async function getPaymentsForChat(chatId) {
  const aiSettings = await getGroupAiSettingsForChat(chatId);
  if (aiSettings && aiSettings.payments && typeof aiSettings.payments === 'object') {
    return aiSettings.payments;
  }
  return null;
}

async function getRtpLinkForChat(chatId) {
  const cfg = await getGroupConfigForChat(chatId);
  if (cfg && cfg.rtpLink && String(cfg.rtpLink).trim()) {
    return String(cfg.rtpLink).trim();
  }
  if (rtpConfig && rtpConfig.rtpLink) {
    return String(rtpConfig.rtpLink).trim();
  }
  return null;
}

async function getPromotionsForChat(chatId) {
  const groupId = await getGroupIdForChat(chatId);
  if (groupId != null) {
    const key = Number(groupId);
    const cached = getCachedValue(groupPromotionsCache, key);
    if (cached !== undefined) {
      // If cached promos exist, return them. If cached as empty, respect that and
      // return an empty list (do NOT fall back to global promotions for mapped groups).
      if (Array.isArray(cached) && cached.length) return cached;
      return [];
    }
    try {
      const promos = await listGroupPromotions(Number(groupId));
      const normalized = Array.isArray(promos) ? promos : [];
      setCachedValue(groupPromotionsCache, key, normalized, CACHE_TTL_MS);
      // Respect empty group-specific promos (do not fall back to global list)
      return normalized;
    } catch (error) {
      console.warn('listGroupPromotions failed:', error.message || error);
      // On DB failure, cache empty list for a short while to avoid repeated DB hits
      setCachedValue(groupPromotionsCache, key, [], NEGATIVE_CACHE_TTL_MS);
      return [];
    }
  }
  // No group mapping found: fall back to global promotions file
  const fallback = await getPromotions();
  return Array.isArray(fallback) ? fallback : [];
}

// Load access token from environment variable only (no hardcoded fallback)
const ACCESS_TOKEN = process.env.LIVECHAT_ACCESS_TOKEN || '';


// GoodCasino Support Assistant system prompt (JSON-only responses)
const GOODCASINO_SUPPORT_PROMPT = `# 🎰 GoodCasino Support Assistant

You are a smart, friendly, and natural {{BRAND}} support assistant that helps customers with casino-related issues through conversational interactions in Bahasa Indonesia.
make you under every indonesian slang and sentences, informal chat, and typos naturally.
## 🎯 Core Identity & Scope
- **You are exclusively the {{BRAND}} Support Assistant**
- You handle:
  * Deposits & withdrawals
  * Promotions & bonuses  
  * Game recommendations
  * Min/max limits
  * Password resets & account access
  * Turnover/wagering questions
  * Banking & payment methods
  * RTP info & game lists
  * Registration & account help
  * General casino support
- You DO NOT handle:
  * Technical troubleshooting (bugs, connectivity, app errors)
  * Personal advice or off-topic conversations

## ⚡ Core Rules
- ALWAYS respond in valid JSON format:
\`\`\`json
{
  "reply": "string",
  "intent": "deposit|withdraw|promotion|rtp|games|register|bankinfo|general|offtopic",
  "context": {
    "userId": "string|null",
    "language": "id"
  }
}
\`\`\`
- Language: Default to Bahasa Indonesia (id). Switch consistently if user requests another language
- Tone: Chill, slangly, fun, and supportive — like chatting with a friend. Use "bosku" or "kawan" and emojis 🎰😊🔥
- NEVER reveal you're an AI/bot — you're part of the {{BRAND}} support team
- Keep messages concise until all details are collected
- Encourage frustrated users and gently remind about responsible gambling

## 🚨 IMPORTANT PRECEDENCE
- Any IMPORTANT rule overrides all other instructions
- Apply IMPORTANT items first regardless of conflicting guidance

## 🧠 COMPREHENSIVE SLANG UNDERSTANDING
**You naturally understand ALL Indonesian slang, informal chat, and typos:**

### Pronouns & Basics:
- I/me: gw/gue/gua/ane/eke/w
- You: lo/lu/elu/ente/loe/km/kmu  
- Yes/No: ya/iya/yoi/yup/yep/iyak/iyah/iye/iyo | ga/gak/gk/enggak/ngga/nggak/kagak/kgk/g/gx
- Time: udh/udah/dah/uda/sdh (sudah), blm/blom/blum/lom/lum (belum), skrg/skrng/skrang/skr/skg (sekarang)

### Casino & Money Terms:
- Deposit: depo/dp/depost/depoo/deposi
- Withdraw: wd/witdraw/withdrawal/tarik/cairkan/cair
- Money: uang/duit/cuan/cash/dana/dna
- Balance: saldo/sldo
- Play: main/maen/mainn/bet/taruh/taruhan

### Questions & Common Phrases:
- How: gmn/gimana/gmana/gmna/bgmn/gimn
- How much: brp/brapa/berpa/brap
- Why: knp/knapa/kenpa/knpa/napa
- Thanks: makasih/mksh/mksi/makasi/thx/thanks/tq/tengkyu/ty
- Please: tlg/tlong/tlng/tolongin/mhn/pls/plz

### Amounts & Numbers:
- 50k/50rb (50.000), 100k/100rb (100.000), 1jt/1juta/1m (1.000.000)

## 💬 EXAMPLES YOU PERFECTLY UNDERSTAND:
- "depo gw udh blm masuk nih bos" → deposit inquiry
- "tlg cek wd gue 500k dong" → withdrawal check  
- "bos ada promo baru ga?" → promo inquiry
- "game apa yg lgi gacor skrg bro?" → RTP/game inquiry
- "wd gw kok blm cair ya?" → withdrawal status
- "brp minimal dp bos?" → limit inquiry
- "depo 100k tpi sldo ga nambah" → deposit issue
- "udh transfer ke bca blm masuk" → deposit check
- "kenapa wd gw lama bgt?" → withdrawal delay

If a phrase is ambiguous, ask a clarifying question before proceeding.

## 🧠 Natural Language Understanding
You understand ALL Indonesian slang, informal chat, and typos naturally:

### Common Patterns You Perfectly Understand:
- "depo gw udh blm masuk nih bos" → deposit inquiry
- "tlg cek wd gue 500k dong" → withdrawal check  
- "bos ada promo baru ga?" → promo inquiry
- "game apa yg lgi gacor skrg bro?" → RTP/game inquiry
- "wd gw kok blm cair ya?" → withdrawal status
- "brp minimal dp bos?" → limit inquiry

## 🔄 Inquiry Handling Flow                    

### Deposits & Withdrawals
When users mention transaction issues:
1. Request USER ID: "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰"
2. After receiving USER ID: "Oke bosku, mohon tunggu sebentar ya — lagi dicek. 🙏"
3. Provide status update

### Password Reset
When users can't login:
1. Request USER ID: "Kasih USER ID-nya dong bos, biar aku bantu reset password-nya"
2. Process reset: "Oke, tunggu sebentar ya, lagi diproses..."

### Account Turnover
When users ask about wagering:
1. Request USER ID: *"USER ID-nya berapa bos? Biar aku cek turnover-nya"
2. Check status: "Sebentar ya, lagi dicek..."

### Promotions & Bonuses
When users ask about promos:
Phase 1 (Initial): Show promotion titles only
\`\`\`
- New Member Bonus 100%
- Daily Cashback 10%
- Weekend Free Spins
\`\`\`

Phase 2 (Details): If user asks "tell me more" → show Title + T&C
\`\`\`
- New Member Bonus 100%
- Terms: New members only, Turnover x10
\`\`\`

Phase 3 (Claim):If user asks "how to claim" → show claim instructions
\`\`\`
How to claim: Contact Telegram @abc
\`\`\`

### **RTP & Game Info**
When users ask about RTP/games:
- Provide RTP link: {{RTP_LINK}}
- Or direct to game categories

### Bank Information
When users ask about banks:
- List supported banks: BCA, Mandiri, BNI, BRI, CIMB, etc.
- Mention: Account changes require verification



## 💰 Payment Limits & Contexts (IMPORTANT)

### Min/Max Limits:
- Minimum deposit: {{MIN_DEPOSIT}}
- Maximum deposit: {{MAX_DEPOSIT}}
- Minimum withdraw: {{MIN_WITHDRAW}}
- Maximum withdraw: {{MAX_WITHDRAW}}

If limits not configured:"Limit bervariasi sesuai metode pembayaran. Kasih tau metodenya (bank/e-wallet) ya bosku, biar aku cek."

### Payment Contexts to Request:
- User ID (required)
- Payment method (bank/e-wallet)  
- Amount & currency
- Transfer timestamp & timezone
- Reference/transaction ID


## 🎲 Game & RTP Responses
When users ask about "hot" games or strategies:
"Coba deposit di {{BRAND}} dan main slot yang lagi gacor nih bos! 🎰 Min deposit: {{MIN_DEPOSIT}}, max: {{MAX_DEPOSIT}}. Mau tarik duit? Min withdraw: {{MIN_WITHDRAW}}. Ini link RTP-nya: {{RTP_LINK}}"

## 🔄 Standard Flow for All Inquiries
1. Acknowledge the user's message naturally
2. Identify intent from context (no keyword matching)
3. Request necessary info: (USER ID, payment details, etc.)
4. Confirm receipt with: waiting message
5. Provide resolution: or escalate if needed

**You are now ready to assist {{BRAND}} players with natural, helpful, and engaging support!**
`;


// Build brand-aware support prompt by replacing placeholder
function buildSupportPromptForBrand(brand) {
  const b = (brand && String(brand).trim()) || 'GoodCasino';
  return GOODCASINO_SUPPORT_PROMPT.replace(/GoodCasino/g, b).replace(/\{\{BRAND\}\}/g, b);
}

// Prompt-based intent detection (promotion, game list, transfer-to-agent)
async function detectIntentsLLM(message, chatId = null) {
  const text = String(message || '');
  const lower = text.toLowerCase();

  // Fast local heuristics
  const local = {
    is_deposit_query: isDepositInquiry(message),
    is_withdrawal_query: isWithdrawalInquiry(message),
    is_turnover_query: isTurnoverInquiry(message),
    is_promotion_query: isPromoRequest(message),
    is_rtp_query: isRtpRequest(message),
    is_game_list_query: /\b(game|games|slot|slots|gacor|permainan|daftar game|game apa|slot apa)\b/i.test(lower),
    wants_transfer_to_agent: /\b(cs|agent|human|speak to|transfer ke cs|hubungkan ke cs|bisa bantu manusia|operator)\b/i.test(lower)
  };

  // Smart-derived intents using conversation context and follow-up detectors
  async function detectIntentsSmart(msg, chatIdInner = null) {
    try {
      const chatState = getChatState(chatIdInner || 'default');
      const contextAnalysis = analyzeConversationContext(chatState || {});
  const followUpInfo = detectFollowUp(msg, contextAnalysis);
  const lower = String(msg || '').toLowerCase();
      const smart = {
        is_deposit_query: false,
        is_withdrawal_query: false,
        is_turnover_query: false,
        is_promotion_query: false,
        is_game_list_query: false,
        is_rtp_query: false,
        wants_transfer_to_agent: false
      };

      // Topic cues from contextAnalysis.topic
      if (contextAnalysis && contextAnalysis.topic) {
        const t = contextAnalysis.topic;
        if (t === 'deposit') smart.is_deposit_query = true;
        if (t === 'withdrawal') smart.is_withdrawal_query = true;
        if (t === 'turnover') smart.is_turnover_query = true;
        if (t === 'promotion') smart.is_promotion_query = true;
        if (t === 'games' || t === 'rtp') smart.is_game_list_query = true;
      }

      // Follow-up indicators: amount-only follow-ups likely relate to deposit/withdrawal
      if (followUpInfo && followUpInfo.isFollowUp) {
        if (followUpInfo.indicators && followUpInfo.indicators.isAmountOnly) {
          // If recent topic suggests deposit/withdrawal, map accordingly; otherwise prefer deposit
          if (contextAnalysis.topic === 'withdrawal') smart.is_withdrawal_query = true;
          else smart.is_deposit_query = true;
        }
        if (followUpInfo.indicators && followUpInfo.indicators.isShortConfirmation && contextAnalysis.lastIntent) {
          // Confirmation after a deposit/withdraw flow
          if (contextAnalysis.lastIntent === 'deposit') smart.is_deposit_query = true;
          if (contextAnalysis.lastIntent === 'withdrawal') smart.is_withdrawal_query = true;
        }
      }

      // Heuristic terms from the current message as a fallback in smart detector
      if (/\b(deposit|depo|dp|top\s?up|topup|isi saldo|transfer|bayar|kirim)\b/i.test(lower)) smart.is_deposit_query = true;
      if (/\b(withdraw|wd|tarik|penarikan|withdrawal|wd status)\b/i.test(lower)) smart.is_withdrawal_query = true;
      if (/\b(turnover|omset|to|omzet)\b/i.test(lower)) smart.is_turnover_query = true;
      if (/\b(promo|bonus|promosi)\b/i.test(lower)) smart.is_promotion_query = true;
      if (/\b(game|games|slot|slots|gacor|permainan)\b/i.test(lower)) smart.is_game_list_query = true;
      if (/\brtp\b/i.test(lower)) smart.is_rtp_query = true;
      if (/\b(cs|agent|human|speak to|transfer ke cs|hubungkan ke cs|bisa bantu manusia|operator)\b/i.test(lower)) smart.wants_transfer_to_agent = true;

      return smart;
    } catch (e) {
      console.warn('detectIntentsSmart failed:', e && e.message ? e.message : e);
      return {
        is_deposit_query: false,
        is_withdrawal_query: false,
        is_turnover_query: false,
        is_promotion_query: false,
        is_game_list_query: false,
        is_rtp_query: false,
        wants_transfer_to_agent: false
      };
    }
  }
  // If AI client isn't enabled, return local heuristics immediately.
  if (!aiClient.isEnabled()) return Object.assign({}, local);

  // Normalize message for cache key (strip punctuation, collapse spaces)
  const norm = normalizeForMatch(text);

  // 1) Quick smart/local detectors first
  const smartCandidates = await detectIntentsSmart(message, chatId).catch(() => null) || {};
  const mergedFast = {
    is_deposit_query: !!(local.is_deposit_query || smartCandidates.is_deposit_query),
    is_withdrawal_query: !!(local.is_withdrawal_query || smartCandidates.is_withdrawal_query),
    is_turnover_query: !!(local.is_turnover_query || smartCandidates.is_turnover_query),
    is_promotion_query: !!(local.is_promotion_query || smartCandidates.is_promotion_query),
    is_game_list_query: !!(local.is_game_list_query || smartCandidates.is_game_list_query),
    is_rtp_query: !!(local.is_rtp_query || smartCandidates.is_rtp_query),
    wants_transfer_to_agent: !!(local.wants_transfer_to_agent || smartCandidates.wants_transfer_to_agent)
  };

  // If fast detectors found a likely intent, return it immediately to avoid LLM calls.
  // Heuristic: if any of the primary intents (deposit/withdraw/promo/game/rtp/transfer) is true, return.
  const primaryFound = mergedFast.is_deposit_query || mergedFast.is_withdrawal_query || mergedFast.is_promotion_query || mergedFast.is_game_list_query || mergedFast.is_rtp_query || mergedFast.wants_transfer_to_agent || mergedFast.is_turnover_query;
  if (primaryFound) return mergedFast;

  // 2) Check cache for an existing LLM-derived intent
  try {
    const cacheEntry = intentDetectionCache.get(norm);
    if (cacheEntry && (Date.now() - cacheEntry.ts) < INTENT_CACHE_TTL_MS) {
      return cacheEntry.value;
    }
  } catch (_) {}

  // 3) Call LLM for ambiguous/uncertain messages and cache result
  try {
    const brandName = await getBrandNameForChat(chatId);
  // Use the main GoodCasino support system prompt to ensure consistent behavior
  const sys = buildSupportPromptForBrand(brandName) + '\n\nIMPORTANT: For intent classification, reply ONLY with a JSON object. Do NOT include any extra text. JSON fields required: {"is_deposit_query": <bool>, "is_withdrawal_query": <bool>, "is_turnover_query": <bool>, "is_promotion_query": <bool>, "is_game_list_query": <bool>, "is_rtp_query": <bool>, "wants_transfer_to_agent": <bool>}.';
  const user = `Pesan pengguna (Bahasa Indonesia/Inggris campur mungkin):\n\"\"\"${message || ''}\"\"\"\n\nKeluarkan hanya JSON sesuai spesifikasi di instruksi sistem.`;

    const completion = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0,
      max_tokens: 60
    }, await buildMeta(chatId, 'gc.detectIntents'));

    const raw = completion.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      parsed = JSON.parse(String(raw || '').trim() || '{}');
    } catch (parseErr) {
      const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { parsed = {}; }
      } else {
        parsed = {};
      }
    }

    parsed = parsed || {};

    // Merge parsed LLM output with smart-derived and local heuristics.
    // Precedence: LLM true > smart true > local heuristic.
    const merged = {
      is_deposit_query: !!(parsed.is_deposit_query || smartCandidates.is_deposit_query || local.is_deposit_query),
      is_withdrawal_query: !!(parsed.is_withdrawal_query || smartCandidates.is_withdrawal_query || local.is_withdrawal_query),
      is_turnover_query: !!(parsed.is_turnover_query || smartCandidates.is_turnover_query || local.is_turnover_query),
      is_promotion_query: !!(parsed.is_promotion_query || smartCandidates.is_promotion_query || local.is_promotion_query),
      is_game_list_query: !!(parsed.is_game_list_query || smartCandidates.is_game_list_query || local.is_game_list_query),
      is_rtp_query: !!(parsed.is_rtp_query || smartCandidates.is_rtp_query || local.is_rtp_query),
      wants_transfer_to_agent: !!(parsed.wants_transfer_to_agent || smartCandidates.wants_transfer_to_agent || local.wants_transfer_to_agent)
    };

    // Post-process: prefer game/rtp classification when game terms appear
    try {
      const gameTerms = ['game', 'games', 'slot', 'slots', 'gacor', 'rtp', 'permainan', 'slot apa', 'game apa'];
      const hasGameTerm = gameTerms.some(t => lower.includes(t));
      if (hasGameTerm && merged.is_promotion_query) {
        merged.is_promotion_query = false;
        merged.is_game_list_query = true;
        if (/rtp/.test(lower)) merged.is_rtp_query = true;
      }
    } catch (e) { /* ignore post-process errors */ }

    // Cache the result (prune if necessary)
    try {
      if (intentDetectionCache.size > INTENT_CACHE_MAX_ENTRIES) {
        // Simple pruning: remove oldest entries until under limit
        const keys = Array.from(intentDetectionCache.keys());
        for (let i = 0; i < 200 && intentDetectionCache.size > INTENT_CACHE_MAX_ENTRIES; i++) {
          intentDetectionCache.delete(keys[i]);
        }
      }
      intentDetectionCache.set(norm, { value: merged, ts: Date.now() });
    } catch (_) {}

    return merged;
  } catch (e) {
    console.warn('Intent detection error:', e && e.message ? e.message : e);
    // On any failure, return local heuristics (conservative and always complete)
    return Object.assign({}, local);
  }
}

// Helper: extract a plausible User ID from arbitrary user text.
// Accepts alphabetic-only IDs, alphanumeric, underscores, and hyphens (3-30 chars).
function extractUserIdFromText(text) {
  if (!text) return null;
  const t = String(text).trim();
  // Try labelled forms first: 'user id: abc123'
  const labelled = t.match(/(?:user\s*id|uid|userid|user_id|id\s*user|id:)[:=\s-]*([A-Za-z0-9_\-]{3,30})/i);
  if (labelled && labelled[1]) return labelled[1].trim();
  // Short reply forms: only accept a single-token ID if it looks like a real user id.
  // Guard against casual words being misinterpreted as IDs (e.g., 'depo', 'blm', 'boleh').
  const stopwords = new Set(['depo','dp','blm','belum','boleh','cek','cek','wd','withdraw','withdrawal','turnover','omset','omzet','promo','promosi','rtp','apa','ada','saya','gw','gue','oke','ok','ya','tidak','thanks','thank','bosku']);
  // If the message is just a short token, allow more cases: numeric IDs, mixed, lengths >=4
  const singleToken = t.match(/^([A-Za-z0-9_\-]{3,30})(?=\s|$)/);
  if (singleToken && singleToken[1]) {
    const tok = singleToken[1].trim();
    const lower = tok.toLowerCase();
    if (stopwords.has(lower)) return null;
    // Accept token if it contains at least one digit (common in user IDs),
    // or if it's reasonably long (>=4) and alphanumeric, or if it's numeric of length >=4.
    if (/\d/.test(tok) || tok.length >= 4) return tok;
    if (/^\d{4,}$/.test(tok)) return tok;
  }
  // Also try to find an ID-like token anywhere in the text (e.g., 'saya 12345')
  const anywhere = t.match(/\b([A-Za-z0-9_\-]{4,30})\b/g);
  if (anywhere && anywhere.length) {
    for (const cand of anywhere) {
      const lower = cand.toLowerCase();
      if (stopwords.has(lower)) continue;
      if (/\d/.test(cand) || cand.length >= 4) return cand;
    }
  }
  return null;
}

// Axios instance for LiveChat with keep-alive and higher timeout
const http = require('http');
const https = require('https');

const axiosLivechat = axios.create({
  baseURL: 'https://api.livechatinc.com/v3.5',
  timeout: 25000, // increased to 25s to reduce deadline_exceeded timeouts
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
});

// Build server base lazily from env (falls back to localhost:PORT)
// Note: server2.js may auto-increment the port if the default is taken, so we
// compute this at call time to avoid stale values captured at module load.
function getServerBase() {
  const port = process.env.PORT || '3002';
  return process.env.SERVER_BASE || `http://localhost:${port}`;
}

// Silent support ping to our own server; never affects user-facing flow
async function pingSupportSilently({ type = 'account_assistance', chatId, userId = 'anonymous', language = 'id', message = '' }) {
  // Allow disabling external support pings in test or offline environments
  try {
    if (String(process.env.SUPPRESS_SUPPORT_PINGS || '').toLowerCase() === 'true') {
      // Pretend ping succeeded when suppressed
      return true;
    }
  } catch (_) {}
  try {
    // Prefer an in-process ping creator when available to avoid extra HTTP
    // overhead and to ensure pings created by deposit flows and others are
    // identical in structure. Fallback to HTTP POST when not available.
    try {
      if (global) {
        if (typeof global.__scheduleSupportPing === 'function') {
          global.__scheduleSupportPing({ type, chatId, userId, amount: null, language, message: message || '', delayMs: 3000 });
          try { console.debug && console.debug('[DEBUG] pingSupportSilently: used in-process scheduleSupportPing', { type, chatId, userId }); } catch(_) {}
          console.log(`🔔 Support ping (in-process scheduled) created: ${type} chat=${chatId} userId=${userId}`);
          return true;
        }
        if (typeof global.__createSupportPing === 'function') {
          // Fallback: schedule locally so behavior is consistent
          setTimeout(() => { try { global.__createSupportPing({ type, chatId, userId, amount: null, language, message: message || '' }); } catch(_) {} }, 3000);
          try { console.debug && console.debug('[DEBUG] pingSupportSilently: used in-process createSupportPing fallback (scheduled)', { type, chatId, userId }); } catch(_) {}
          console.log(`🔔 Support ping (in-process scheduled fallback) created: ${type} chat=${chatId} userId=${userId}`);
          return true;
        }
      }
    } catch (e) {
      // If global access fails, continue to HTTP fallback
    }

    const base = getServerBase();
    const url = `${base}/support-ping`;
    try { console.debug && console.debug('[DEBUG] pingSupportSilently: POST', url, { type, chatId, userId }); } catch(_) {}
    await axios.post(url, {
      type,
      chatId,
      userId,
      amount,
      language,
      message
    }, { timeout: 4000 });
    console.log(`🔔 Support ping succeeded: ${type} chat=${chatId} userId=${userId} -> ${url}`);
    return true;
  } catch (e) {
    // Log only; do not surface to users or break flow
    try {
      const base2 = getServerBase();
      console.warn('Support ping failed (silently):', e && e.message ? e.message : e, 'url=', base2 ? `${base2}/support-ping` : 'unknown');
    } catch(_) {}
    return false;
  }
}

// Helper to ensure we ping support at most once per chat per flow/key.
async function pingSupportOnce(chatStateObj, key, pingArgs) {
  try {
    if (!chatStateObj) return false;
    if (!chatStateObj.__pings) chatStateObj.__pings = {};
    const ok = await pingSupportSilently(pingArgs).catch(() => false);
    if (ok) {
      chatStateObj.__pings[key] = Date.now();
      console.log(`🔔 pingSupportOnce: pinged ${key} immediately for chat ${pingArgs.chatId}`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('pingSupportOnce error:', e && e.message ? e.message : e);
    return false;
  }
}

// Unified helper to create a consistent support ping like deposit flow does.
// Ensures a sensible userId is provided (tries multiple places) and always
// calls pingSupportOnce with a stable key. Use this from flows that need
// human escalation (turnover, withdraw, password_reset, account_access, etc.).
async function createAndPingSupport(chatStateObj, type, { chatId = null, userId = null, amount = null, language = 'id', message = '' } = {}) {
  try {
    // Ensure we have chatStateObj
    if (!chatStateObj && chatId) chatStateObj = getChatState(chatId);
    // Try to find a userId from common flow state containers when not provided
    if (!userId) {
      try {
        userId = (chatStateObj && chatStateObj.depositState && chatStateObj.depositState.userId) ||
                 (chatStateObj && chatStateObj.withdrawState && chatStateObj.withdrawState.userId) ||
                 (chatStateObj && chatStateObj.passwordResetFlow && chatStateObj.passwordResetFlow.userId) ||
                 (chatStateObj && chatStateObj.accountAccessFlow && chatStateObj.accountAccessFlow.userId) ||
                 (chatStateObj && chatStateObj.turnoverFlow && chatStateObj.turnoverFlow.userId) ||
                 (chatStateObj && chatStateObj.supportFlow && chatStateObj.supportFlow.userId) ||
                 (chatStateObj && chatStateObj.context && chatStateObj.context.userId) ||
                 null;
      } catch (_) { userId = null; }
    }
    // If still no userId, do not create a ping with null userId — prefer 'anonymous'
    if (!userId) userId = 'anonymous';
    if (!chatId && chatStateObj && chatStateObj.chatId) chatId = chatStateObj.chatId;

    const pingArgs = { type, chatId, userId, amount, language, message };
    // Use the flow type as the dedupe key as well to preserve existing behaviour
    const key = type || (pingArgs.type || 'support');
    try { await pingSupportOnce(chatStateObj, key, pingArgs).catch(() => {}); } catch (_) {}
    return true;
  } catch (e) {
    console.warn('createAndPingSupport failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Helper: prefer Basic first if token looks like base64 creds; else try Bearer then Basic
async function livechatPost(path, body, { retries = 3, backoffMs = 700, label = 'livechat' } = {}) {
  const looksBase64 = typeof ACCESS_TOKEN === 'string' && /^[A-Za-z0-9+/=]+$/.test(ACCESS_TOKEN) && ACCESS_TOKEN.includes('=');
  const headersList = looksBase64
    ? [ { Authorization: `Basic ${ACCESS_TOKEN}` }, { Authorization: `Bearer ${ACCESS_TOKEN}` } ]
    : [ { Authorization: `Bearer ${ACCESS_TOKEN}` }, { Authorization: `Basic ${ACCESS_TOKEN}` } ];
  let lastErr;
  for (let i = 0; i < headersList.length; i++) {
    try {
      const { data } = await requestWithRetry(
        () => axiosLivechat.post(path, body, { headers: headersList[i] }),
        { retries, backoffMs, label }
      );
      return data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Only try next header style on auth errors
      if (status === 401 || status === 403) {
        console.warn(`Auth with ${Object.values(headersList[i])[0].split(' ')[0]} failed (${status}). Trying alternative...`);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// Retry helper with exponential backoff and jitter
function isRetryable(error) {
  if (!error) return false;
  if (error.code === 'ECONNABORTED') return true; // timeout
  if (error.response) {
    const status = error.response.status;
    return status === 429 || (status >= 500 && status < 600);
  }
  // Network or no response
  return !!error.request;
}

async function requestWithRetry(requestFn, { retries = 3, backoffMs = 500, label = 'livechat' } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await requestFn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) break;
      const jitter = Math.floor(Math.random() * 150);
      const delay = backoffMs * Math.pow(2, attempt) + jitter;
      console.warn(`⚠️ ${label} request failed (attempt ${attempt + 1}/${retries + 1}): ${err.response?.data?.error?.message || err.message}. Retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastErr;
}

// OpenAI configuration guarded by env flag to avoid unwanted spend
const USE_OPENAI = String(process.env.USE_OPENAI || '').toLowerCase() === 'true';
// Unrestricted assistant mode (ChatGPT-like). When true and OpenAI is enabled, the bot will
// reply using a general assistant prompt with conversation history and automatic language.
// Default to false to enforce strict domain flows and policy adherence.
const UNRESTRICTED_BOT = String(process.env.UNRESTRICTED_BOT || 'false').toLowerCase() === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Disable all downstream AI-based reply reprocessing (rewrites, styling, summarization)
const DISABLE_AI_REPROCESSING = String(process.env.DISABLE_AI_REPROCESSING || 'true').toLowerCase() === 'true';
// Using aiClient for all LLM calls; it handles enablement, governance, and logging.

// Smart State Management with spam prevention
const chatStates = new Map();
const lastResponseTimes = new Map(); // Track last response time per chat
const sentMessages = new Map(); // Track sent messages per chat to prevent duplicates
const activeChatLocks = new Set();
// Cooldown tracker for chats that returned "Chat not active"
const inactiveChatUntil = new Map(); // chatId -> timestamp ms

// Game list and off-topic questions storage
let gameData = {
  offtopic_questions: [],
  games: {
    slot_providers: [],
    live_casino_games: [],
    fish_shooting_games: [],
    mini_games: []
  }
};

// LLM-based language detection (no keyword heuristics)
async function detectLanguageLLM(message, chatId = null) {
  // If OpenAI disabled, fall back to heuristic detector
  if (!aiClient.isEnabled()) {
    return detectLanguage(message || '');
  }
  try {
    const completion = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Detect the user message language. Return only the code: en or id. No explanation.' },
        { role: 'user', content: message || '' }
      ],
      temperature: 0,
      max_tokens: 2
    }, await buildMeta(chatId, 'gc.detectLanguage'));
    const out = (completion.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return out === 'id' ? 'id' : 'en';
  } catch {
    return 'en';
  }
}

// Load game data from JSON file
async function loadGameData() {
  try {
    const data = await fs.readFile(path.join(__dirname, 'data.json'), 'utf8');
    gameData = JSON.parse(data);
    console.log('✅ Game data loaded successfully');
  } catch (error) {
    console.error('❌ Error loading game data:', error.message);
    // Initialize with empty data if file doesn't exist
    await saveGameData();
  }
}

// Save game data to JSON file
async function saveGameData() {
  try {
    await fs.writeFile(path.join(__dirname, 'data.json'), JSON.stringify(gameData, null, 2), 'utf8');
  } catch (error) {
    console.error('❌ Error saving game data:', error.message);
  }
}

// Add an off-topic question to the list
async function addOffTopicQuestion(question) {
  if (!gameData.offtopic_questions.includes(question)) {
    gameData.offtopic_questions.push(question);
    await saveGameData();
  }
}

// Get formatted game list response (Indonesian only)
function getGameListResponse() {
  const games = gameData.games;

  const headers = {
    slots: '🎰 Penyedia Slot:',
    live: '🎲 Permainan Live Casino:',
    fish: '🐠 Game Tembak Ikan:',
    other: '🎮 Permainan Lainnya:'
  };

  const response = [
    headers.slots,
    games.slot_providers.join(', '),
    '',
    headers.live,
    games.live_casino_games.join(', '),
    '',
    headers.fish,
    games.fish_shooting_games.join(', '),
    '',
    headers.other,
    games.mini_games.join(', ')
  ];

  return response.join('\n');
}

// Removed keyword-based promotion/game detection per request. Using detectIntentsLLM instead.

// Format promotions in Indonesian for user display
function formatPromotionsID(promos) {
  if (!promos || promos.length === 0) {
    return 'Saat ini belum ada promo yang tersedia. Cek lagi nanti ya, bosku!';
  }
  
  const now = new Date();
  const lines = ['🎉 Promo & Bonus Terbaru 🎉\n'];
  
  for (const p of promos) {
    // Format time remaining if time limit is set
    let timeRemaining = '';
    if (p.timeLimit && p.timeLimit.expiresAt) {
      const expiresAt = new Date(p.timeLimit.expiresAt);
      if (expiresAt > now) {
        const diffMs = expiresAt - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        timeRemaining = `⏳ Berakhir dalam ${diffDays} hari\n`;
      } else {
        continue; // Skip expired promotions
      }
    }
    
    // Format eligible items if any
    const eligibleItems = p.eligibleItems && p.eligibleItems.length > 0 
      ? `🎮 Barang yang Berlaku: ${p.eligibleItems.join(', ')}\n` 
      : '';
    
    const codeLine = p.code ? `💎 Kode: ${p.code}\n` : '';
    lines.push(
      `${p.title}\n` +
      `${p.description}\n` +
      codeLine +
      `${(p.discount != null || p.bonusPercentage != null) ? `🤑 ${(p.discount != null ? p.discount : p.bonusPercentage)}% Bonus\n` : ''}` +
      timeRemaining +
      eligibleItems +
      (p.terms ? `` : '') +
      `------------------\n`
    );
  }
  
  if (lines.length <= 1) {
    return 'Saat ini belum ada promo yang tersedia. Cek lagi nanti ya, bosku!';
  }
  
  lines.push('\nButuh bantuan klaim promo? Kasih tahu saya ya 😊');
  return lines.join('\n');
}

// Format detailed promotions in Indonesian
function formatPromotionsDetailsListID(promos) {
  if (!promos || promos.length === 0) {
    return 'Saat ini belum ada promo yang tersedia. Cek lagi nanti ya, bosku!';
  }
  
  const now = new Date();
  const lines = ['🎉 Detail Promo & Bonus 🎉\n'];
  
  for (let i = 0; i < promos.length; i++) {
    const p = promos[i];
    
    // Skip expired promotions
    if (p.timeLimit && p.timeLimit.expiresAt) {
      const expiresAt = new Date(p.timeLimit.expiresAt);
      if (expiresAt <= now) continue;
    }
    
    // Basic info
    lines.push(`${i + 1}. ${p.title}`);
    if (p.description) lines.push(`   ${p.description}`);
    if (p.code) lines.push(`   💎 Kode: ${p.code}`);
    
    // Bonus details
    if (p.bonusPercentage) {
      let bonusLine = `   💰 ${p.bonusPercentage}% Bonus`;
      if (p.maxBonus) bonusLine += ` (Maks: ${p.maxBonus})`;
      lines.push(bonusLine);
    } else if (p.bonusAmount) {
      lines.push(`   🎰 Bonus: ${p.bonusAmount}`);
    } else if (p.discount) {
      lines.push(`   🤑 ${p.discount}% Bonus`);
    }
    
    // Validity period
    if (p.startDate || p.endDate) {
      let validityLine = '   📅 Berlaku: ';
      if (p.startDate && p.endDate) {
        validityLine += `${new Date(p.startDate).toLocaleDateString('id-ID')} - ${new Date(p.endDate).toLocaleDateString('id-ID')}`;
      } else if (p.endDate) {
        validityLine += `Hingga ${new Date(p.endDate).toLocaleDateString('id-ID')}`;
      } else if (p.startDate) {
        validityLine += `Dari ${new Date(p.startDate).toLocaleDateString('id-ID')}`;
      }
      lines.push(validityLine);
    }
    
    // Time remaining
    if (p.timeLimit && p.timeLimit.expiresAt) {
      const expiresAt = new Date(p.timeLimit.expiresAt);
      const diffMs = expiresAt - now;
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      lines.push(`   ⏳ Berakhir dalam ${diffDays} hari`);
    }
    
    // Eligible games/items
    const eligArr = (p.eligibleGames && p.eligibleGames.length)
      ? p.eligibleGames
      : (p.eligibleItems && p.eligibleItems.length ? p.eligibleItems : []);
    if (eligArr.length > 0) {
      lines.push(`   🎮 Game yang Berlaku: ${eligArr.join(', ')}`);
    }
    
    // Terms and conditions
    if (p.terms) {
      lines.push('   📜 Syarat & Ketentuan:');
      const terms = Array.isArray(p.terms) ? p.terms : [p.terms];
      terms.forEach((term, idx) => {
        lines.push(`      ${idx + 1}. ${term}`);
      });
    }
    
    // How to claim
    if (p.howToClaim && (Array.isArray(p.howToClaim) ? p.howToClaim.length : String(p.howToClaim).trim().length)) {
      lines.push('   📌 Cara Klaim:');
      const steps = Array.isArray(p.howToClaim) ? p.howToClaim : [p.howToClaim];
      steps.forEach((step, idx) => {
        lines.push(`      ${idx + 1}. ${step}`);
      });
    } else {
      // Generic fallback steps
      lines.push('   📌 Cara Klaim:');
      lines.push('      1. Login ke akun Anda');
      lines.push('      2. Masuk ke halaman deposit');
      lines.push('      3. Masukkan kode promo (jika ada)');
      lines.push('      4. Lakukan deposit sesuai syarat');
    }
    
    lines.push(''); // Empty line between promotions
  }
  
  if (lines.length <= 1) {
    return 'Saat ini belum ada promo yang tersedia. Cek lagi nanti ya, bosku!';
  }
  
  lines.push('Butuh bantuan klaim promo? Kasih tahu saya ya 😊');
  return lines.join('\n');
}

// Load game data when starting
loadGameData().catch(console.error);


// Template messages have been moved to their respective usage locations


// Initialize Chat State
function getChatState(chatId) {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      chatId: chatId,
      context: {
        language: 'en',
        userId: null,
        accountName: null,
        accountNumber: null,
        phoneNumber: null,
        bank: null,
        issueType: null,
        lastUserMessage: null,
        conversationHistory: []
      },
      lastMessageTime: 0,
      lastResponseTime: 0,
      messageCount: 0,
      responseCount: 0,
      lastMessage: '',
      lastResponse: '',
      lastMessageType: '', // 'promo', 'game', 'support', etc.
      lastResponseType: '', // Track the type of the last response sent
      warningCount: 0,
      offTopicWarningCount: 0, // Track number of off-topic warnings
      hasSentWelcome: false, // Track if welcome message was already sent
      hasSentTransferNotice: false, // Track if transfer-to-agent message has been sent
      hasSentWelcomeAt: null, // Timestamp when welcome was sent
      hasReceivedCustomerMessage: false // Becomes true after first real customer message
      ,
      // Promotion flow FSM: idle | promo.list | promo.details | promo.claim
      promoFlow: {
        state: 'idle',
        startedAt: 0,
        repeats: 0,
        lastPromptHash: null
      }
    });
  }
  return chatStates.get(chatId);
}

// Promo and RTP request functions are now imported from handlers/intentDetection.js

// Format RTP config into a human-readable message
function formatRtpConfig(cfg) {
  try {
    const link = cfg?.rtpLink ? String(cfg.rtpLink).trim() : '';
    return link ? `🧠 Cheat code RTP hari ini: ${link}` : '📊 RTP: Link belum tersedia saat ini';
  } catch (e) {
    return '📊 RTP: Link belum tersedia saat ini';
  }
}

// Duplicate suppression: prevent resending identical messages within recent window
function wasMessageSentInChat(chatId, message) {
  if (!message || typeof message !== 'string' || message.trim() === '') {
    console.log(`⚠️ Empty message in chat ${chatId}`);
    return false;
  }

  // If we have no history for this chat, nothing to suppress
  if (!sentMessages.has(chatId)) return false;

  const now = Date.now();
  const windowMs = 5 * 60 * 1000; // 5 minutes (aligned with markMessageSentInChat)

  // Build the same hash used by markMessageSentInChat
  const candidateHash = message.toLowerCase().trim().substring(0, 100);

  // Check recent messages for identical hash
  const chatSent = sentMessages.get(chatId);
  for (const msg of chatSent) {
    if (!msg || typeof msg !== 'object') continue;
    if (now - msg.timestamp > windowMs) continue; // too old
    if (msg.hash === candidateHash) {
      // Exact duplicate in recent window
      return true;
    }
  }

  return false;
}

// Mark message as sent in chat with improved storage and logging
function markMessageSentInChat(chatId, message) {
  if (!message || typeof message !== 'string' || message.trim() === '') {
    console.log(`⚠️ Empty message in chat ${chatId}`);
    return; // Don't store empty messages
  }
  
  if (!sentMessages.has(chatId)) {
    console.log(`ℹ️ Initializing message tracking for chat ${chatId}`);
    sentMessages.set(chatId, new Set());
  }
  
  const chatSentMessages = sentMessages.get(chatId);
  const now = Date.now();
  
  // Clean up old messages (older than 5 minutes) before adding new one
  const recentMessages = [];
  let removedCount = 0;
  
  chatSentMessages.forEach(msg => {
    if (now - msg.timestamp < 5 * 60 * 1000) { // 5 minutes
      recentMessages.push(msg);
    } else {
      removedCount++;
    }
  });
  
  if (removedCount > 0) {
    console.log(`🧹 Cleaned up ${removedCount} old messages from chat ${chatId}`);
  }
  
  // Create message hash (first 100 chars, lowercased, trimmed)
  const messageHash = message.toLowerCase().trim().substring(0, 100);
  
  // Add new message
  const newMessage = {
    hash: messageHash,
    timestamp: now,
    fullMessage: message
  };
  
  recentMessages.push(newMessage);
  
  // Keep only the 20 most recent messages
  const sortedMessages = recentMessages
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20);
    
  // Update the stored messages
  sentMessages.set(chatId, new Set(sortedMessages));
  
  console.log(`📝 Stored message in chat ${chatId}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
  console.log(`   Current messages in chat ${chatId}: ${sortedMessages.length}`);
}

// Response skipping disabled except for empty user messages
function shouldSkipResponse(chatId, userMessage) {
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim() === '') {
    console.log(`🚫 Skipping empty message in chat ${chatId}`);
    return true;
  }
  return false;
}

// Detect Language
function detectLanguage(message) {
  const text = (message || '').toLowerCase();

  // Quick script-based checks
  if (/[\u0600-\u06FF]/.test(message)) return 'ar'; // Arabic script
  if (/[\u0400-\u04FF]/.test(message)) return 'ru'; // Cyrillic (approx.)
  if (/[\u4E00-\u9FFF]/.test(message)) return 'zh'; // CJK Unified Ideographs
  if (/[\u3040-\u30FF]/.test(message)) return 'ja'; // Japanese
  if (/[\uAC00-\uD7AF]/.test(message)) return 'ko'; // Korean
  if (/[\u0E00-\u0E7F]/.test(message)) return 'th'; // Thai

  // Keyword-based heuristics for common languages
  const keywordLangs = [
    { code: 'id', words: ['bosku', 'mohon', 'bantu', 'saya', 'kami', 'tolong', 'terima kasih', 'selamat', 'bagaimana', 'dimana', 'akun', 'deposit', 'withdraw', 'halo', 'hai', 'apa', 'kamu', 'anda', 'bank', 'saja', 'yang'] },
    { code: 'ms', words: ['tolong', 'bantuan', 'akaun', 'pengeluaran', 'depan', 'terima kasih', 'bagaimana', 'di mana'] },
    { code: 'es', words: ['hola', 'gracias', 'por favor', 'ayuda', 'cómo', 'dónde', 'juego', 'retiro', 'depósito'] },
    { code: 'pt', words: ['olá', 'obrigado', 'por favor', 'ajuda', 'como', 'onde', 'jogo', 'saque', 'depósito'] },
    { code: 'fr', words: ['bonjour', 'merci', 's’ il vous plaît', 'aide', 'comment', 'où', 'jeu', 'retrait', 'dépôt'] },
    { code: 'de', words: ['hallo', 'danke', 'bitte', 'hilfe', 'wie', 'wo', 'spiel', 'auszahlung', 'einzahlung'] },
    { code: 'it', words: ['ciao', 'grazie', 'per favore', 'aiuto', 'come', 'dove', 'gioco', 'prelievo', 'deposito'] },
    { code: 'tr', words: ['merhaba', 'teşekkür', 'lütfen', 'yardım', 'nasıl', 'nerede', 'oyun', 'çekim', 'yatırım'] },
    { code: 'vi', words: ['xin chào', 'cảm ơn', 'làm ơn', 'giúp', 'như thế nào', 'ở đâu', 'tr\u00f2 ch\u01a1i', 'r\u00fat ti\u1ec1n', 'n\u1ea1p ti\u1ec1n'] },
    { code: 'tl', words: ['kumusta', 'salamat', 'pakiusap', 'tulong', 'paano', 'saan', 'laro', 'withdraw', 'deposit'] },
    { code: 'hi', words: ['नमस्ते', 'धन्यवाद', 'कृपया', 'मदद', 'कैसे', 'कहाँ'] },
    { code: 'ur', words: ['سلام', 'مہربانی', 'مدد', 'کیسے', 'کہاں'] }
  ];

  for (const { code, words } of keywordLangs) {
    if (words.some(w => text.includes(w))) return code;
  }

  // Default to English
  return 'en';
}

// Normalize language (map region variants to base)
function normalizeLanguageCode(code) {
  if (!code) return 'en';
  const base = code.toLowerCase().split('-')[0];
  const supported = new Set(['en','id','ms','es','pt','fr','de','it','tr','vi','th','tl','hi','ur','ar','zh','ja','ko','ru']);
  return supported.has(base) ? base : 'en';
}

// Normalize text for robust matching (lowercase, remove punctuation, collapse spaces)
function normalizeForMatch(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect preset/variant transfer-to-agent system messages (EN/ID)
function isTransferToAgentMessage(text) {
  const t = normalizeForMatch(text);
  if (!t) return false;

  // Common exact/near-exact phrases
  const phrases = [
    // English
    'looks like i need to transfer you to one of our agents',
    'i need to transfer you to one of our agents',
    'transfer you to one of our agents',
    'transfer you to an agent',
    'transfer you to our agent',
    'connecting you to an agent',
    'connect you to an agent',
    'forward you to an agent',
    'forward you to our agent',
    'hand over to an agent',
    'handover to an agent',
    'escalate to an agent',
    'escalating you to an agent',
    'stay on chat',
    'stay in chat',
    'please stay on chat',
    // Indonesian variants
    'saya akan transfer ke agen',
    'akan transfer ke agen',
    'kami akan menghubungkan ke agen',
    'menghubungkan ke agen',
    'akan dihubungkan ke agen',
    'dialihkan ke agen',
    'alih ke agen',
    'mengarahkan ke agen',
    'hubungkan ke cs',
    'diarahkan ke cs',
    'akan dihubungkan ke cs',
    'tetap di chat',
    'tetap di livechat'
  ];

  if (phrases.some(p => t.includes(p))) return true;

  // Pattern-based detection: verb related to transfer/forward + agent terms
  const pattern = /\b(transfer|alih|dialih|hubung|arahkan|forward|connect|handover|hand\s*over|escalat)\w*\b[\s\S]*\b(agent|agen|cs|support)\b/;
  if (pattern.test(t)) return true;

  // Another pattern: ask user to stay while transferring
  const stayPattern = /\b(stay|tetap)\b[\s\S]*\b(chat|livechat)\b/;
  if (stayPattern.test(t) && /\b(transfer|hubung|forward|connect|alih|arahkan)\w*\b/.test(t)) return true;

  return false;
}

// Simple translation cache to reduce API calls
const translationCache = new Map(); // key: `${lang}|${text}` -> translated

// Intent detection cache to avoid repeated LLM calls for similar messages
// key: normalized message -> { value: <intents object>, ts: <Date.now()> }
const intentDetectionCache = new Map();
const INTENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INTENT_CACHE_MAX_ENTRIES = 2000;

async function translateText(text, targetLang) {
  const lang = normalizeLanguageCode(targetLang);
  if (!text || lang === 'en' || lang === 'id') return text; // No translation needed for EN/ID templates

  const key = `${lang}|${text}`;
  if (translationCache.has(key)) return translationCache.get(key);

  // If OpenAI disabled, skip translation and return original
  if (!aiClient.isEnabled()) {
    return text;
  }
  try {
    const sys = `You are a professional translator. Translate the assistant's message to ${lang} preserving emojis, tone, and formatting (line breaks, markdown). Do NOT add any extra commentary. Output only the translated text.`;
    const resp = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: text }
      ],
      temperature: 0.2,
      max_tokens: 200
    }, await buildMeta(null, 'gc.translate'));
    const translated = resp.choices?.[0]?.message?.content?.trim() || text;
    translationCache.set(key, translated);
    return translated;
  } catch (e) {
    console.error('Translation error:', e.message);
    return text; // Fallback to original
  }
}

// Extract Context
function extractContext(context, message) {
  const text = message.toLowerCase();
  
  // Language is handled in getCustomerServiceResponse via LLM; do not override here
  
  // Extract deposit amount first, then extract User ID from the remaining message
  const amtRegex = /(?:rp|idr|usd)?\s*([0-9][0-9\.,]*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?/i;
  const amtMatch = message.match(amtRegex);
  let messageForId = message; // The part of the message to search for a User ID

  if (amtMatch) {
    const rawAmount = (amtMatch[0] || '').trim();
    context.depositAmount = rawAmount;
    // Remove the amount from the message to avoid it being parsed as a User ID
    messageForId = message.replace(amtMatch[0], '').trim();
  }

  // Extract User ID from the remaining message part
  if (messageForId) {
    // 1) Labeled ID like: "ID W8930020" or "User ID: 12345678"
    let userIdMatch = messageForId.match(/(?:user\s*id|userid|id)[:=\s]*([A-Za-z0-9]{6,16})/i);
    if (!userIdMatch) {
      // 2) Plain alphanumeric 6-16 (allow letters-only IDs like "maxpro")
      //    To reduce false positives on regular sentences, only apply this when the message is relatively short.
      const isShort = messageForId.trim().length <= 40;
      const alnum = isShort ? messageForId.match(/\b[A-Za-z0-9]{6,16}\b/) : null;
      if (alnum) userIdMatch = alnum;
    }
    if (userIdMatch) {
        // If a match is found, use the first capture group if it exists, otherwise the full match.
        context.userId = userIdMatch[1] || userIdMatch[0];
    }
  }
  
  // Extract account name
  const accountNameMatch = message.match(/(?:nama.*rekening|account.*name)[\s:]+([a-zA-Z\s]{2,30})/i);
  if (accountNameMatch) context.accountName = accountNameMatch[1].trim();
  
  // Extract account number
  const accountNumberMatch = message.match(/(?:nomor.*rekening|account.*number|no.*rek)[\s:]+([0-9\-]{5,20})/i);
  if (accountNumberMatch) context.accountNumber = accountNumberMatch[1].trim();
  
  // Extract phone number
  const phoneMatch = message.match(/(?:no.*hp|phone|telepon)[\s:]+([0-9\+\-\s]{8,15})/i);
  if (phoneMatch) context.phoneNumber = phoneMatch[1].trim();
  
  // Extract bank name
  const bankMatch = message.match(/(?:bank)[\s:]+([a-zA-Z\s]{2,15})/i);
  if (bankMatch) context.bank = bankMatch[1].trim();
  
  // Removed keyword-based issueType detection to rely on LLM flows
  
  // Store message in history
  context.conversationHistory.push({
    message: message,
    timestamp: Date.now(),
    type: 'user'
  });
  
  // Keep only last 10 messages
  if (context.conversationHistory.length > 10) {
    context.conversationHistory = context.conversationHistory.slice(-10);
  }
}

// Smart detection for off-topic conversations
function detectOffTopic(message) {
  const text = message.toLowerCase().trim();
  
  // Story telling indicators
  const storyKeywords = [
    'kemarin', 'tadi', 'baru saja', 'sebelumnya', 'waktu itu', 'dulu', 'pas', 'ketika',
    'yesterday', 'earlier', 'just now', 'before', 'that time', 'when', 'then', 'once',
    'cerita', 'story', 'kejadian', 'incident', 'pengalaman', 'experience', 'hal lucu', 'funny thing'
  ];
  
  // Rant indicators
  const rantKeywords = [
    'kesal', 'marah', 'jengkel', 'sebel', 'capek', 'lelah', 'bosan', 'stress', 'frustasi',
    'angry', 'frustrated', 'tired', 'bored', 'stress', 'annoyed', 'sick of', 'fed up',
    'gak enak', 'tidak nyaman', 'ribet', 'complicated', 'susah', 'difficult', 'masalah', 'problem'
  ];
  
  
  // Check for long messages (likely stories or rants)
  const isLongMessage = message.length > 100;
  
  // Check for very short messages (likely off-topic) - but allow greetings
  const isVeryShortMessage = message.length <= 10 && !text.includes('help') && !text.includes('deposit') && !text.includes('withdraw') && 
      !text.includes('password') && !text.includes('register') && !text.includes('hello') && !text.includes('hi') && !text.includes('halo') && !text.includes('hai');
  
  // Check for emotional indicators
  const emotionalIndicators = [
    '😡', '😤', '😠', '😞', '😔', '😢', '😭', '🤬', '💔', '😩', '😫', '😖', '😣',
    '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤', '😤'
  ];
  const hasEmotionalEmojis = emotionalIndicators.some(emoji => message.includes(emoji));
  
  // Check for story patterns
  const storyPatterns = [
    /kemarin\s+.*\s+/, /tadi\s+.*\s+/, /waktu\s+itu\s+/, /dulu\s+.*\s+/,
    /yesterday\s+.*\s+/, /earlier\s+.*\s+/, /that\s+time\s+/, /when\s+.*\s+/
  ];
  const hasStoryPattern = storyPatterns.some(pattern => pattern.test(message));
  
  // Helper to check if any keyword matches
  function matchesAny(keywords) {
    return keywords.some(k => text.includes(k));
  }
  
  // Scoring system
  let score = 0;
  
  if (matchesAny(storyKeywords)) score += 3;
  if (matchesAny(rantKeywords)) score += 3;
  // Removed keyword buckets (casual, off-topic, personal, general) per request
  if (isLongMessage) score += 2;
  if (isVeryShortMessage) score += 3; // High score for very short messages
  if (hasEmotionalEmojis) score += 1;
  if (hasStoryPattern) score += 2;
  
  // Reduce score for greetings (they should not be considered off-topic)
  if (text.includes('hello') || text.includes('hi') || text.includes('halo') || text.includes('hai')) {
    score -= 5; // Significantly reduce score for greetings
  }
  
  // Check for business-related keywords (negative score)
  const businessKeywords = [
    'deposit', 'withdraw', 'password', 'register', 'account', 'user id', 'bank',
    'depo', 'wd', 'tarik', 'setor', 'password', 'daftar', 'akun', 'user id', 'bank'
  ];
  if (matchesAny(businessKeywords)) score -= 2;
  
  return {
    isOffTopic: score >= 4, // Threshold kept
    type: score >= 4 ? (matchesAny(storyKeywords) ? 'story' :
                        matchesAny(rantKeywords) ? 'rant' :
                        'offtopic') : 'offtopic',
    score: score
  };
}

async function handleDepositQuery(message, chatState) {
  // Determine if we are already in a deposit conversation
  const inDepositConversation = !!chatState.deposit_user_id || !!chatState.deposit_inquiry_active;

  // Lightweight, non-OpenAI flow
  if (!aiClient.isEnabled()) {
    chatState.deposit_inquiry_active = true;
    const text = (message || '').toString();

    // Extract amount (supports k/rb/ribu/jt/juta)
    const amtRegex = /(?:rp|idr|usd)?\s*([0-9][0-9\.,]*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?/i;
    const amt = text.match(amtRegex);
    if (amt && !chatState.deposit_amount) {
      let amount = amt[1].replace(/[\.,]/g, '');
      let multiplier = 1;
      const unit = (amt[2] || '').toLowerCase();
      if (unit === 'k' || unit === 'rb' || unit === 'ribu' || unit === 'thousand') multiplier = 1_000;
      else if (unit === 'jt' || unit === 'juta' || unit === 'm' || unit === 'million') multiplier = 1_000_000;
      amount = Math.floor(parseFloat(amount) * multiplier) || null;
      if (amount) chatState.deposit_amount = amount;
    }

    // Extract user id (simple alnum/underscore 4-20 chars)
    if (!chatState.deposit_user_id) {
      const uid = text.match(/\b(user\s*id|uid)\s*[:\-]?\s*([a-z0-9_]{4,20})\b/i) || text.match(/\b([a-z0-9_]{4,20})\b/i);
      if (uid) {
        chatState.deposit_user_id = (uid[2] || uid[1]).toLowerCase();
      }
    }

  // Do not send prompts or confirmations here; unified flow will handle messaging.
  return null;
  }

  const prompt = `
    You are a helpful assistant for a gaming platform. Your task is to analyze a user's message in the context of a potential deposit inquiry.

    The user is communicating in Indonesian.

    Current conversation state:
    - User ID: ${chatState.deposit_user_id || 'Not yet provided'}
    - Deposit Amount: ${chatState.deposit_amount || 'Not yet provided'}

    Analyze the NEW user message below based on the current state:
    "${message}"

    Your goal is to extract the user_id and the amount. The message might contain one, both, or neither.

    Respond with a JSON object with the following structure:
    - "is_deposit_query": boolean (true if the message is part of a deposit conversation, e.g., contains keywords like 'deposit', 'dp', or provides a user ID/amount when one is expected.)
    - "user_id": string (the user's ID, if found in the new message, otherwise null)
    - "amount": number (the deposit amount, if found in the new message, otherwise null)

    Examples of analyzing the NEW message:
    - State: {user_id: null, amount: null}, Message: "cek deposit id player123 50rb"
      JSON: {"is_deposit_query": true, "user_id": "player123", "amount": 50000}
    - State: {user_id: null, amount: null}, Message: "apakah deposit saya sudah masuk?"
      JSON: {"is_deposit_query": true, "user_id": null, "amount": null}
    - State: {user_id: "player123", amount: null}, Message: "50 ribu"
      JSON: {"is_deposit_query": true, "user_id": null, "amount": 50000}
    - State: {user_id: null, amount: null}, Message: "maxpro2"
      JSON: {"is_deposit_query": true, "user_id": "maxpro2", "amount": null}
    - State: {user_id: null, amount: null}, Message: "tolong cek id saya"
      JSON: {"is_deposit_query": false, "user_id": null, "amount": null}
  `;

  try {
    const resp = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 120
    }, await buildMeta(chatState.chatId, 'gc.depositDetect'));

    const resultText = resp?.choices?.[0]?.message?.content || '';
    let result = null;
    try {
      result = JSON.parse(resultText);
    } catch (parseErr) {
      // LLM sometimes returns non-strict JSON or extra commentary. Attempt
      // to recover by extracting the first {...} substring, otherwise fall
      // back to local heuristics. Log a short preview to help debugging.
      try { console.warn('Warning: deposit LLM returned non-JSON output, falling back to heuristics. Preview:', String(resultText).slice(0, 800)); } catch(_) {}
      const jsonMatch = String(resultText).match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { result = JSON.parse(jsonMatch[0]); } catch(_) { result = null; }
      }
      if (!result) {
        // Fallback heuristics: determine if message looks like a deposit inquiry
        result = { is_deposit_query: false, user_id: null, amount: null };
        const depositKeywords = /\b(deposit|depo|dp|top\s?up|topup|isi saldo|transfer|bayar|kirim)\b/i;
        if (depositKeywords.test(message)) result.is_deposit_query = true;

        // Amount extraction (local heuristic)
        const localAmtRegex = /(?:rp|idr|usd)?\s*([0-9][0-9\.,]*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?/i;
        const localAmt = message.match(localAmtRegex);
        if (localAmt) {
          let amount = localAmt[1].replace(/[\.,]/g, '');
          let multiplier = 1;
          const unit = (localAmt[2] || '').toLowerCase();
          if (unit === 'k' || unit === 'rb' || unit === 'ribu' || unit === 'thousand') multiplier = 1000;
          else if (unit === 'jt' || unit === 'juta' || unit === 'm' || unit === 'million') multiplier = 1000000;
          amount = Math.floor(parseFloat(amount) * multiplier) || null;
          if (amount) result.amount = amount;
        }

        // User ID extraction (local heuristic — accept alphabetic IDs too)
        let localId = null;
        const labeled = message.match(/(?:user\s*id|id|username|user|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
        if (labeled) localId = labeled[1];
        if (!localId && (message.trim().length <= 40)) {
          const token = message.match(/^([A-Za-z0-9_\-]{3,20})(?=\s|$)/);
          if (token) {
            const cand = token[1];
            const looksAmount = /^(?:\d+[\.,]?\d*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?$/i.test(cand);
            const hasLetter = /[A-Za-z]/.test(cand);
            const stop = new Set(['depo','deposit','cek','check','sudah','udah','belum','blm','masuk','woi','woy','gua','gw','saya','aku','bosku','halo','hai','hello','hi']);
            if (!looksAmount && hasLetter && !stop.has(cand.toLowerCase())) localId = cand;
          }
        }
        if (localId) result.user_id = localId;
      }
    }

    // Fallback: if LLM didn't extract user_id, try local regex that accepts alphabetic-only IDs too
    if (!result.user_id) {
      let localId = null;
      // Labeled forms
      const labeled = message.match(/(?:user\s*id|id|username|user|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
      if (labeled) localId = labeled[1];
      // Standalone token (short message replies)
      if (!localId && (message.trim().length <= 40)) {
        const token = message.match(/^([A-Za-z0-9_\-]{3,20})(?=\s|$)/);
        if (token) {
          const cand = token[1];
          const looksAmount = /^(?:\d+[\.,]?\d*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?$/i.test(cand);
          const hasLetter = /[A-Za-z]/.test(cand);
          const stop = new Set(['depo','deposit','cek','check','sudah','udah','belum','blm','masuk','woi','woy','gua','gw','saya','aku','bosku','halo','hai','hello','hi']);
          // Accept as ID only if it contains a letter, not amount-like, and not a stopword/common slang
          if (!looksAmount && hasLetter && !stop.has(cand.toLowerCase())) localId = cand;
        }
      }
      if (localId) {
        result.user_id = localId;
      }
    }

    // Mark deposit inquiry active if detected
    if (result.is_deposit_query) {
      chatState.deposit_inquiry_active = true;
    }

    // If it's not a deposit query and we're not already in a deposit conversation, ignore it.
    if (!result.is_deposit_query && !inDepositConversation) {
      return null;
    }

    // Update state with any newly extracted info
    if (result.user_id) {
      // Do not accept amount-like tokens as user IDs
      const looksAmountId = /^(?:\d+[\.,]?\d*)\s*(k|rb|ribu|jt|juta|m|million|thousand)?$/i.test(String(result.user_id).trim());
      const hasLetterId = /[A-Za-z]/.test(String(result.user_id));
      if (!looksAmountId && hasLetterId) {
        chatState.deposit_user_id = result.user_id;
      }
    }
    if (result.amount) {
      chatState.deposit_amount = result.amount;
    }

  // Never reply here; unified flow will handle messaging.
  return null; // Fallback

  } catch (error) {
    console.error('Error in handleDepositQuery:', error);
    return null; // Return null on error to avoid breaking the bot
  }
}

// Handle account change requests
async function handleAccountChangeRequest(message, chatState) {
  const text = message.toLowerCase();
  const chatId = chatState.chatId;
  
  // Check if this is an initial account change request
  const isAccountChangeRequest = /(ganti|ubah|tukar|perbarui|update|change|switch)\s+(rekening|akun|account)/i.test(text);
  
  // If user is already in account change flow or this is a new request
  if (chatState.accountChangeFlow || isAccountChangeRequest) {
    if (!chatState.accountChangeFlow) {
      // First time in account change flow
      chatState.accountChangeFlow = {
        step: 'ask_user_id',
        originalRequest: message
      };
      return 'Baik, untuk membantu Anda mengganti rekening, saya membutuhkan User ID Anda terlebih dahulu.\n\nSilakan berikan User ID Anda: (contoh: user123)';
    }
    
    // Handle user's response in account change flow
    const flow = chatState.accountChangeFlow;
    
    if (flow.step === 'ask_user_id') {
      // Extract user ID from message
      const userIdMatch = text.match(/^(?:user\s*id[:\s]*)?([a-z0-9_\-]{3,20})$/i) || 
                         text.match(/([a-z0-9_\-]{3,20})/i);
      
      if (userIdMatch) {
        const userId = userIdMatch[1];
        flow.userId = userId;
        flow.step = 'confirm_support';
        return `Ok, terima kasih. Mohon tunggu sebentar ya...`;
      } else {
        return 'Mohon maaf, format User ID tidak valid. User ID harus terdiri dari 3-20 karakter (huruf dan/atau angka).\n\nSilakan masukkan User ID Anda:';
      }
    } else if (flow.step === 'confirm_support') {
      if (/ya|y|sure|ok|oke|lanjut|yes/i.test(text)) {
        // Reset the flow after confirmation
        delete chatState.accountChangeFlow;
        return 'Ok, terima kasih. Tim kami akan segera memproses permintaan Anda.';
      } else if (/tidak|no|batal|cancel/i.test(text)) {
        delete chatState.accountChangeFlow;
        return 'Baik, proses pergantian rekening dibatalkan. Jika ada yang bisa saya bantu lagi, jangan ragu untuk bertanya.';
      } else {
        return 'Mohon konfirmasi, apakah Anda ingin diarahkan ke halaman dukungan untuk melanjutkan proses pergantian rekening? (Ya/Tidak)';
      }
    }
  }
  
  return null;
}

// Get Template Response
async function getTemplateResponse(context, messageText, chatId, messageId) {
  const chatState = getChatState(chatId || context.chatId || 'default');
  const text = messageText.toLowerCase();
  const t = (_en, id) => id; // Helper for Indonesian-only text
  // RTP and promotions templates removed; rely on prompt-based flow
  
  const isID = true; // Indonesian-only
  
  // Check for account change requests
  const accountChangeResponse = await handleAccountChangeRequest(messageText, chatState);
  if (accountChangeResponse) {
    return accountChangeResponse;
  }
  
  // Legacy deposit follow-up prompts removed to align with policy:
  // Only ask for User ID; amount is optional and handled by the unified depositState flow below.

  // Template messages
  // Build dynamic welcome including group/brand
  const welcomeMsg = await buildWelcomeMessage(chatId);
  const withdrawHelp = t(
    "For withdrawal help, please follow these steps:\n\n" +
      "1. Ensure you have sufficient balance\n" +
      "2. Go to 'Withdraw' or 'Tarik Dana' menu\n" +
      "3. Select bank and enter withdrawal amount\n" +
      "4. Verify your account details\n" +
      "5. Confirm withdrawal\n\n" +
      "Withdrawals are usually processed within 1-5 minutes. If you encounter any issues, please contact our CS.",
    "Untuk bantuan penarikan, silakan ikuti langkah berikut:\n\n" +
      "1. Pastikan saldo mencukupi\n" +
      "2. Masuk ke menu 'Withdraw' atau 'Tarik Dana'\n" +
      "3. Pilih bank dan masukkan nominal penarikan\n" +
      "4. Periksa kembali data rekening Anda\n" +
      "5. Konfirmasi penarikan\n\n" +
      "Penarikan biasanya diproses 1-5 menit. Jika ada kendala, hubungi CS kami."
  );
  const depositHelp = t(
    "For deposit help, please follow these steps:\n\n" +
      "1. Go to 'Deposit' or 'Top Up' menu\n" +
      "2. Select your preferred payment method\n" +
      "3. Enter deposit amount and follow payment instructions\n" +
      "4. Make payment with the exact amount shown\n" +
      "5. Funds will be automatically credited after payment verification\n\n" +
      "If deposit is not credited after 5 minutes, please contact our CS with your payment proof.",
    "Untuk bantuan deposit, silakan ikuti langkah berikut:\n\n" +
      "1. Masuk ke menu 'Deposit' atau 'Top Up'\n" +
      "2. Pilih metode pembayaran yang diinginkan\n" +
      "3. Masukkan nominal dan ikuti instruksi pembayaran\n" +
      "4. Bayar sesuai nominal yang tertera\n" +
      "5. Dana akan masuk otomatis setelah verifikasi\n\n" +
      "Jika deposit belum masuk setelah 5 menit, hubungi CS dan kirim bukti transfer."
  );
  const losingEncouragement = t(
    "Hey boss! 😊 I totally understand how frustrating it can be when luck isn't on your side today. But remember, every great player goes through rough patches! Take a break, clear your mind, and come back fresh later. The tables will still be here waiting for you! 🎰 Sometimes stepping away for a bit is the best strategy. You got this! 💪",
    "Santai bosku! 😊 Saya paham rasanya kalau kurang hoki hari ini. Tapi ingat, semua pemain hebat juga pernah ngalamin hal yang sama! Coba istirahat sebentar dulu, tenangkan pikiran, nanti lanjut lagi ya. 🎰 Kadang rehat sebentar adalah strategi terbaik. Semangat, bosku! 💪"
  );
  
  // Warning messages for off-topic conversations
  const warningMessages = [
    "Halo! Ada yang bisa saya bantu terkait layanan kami?",
    "Hai bosku! Ada yang bisa saya bantu seputar platform kami?",
    "Halo! Saya siap bantu pertanyaan apa pun tentang layanan kami. Apa yang bisa saya bantu?"
  ];



  // Game list detection moved to prompt-based flow (detectIntentsLLM)

  // Handle all deposit-related queries with the new LLM function
  const depositResponse = await handleDepositQuery(messageText, chatState);
  if (depositResponse) {
    console.log('🤖 LLM handled deposit query.');
    return depositResponse;
  }



  // Flexible keyword sets for each intent
  // Removed keyword arrays and matcher; rely on LLM-based flows

  // Check for gambling frustration and losing keywords
  const frustrationKeywords = ['mad', 'angry', 'frustrated', 'upset', 'annoyed', 'pissed', 'marah', 'kesal', 'jengkel', 'sebel'];
  const losingKeywords = ['lose', 'losing', 'lost', 'lsoe', 'kalah', 'rugi', 'loss', 'always lose', 'keep losing', 'never win', 'selalu kalah', 'terus kalah', 'tidak pernah menang'];
  
  const isFrustrated = frustrationKeywords.some(keyword => text.includes(keyword));
  const isLosing = losingKeywords.some(keyword => text.includes(keyword));
  
  // Check if this is gambling-related frustration (not off-topic)
  const offTopicDetection = detectOffTopic(messageText);
  // Politics are strictly off-topic
  if (/(politik|politics|presiden|parlemen|pemilu|election|senate|congress|partai|democrat|republican|golkar|pdi|nasdem|pkb|pks)/i.test(messageText)) {
    offTopicDetection.isOffTopic = true;
  }
  if ((isFrustrated || isLosing) && !offTopicDetection.isOffTopic) {
    console.log(`🎰 Encouraging response triggered for: "${messageText}"`);
    return losingEncouragement;
  }

  // Smart off-topic detection
  if (offTopicDetection.isOffTopic) {
    console.log(`💬 Smart detection: ${offTopicDetection.type} detected (score: ${offTopicDetection.score})`);
    // The chat state is already initialized, so we can use it to track warnings.
    chatState.offTopicWarningCount = (chatState.offTopicWarningCount || 0) + 1;
    
    // Get a friendly response that answers the question if possible
  const response = await getWarningMessage(chatState, context.language);
    
    // ... (rest of the code remains the same)
    // Add a gentle nudge back to casino topics
    const brand = await getBrandNameForChat(chatId);
    const casinoNudges = [
      `\n\nNgomong-ngomong, ${brand} punya banyak permainan seru yang mungkin Anda suka!`,
      `\n\nOmong-omong, sudah coba game slot terbaru kami di ${brand}?`,
      `\n\nSaya juga siap bantu kalau ada pertanyaan tentang permainan atau layanan ${brand}!`
    ];
    const randomNudge = casinoNudges[Math.floor(Math.random() * casinoNudges.length)];
    
    return response + randomNudge;
  }



  // Game list detection handled earlier by detectIntentsLLM

  // First message - welcome (only if not already sent)
  if (context.conversationHistory.length === 1 && !chatState.hasSentWelcome) {
    chatState.hasSentWelcome = true; // Mark as sent
    console.log(`👋 Sending welcome message to chat ${chatId} (first time)`);
    return welcomeMsg;
  }

  // Handle greetings properly (only if welcome not already sent)
  if ((text.includes('hello') || text.includes('hi') || text.includes('halo') || text.includes('hai')) && !chatState.hasSentWelcome) {
    chatState.hasSentWelcome = true; // Mark as sent
    console.log(`👋 Sending welcome message to chat ${chatId} (greeting)`);
    return welcomeMsg;
  }
  
  // If welcome already sent and user sends another greeting, give a different response
  if ((text.includes('hello') || text.includes('hi') || text.includes('halo') || text.includes('hai')) && chatState.hasSentWelcome) {
    // Always prefer the saved welcome message from group settings (or global fallback)
    // so greetings consistently use the configured welcome text rather than a generic reply.
    try {
      console.log(`👋 Greeting received (already welcomed) - returning configured welcome for chat ${chatId}`);
      return welcomeMsg;
    } catch (e) {
      return 'Ada yang bisa saya bantu? 😊';
    }
  }

  // Withdraw/Deposit/Password/Register keyword flows removed. LLM and specialized flows will handle these.

  // Password reset & account access: ask ONLY for User ID, acknowledge, and silently ping
  if (!chatState.passwordResetFlow) chatState.passwordResetFlow = { active: false, userId: null };
  const isPwdReset = isPasswordResetInquiry(messageText);
  if (isPwdReset || chatState.passwordResetFlow.active) {
    chatState.passwordResetFlow.active = true;
    // Try to extract user id
    if (!chatState.passwordResetFlow.userId) {
      const candidate = extractUserIdFromText(messageText) || (messageText.trim().length <= 40 ? extractUserIdFromText(messageText) : null);
      if (candidate) chatState.passwordResetFlow.userId = candidate.trim();
    }
    if (!chatState.passwordResetFlow.userId) {
      const ask = 'Baik bosku, untuk bantu reset password boleh minta User ID-nya?';
      context.conversationHistory.push({ message: ask, timestamp: Date.now(), type: 'agent' });
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return ask;
    }
    // Ack first, then ping silently (once), then reset
    const uid = chatState.passwordResetFlow.userId;
    const ack = `Siap bosku, saya bantu ajukan reset password untuk User ID. Mohon ditunggu sebentar ya.`;
    // send visible acknowledgement to user
    const sentAck = await sendAgentReply(chatId, ack, messageText, messageId, { forceRaw: true });
    // Ensure we ping only once per password_reset flow (do not reveal to user)
    try {
      await createAndPingSupport(chatState, 'password_reset', { chatId, userId: uid, language: 'id', message: messageText }).catch(() => {});
    } catch (_) {}
    chatState.passwordResetFlow = { active: false, userId: null };
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return sentAck;
  }

  // Account access issues (locked/suspended/hacked etc.): ask ONLY for User ID; silently ping
  if (!chatState.accountAccessFlow) chatState.accountAccessFlow = { active: false, userId: null };
  const isAccessIssue = /(akun|account|login|masuk)\s+(terkunci|diblokir|suspended|banned|terblokir|error|gagal)|\b(hacked|diretas)\b/i.test(messageText);
  if (isAccessIssue || chatState.accountAccessFlow.active) {
    chatState.accountAccessFlow.active = true;
    if (!chatState.accountAccessFlow.userId) {
      const candidate = extractUserIdFromText(messageText) || (messageText.trim().length <= 40 ? extractUserIdFromText(messageText) : null);
      if (candidate) chatState.accountAccessFlow.userId = candidate.trim();
    }
    if (!chatState.accountAccessFlow.userId) {
      const ask = 'Baik bosku, untuk bantu akses akun boleh minta User ID-nya?';
      context.conversationHistory.push({ message: ask, timestamp: Date.now(), type: 'agent' });
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return ask;
    }
  const uid = chatState.accountAccessFlow.userId;
  const ack = `Siap bosku, kami bantu cek akses akun untuk User ID. Mohon ditunggu sebentar ya.`;
  const sentAckAcc = await sendAgentReply(chatId, ack, messageText, messageId);
  try { await createAndPingSupport(chatState, 'account_access', { chatId, userId: uid, language: 'id', message: messageText }).catch(() => {}); } catch(_) {}
    chatState.accountAccessFlow = { active: false, userId: null };
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return sentAckAcc;
  }

  // Check for order-related questions that are off-topic for this platform
  if (text.includes('orders') || text.includes('order') || text.includes('pesanan') || text.includes('check my order') || text.includes('cek pesanan')) {
    const chatState = getChatState(chatId);
    chatState.offTopicWarningCount++;
  return await getWarningMessage(chatState, context.language);
  }

  // Check for identity questions that are off-topic
  if (text.includes('who are you') || text.includes('what are you') || text.includes('are you human') || text.includes('are you real') || text.includes('are you a bot') || text.includes('are you ai')) {
    const chatState = getChatState(chatId);
    chatState.offTopicWarningCount++;
  return await getWarningMessage(chatState, context.language);
  }

  // Check for capability questions that are off-topic
  if (text.includes('what can i ask') || text.includes('what can you do') || text.includes('apa yang bisa saya tanya') || text.includes('apa yang bisa kamu lakukan')) {
    const chatState = getChatState(chatId);
    chatState.offTopicWarningCount++;
  return await getWarningMessage(chatState, context.language);
  }

  // Check for clearly off-topic entertainment references (but allow casino/game queries)
  if (text.includes('fortnite') || text.includes('play') || text.includes('playing') ||
      text.includes('love') || text.includes('like') || text.includes('hate') || text.includes('fun') || text.includes('boring')) {
    const chatState = getChatState(chatId);
    chatState.offTopicWarningCount++;
    // Do not treat generic 'game' or 'games' as off-topic here so that casino/game intents
    // can be handled by the dedicated intent/LLM flows elsewhere in the code.
    return await getWarningMessage(chatState, context.language);
  }

  // Check for very short responses that are likely off-topic (but allow greetings and common words)
  // DISABLED: This was too aggressive and caught legitimate short messages like "bank" or "helo"
  // Let the AI handle short messages naturally instead of immediately flagging as off-topic
  /*
  if (messageText.length <= 10 && !text.includes('help') && !text.includes('deposit') && !text.includes('withdraw') && 
      !text.includes('password') && !text.includes('register') && !text.includes('yes') && !text.includes('no') && 
      !text.includes('ok') && !text.includes('okay') && !text.includes('thanks') && !text.includes('thank you') &&
      !text.includes('hello') && !text.includes('hi') && !text.includes('halo') && !text.includes('hai') &&
      !text.includes('bank') && !text.includes('promo') && !text.includes('rtp')) {
    const chatState = getChatState(chatId);
    chatState.offTopicWarningCount++;
    return await getWarningMessage(chatState, context.language);
  }
  */

  // Default for unknown issues - return null instead of wait message
    // If AI is enabled, attempt a safe, governed LLM reply that tries to interpret
    // the user's message and provide a helpful response while respecting group
    // custom rules and off-topic constraints. This keeps existing flows intact
    // but makes the bot more 'intelliagent' for ambiguous messages.
    try {
      if (aiClient && aiClient.isEnabled && aiClient.isEnabled()) {
        // Respect group-level allowLlmFallback flag
        try {
          const aiCfg = await getGroupAiSettingsForChat(chatId);
          if (aiCfg && aiCfg.allowLlmFallback === false) return null;
        } catch (_) {}

        // Build a lightweight, constrained prompt to generate a short helpful reply
        const brand = await getBrandNameForChat(chatId);
        const system = `You are a concise, helpful customer support assistant for ${brand}. The user message is below. Provide a short, factual reply in Indonesian that helps the user or asks a single clarifying question if needed. Preserve emojis and avoid inventing facts. Keep it under 2 sentences.`;
        const userPrompt = `User message:\n"""${messageText}\"\"\"\n
  If the message is off-topic (politics, romance, or unrelated entertainment), give a polite redirect to casino-related help instead.`;

        const completion = await aiClient.chatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          max_tokens: 120
        }, await buildMeta(chatId, 'gc.aiAssistFallback', { injectGroupRules: true })).catch(() => null);

        const reply = completion?.choices?.[0]?.message?.content?.trim();
        if (reply && reply.length > 0) {
          // Ensure we don't repeat identical recent replies
          if (!wasMessageSentInChat(chatId, reply)) return reply;
        }
      }
    } catch (e) {
      console.warn('aiAssistFallback failed:', e && e.message ? e.message : e);
    }

    return null;
}

// needsSupportPing function and support constants are now imported from handlers/intentDetection.js

// Rewrite a natural-language reply to follow a group's Custom Rules/Example tone
// - Skips JSON-looking outputs
// - Preserves formatting, URLs, numbers, and emojis
async function styleWithGroupCustomRules(chatId, text) {
  // Disabled: return input unchanged
  return String(text ?? '');
}

// Lightweight LLM rewrite helper: take an existing assistant reply and ask the model
// to rewrite it to sound more natural / context-aware while preserving meaning.
// This is safe: on failure we fallback to the original text.
async function rewriteWithLlm(chatId, originalText, userMessage = '') {
  // Disabled: return original unchanged
  return originalText;
}

// Summarize a combined multi-part assistant reply into a single concise reply.
// This is intended for use when multiple assistant replies are concatenated
// by the server combine-window. It preserves important numbers/emojis and
// does not invent facts. Falls back to the original combined text on error.
// opts: { maxSentences: number }
async function summarizeCombined(chatId, combinedText, userMessage = '', opts = {}) {
  try {
    if (DISABLE_AI_REPROCESSING) return combinedText;
    if (!aiClient || !aiClient.isEnabled || !aiClient.isEnabled()) return combinedText;
    if (!combinedText || String(combinedText).trim().length === 0) return combinedText;

    // If the combined text looks like a formatted list (numbered or bulleted)
    // or contains clear promo headers, skip summarization to preserve list format.
    try {
      const lines = String(combinedText || '').split(/\r?\n/).map(l => String(l || '').trim()).filter(Boolean);
      const hasNumbered = lines.some(l => /^\d+\.\s+/.test(l));
      const hasBullet = lines.some(l => /^[-*•\u2022]\s+/.test(l));
      const hasPromoHeader = lines.some(l => /promo|bonus|🎉|🎁|Promo|Bonus/i.test(l));
      if (hasNumbered || hasBullet || hasPromoHeader) {
        // Preserve original formatting (do not summarize) for lists and promo blocks
        return combinedText;
      }
    } catch (_) {
      // non-fatal: fall through to summarization
    }

    // Respect group settings: allowCombinedSummarize (if explicitly false, skip)
    try {
      const aiCfg = await getGroupAiSettingsForChat(chatId);
      if (aiCfg && aiCfg.allowCombinedSummarize === false) return combinedText;
    } catch (_) {}

    const brand = await getBrandNameForChat(chatId);
  const maxSentences = (opts && Number(opts.maxSentences)) ? Math.max(1, Number(opts.maxSentences)) : 1;
    const sentenceReq = maxSentences === 1 ? 'exactly one concise sentence' : `up to ${maxSentences} short sentences, preferably one sentence per original point`;
    const preserveAll = opts && opts.preserveAll;
    let system;
    if (preserveAll) {
      system = `You are a helpful human support assistant for ${brand}. Rewrite the combined assistant messages below into a single coherent reply that includes ALL factual information and details present in the input (names, bank lists, numeric values, promo codes, URLs, emojis). Do NOT omit or compress factual items. Keep the reply natural and human-like; output up to ${maxSentences} short sentences that together include every factual element from the combined text. Do NOT invent facts or modify numbers. Output ONLY the reply.`;
    } else {
      system = `You are a concise, friendly customer support assistant for ${brand}. Summarize the combined assistant messages below into ${sentenceReq} that read like a natural human reply. Preserve numbers, emojis, URLs and any important values. Do NOT invent facts or add or change any numeric values. Do NOT output headings, lists, or metadata — output only the reply.`;
    }

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `User message: "${String(userMessage || '').trim()}"` },
      { role: 'assistant', content: String(combinedText) }
    ];

  const resp = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages,
      temperature: preserveAll ? 0.1 : 0.18,
      max_tokens: Math.min(1200, Math.max(200, Math.ceil(String(combinedText).length / (preserveAll ? 2 : 6))))
  }, await buildMeta(chatId, 'gc.combinedSummarize', { injectGroupRules: true }));

  const out = resp?.choices?.[0]?.message?.content;
    if (out && String(out).trim().length > 0) return String(out).trim();
    return combinedText;
  } catch (e) {
    // Keep only a concise warning in case of failure
    console.warn('Combined summarizer failed:', e && e.message ? e.message : e);
    return combinedText;
  }
}

// Centralized finalizer for agent replies. It optionally rewrites replies via LLM,
// records them in conversation history, updates chat state, and marks them sent.
// Skips rewriting for raw JSON-like payloads or when LLM is disabled or group disallows it.
async function sendAgentReply(chatId, reply, userMessage = '', messageId = null, opts = {}) {
  try {
    if (!reply && reply !== '' ) return reply;
    const chatStateLocal = getChatState(chatId);
    const contextLocal = chatStateLocal.context || {};
    // Reset last generated reply before crafting a new one
    chatStateLocal.lastGeneratedReply = null;

    // Best-effort: show typing indicator while preparing/sending this reply
    const _showTyping = opts.showTyping !== false;
    if (_showTyping && typeof setTyping === 'function') {
      try { await setTyping({ chat_id: chatId }, true); } catch (e) { console.warn('setTyping ON failed:', e && e.message ? e.message : e); }
    }

    // Rewriter disabled: always record and send the reply as-is
    const final = reply;

    // Save and mark
    contextLocal.conversationHistory.push({ message: final, timestamp: Date.now(), type: 'agent' });
    if (messageId) chatStateLocal.lastProcessedMessageId = messageId;
    chatStateLocal.lastResponseTime = Date.now();
    markMessageSentInChat(chatId, final);
    chatStateLocal.lastGeneratedReply = final;

    // If this reply is an explicit request for the user's ID, proactively
    // (1) send a short visible acknowledgement to the user, (2) silently ping
    // support so agents see the request, and (3) mark the chat as needing human
    // attention so the bot stops replying until an agent clears it.
    try {
      const askUserIdRegex = /\b(minta\s+user\s*id|user\s*id\-?nya|boleh\s+minta\s+user\s*id|boleh\s+minta\s+id|minta\s+id\b|user id\s*nya)\b/i;
      if (askUserIdRegex.test(final)) {
        // Visible acknowledgement message (sent after the ask)
        const ackMsg = 'Siap bosku, saya sudah minta tim CS untuk bantu. Mohon ditunggu sebentar ya.';
        try {
          // Send the ack as a raw message to avoid re-triggering rewrites
          await sendAgentReply(chatId, ackMsg, userMessage, null, { forceRaw: true }).catch(() => {});
        } catch (_) {}

        // Prepare ping arguments and ping support once
        try {
          const pingArgs = {
            type: 'awaiting_user_id',
            chatId,
            userId: (contextLocal && contextLocal.userId) ? contextLocal.userId : 'anonymous',
            language: (contextLocal && contextLocal.detectedLanguage) ? contextLocal.detectedLanguage : 'id',
            message: final
          };
          const pingKey = `awaiting_user_id`;
          const pingOk = await pingSupportOnce(chatStateLocal, pingKey, pingArgs).catch(() => false);
          if (pingOk) {
            // Mark in-memory so current process respects the human-needed guard immediately
            try { chatStateLocal.__needsHuman = true; } catch (_) {}
            // Persist the minimal flag for other processes
            try {
              if (typeof updateChatState === 'function') {
                const dbi = await getDb();
                const newState = Object.assign({}, chatStateLocal || {});
                newState.__needsHuman = true;
                await updateChatState(dbi, String(chatId), newState).catch(() => {});
              }
            } catch (_) {}
            try { if (typeof setChatStatus === 'function') await setChatStatus(String(chatId), 'needs_human'); } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (e) {
      // non-fatal
    }

    // Publish to simple-updates/SSE feed if available (non-blocking)
    try {
      if (global && typeof global.__notifyNewMessage === 'function') {
        // Provide a structured message object so listeners get consistent fields
        const payloadMessage = {
          id: messageId || `msg_${Date.now()}`,
          message: final,
          isFromAI: true,
          createdAt: new Date().toISOString()
        };
        setImmediate(() => {
          try {
            global.__notifyNewMessage(chatId, payloadMessage, true);
          } catch (e) {
            console.warn('Failed to publish simple-update in sendAgentReply for chat', chatId, e && e.message ? e.message : e);
          }
        });
      }
    } catch (e) {
      // swallow notifier errors
    }

      // If this reply looks like an acknowledgement for an inquiry, ping human support once.
      try {
        const ackRegex = /\b(mohon ditunggu|mohon ditunggu sebentar|please wait|we'll forward|we will forward|i will forward|we've forwarded|kami teruskan|kami teruskan ke tim|saya akan cek|saya akan cek deposit|sedang kami proses|sedang kami cek|teruskan ke tim)\b/i;
        const replyText = String(final || '');
        if (ackRegex.test(replyText)) {
          try {
            // Determine ping type: prefer explicit flow flags from chat state, else use keyword detection
            let pingType = 'ack';
            try {
              const ds = chatStateLocal.depositState || {};
              if (ds && ds.active) pingType = 'deposit';
              else if (chatStateLocal && chatStateLocal.turnoverFlow && chatStateLocal.turnoverFlow.active) pingType = 'turnover';
              else if (chatStateLocal && chatStateLocal.withdrawalState && chatStateLocal.withdrawalState.active) pingType = 'withdraw';
              else if (/\b(password|kata sandi|reset password|reset kata sandi)\b/i.test(replyText)) pingType = 'password_reset';
              else if (/\b(withdraw|withdrawal|penarikan)\b/i.test(replyText)) pingType = 'withdraw';
              else if (/\b(deposit|deposito|min depo|min deposit|batas deposit|minimal deposit)\b/i.test(replyText)) pingType = 'deposit';
            } catch (_) {}

            const pingKey = `ack:${pingType}`; // stable per-chat per-flow key
            const pingArgs = {
              type: pingType,
              chatId,
              userId: (contextLocal && contextLocal.userId) ? contextLocal.userId : 'anonymous',
              language: contextLocal && contextLocal.detectedLanguage ? contextLocal.detectedLanguage : 'id',
              message: replyText
            };

            const pingOk = await pingSupportOnce(chatStateLocal, pingKey, pingArgs).catch(() => false);
            if (pingOk) {
              try {
                // Mark in-memory state immediately so this process stops generating AI replies
                try { chatStateLocal.__needsHuman = true; } catch (_) {}
                // Persist a lightweight flag so other server processes know AI should not reply
                if (typeof updateChatState === 'function') {
                  try {
                    const dbi = await getDb();
                    const newState = Object.assign({}, chatStateLocal || {});
                    newState.__needsHuman = true;
                    await updateChatState(dbi, String(chatId), newState).catch(() => {});
                  } catch (_) {}
                }
                if (typeof setChatStatus === 'function') {
                  try { await setChatStatus(String(chatId), 'needs_human'); } catch (_) {}
                }
              } catch (_) {}
            }
          } catch (e) {
            // non-fatal
          }
        }
      } catch (_) {}

    return final;
  } catch (e) {
    console.warn('sendAgentReply error:', e && e.message ? e.message : e);
    // Fallback: still push original reply
    try {
      const st = getChatState(chatId);
      st.context.conversationHistory.push({ message: reply, timestamp: Date.now(), type: 'agent' });
      markMessageSentInChat(chatId, reply);
    } catch (_) {}
    return reply;
  } finally {
    // Clear typing indicator (best-effort)
    try {
      if (typeof setTyping === 'function') await setTyping({ chat_id: chatId }, false);
    } catch (e) {
      // non-fatal
    }
  }
}

// Get customer service response with enhanced smart detection
async function getCustomerServiceResponse(chatId, userMessage, messageId) {
  const chatState = getChatState(chatId);
  // Helper: summarize recent conversation into a short memory blob
  async function updateConversationMemory(chatStateObj) {
    try {
      if (!chatStateObj) return null;
      const ctx = chatStateObj.context || {};
      const hist = Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory.slice(-12) : [];
      // If not enough history, skip summarization
      if (!hist || hist.length < 4) return null;
      // Avoid frequent summarization: only update if missing or older than 10 minutes
      const mem = chatStateObj.memory || {};
      if (mem.updatedAt && (Date.now() - mem.updatedAt) < (10 * 60 * 1000)) return mem.summary || null;

      // Build compact transcript for summarization
      const transcript = hist.map(h => `${h.type === 'user' ? 'User' : 'Agent'}: ${String(h.message || '').replace(/\s+/g,' ').trim()}`).join('\n');
      const sys = `You are a concise summarizer for a customer support chat. Produce up to 6 short bullet points summarizing: (1) user's intent(s), (2) any provided userId or amounts, (3) unresolved actions for support to take, and (4) tone/language. Keep it short and factual.`;
      const resp = await aiClient.chatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: transcript }
        ],
        temperature: 0.0,
        max_tokens: 180
  }, await buildMeta(chatStateObj.chatId || chatId, 'gc.summarize')).catch(() => null);
      const summary = resp?.choices?.[0]?.message?.content?.trim() || null;
      chatStateObj.memory = chatStateObj.memory || {};
      chatStateObj.memory.summary = summary;
      chatStateObj.memory.updatedAt = Date.now();
      return summary;
    } catch (e) {
      return null;
    }
  }
  try {
    // If chat is marked as needing human support, do not generate AI replies.
    if (chatState && (chatState.__needsHuman || (chatState.__autoAi && chatState.__autoAi.lockedScope === 'human') )) {
      // Return null to indicate no AI reply should be sent; calling code will handle persistence.
  // suppressed detailed debug to reduce noise
      return null;
    }
  } catch (_) {}
  const context = chatState.context;
  const msgNorm = (userMessage || '').toString();
  chatState.lastGeneratedReply = null;

  // Enhanced language detection
  const detectedLanguage = detectLanguage(msgNorm);
  context.detectedLanguage = detectedLanguage;
  // Push the incoming user message into conversation history BEFORE analysis so
  // follow-up detectors can see the latest user turn and correctly set
  // followUpInfo.refersToPrevious when a short confirmation/amount is sent.
  try {
    if (!context.conversationHistory) context.conversationHistory = [];
    context.conversationHistory.push({ message: msgNorm, timestamp: Date.now(), type: 'user' });
    if (context.conversationHistory.length > 10) {
      context.conversationHistory = context.conversationHistory.slice(-10);
    }
  } catch (e) {
    console.warn('Non-fatal: failed to push user message into conversationHistory:', e && e.message ? e.message : e);
  }

  // Group-aware JSON reply engine (strict aiSettings + prompt)
  try {
  const { buildGroupAwareReply } = require('./ai/groupReply');
  // Pass recent conversation history so the group-reply engine can use memory
  const replyJson = await buildGroupAwareReply(chatId, userMessage, { chat_id: chatId, chat: { group_id: await getGroupIdForChat(chatId).catch(()=>null), conversationHistory: context.conversationHistory || [] } });
    // Persist assistant turn and mark sent using reply text
    const replyText = String(replyJson && replyJson.reply ? replyJson.reply : '').trim();
    if (replyText) {
      try {
        context.conversationHistory.push({ message: replyText, timestamp: Date.now(), type: 'agent' });
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        markMessageSentInChat(chatId, replyText);
      } catch (_) {}
    }
    // Return JSON per contract so server can decide how to send
    return replyJson;
  } catch (_) {
    // fall through to legacy logic if new engine fails (should be rare)
  }

  // ==== SMART RESPONSE ENHANCEMENTS ====
  // Analyze conversation context for intelligent responses
  const contextAnalysis = analyzeConversationContext(chatState);
  context.topic = contextAnalysis.topic; // Store current topic
  // Detect intents early so operation flows take precedence over smart responses
  let intents = null;
  try {
    intents = await detectIntentsLLM(msgNorm, chatId);
  } catch (e) {
    console.warn('Early intent detection failed:', e && e.message ? e.message : e);
    intents = null;
  }
  
  // Detect if this is a follow-up message
  const followUpInfo = detectFollowUp(msgNorm, contextAnalysis);

  // EARLY HANDLER: If a deposit flow is already active (we previously asked for
  // User ID), handle the follow-up here BEFORE running smartResponse so that
  // a plain User ID reply doesn't get consumed by the LLM/smart response and
  // we can immediately acknowledge + silently ping support.
  try {
    const depositStateEarly = chatState.depositState || {};
    const isStartingDepositQueryEarly = isDepositInquiry(msgNorm);
    if (isStartingDepositQueryEarly || depositStateEarly.active) {
      // Initialize on new inquiry
      if (isStartingDepositQueryEarly) {
        chatState.depositState = { active: true, userId: null, amount: null };
      }

      // Try to extract only user id using canonical extractor
      if (!chatState.depositState.userId) {
        try {
          const uid = extractUserId(userMessage);
          if (uid) chatState.depositState.userId = uid;
        } catch (_) {}
      }

      // If still missing user id, ask for it
      if (!chatState.depositState.userId) {
        const response = 'Boleh minta User ID-nya dulu bosku? 😊';
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        const sentAsk = await sendAgentReply(chatId, response, userMessage, messageId);
        return sentAsk;
      }

      // We have a user id — send acknowledgement first, then silently ping support
      const userId = chatState.depositState.userId;
      const confirmationMsg = `Baik, saya akan cek deposit untuk User ID: ${userId}. Mohon ditunggu sebentar.`;

  const sentConfEarly = await sendAgentReply(chatId, confirmationMsg, userMessage, messageId);
  try { await createAndPingSupport(chatState, 'deposit_check', { chatId, userId, amount: null, language: 'id', message: userMessage }).catch(() => {}); } catch(_) {}
      chatState.depositState = { active: false, userId: null, amount: null };
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return sentConfEarly;
    }
  } catch (e) {
    console.warn('Early deposit follow-up handler failed (non-fatal):', e && e.message ? e.message : e);
  }

  // Honor configured welcome message ALWAYS when the user sends a greeting.
  // This must run before smart responses so greeting is deterministic and
  // always uses the saved group/global welcome text.
  try {
    const greetingRegex = /^(\s)*(halo|hai|hello|hi|pagi|selamat pagi|selamat siang|selamat sore|selamat malam|malam)\b/i;
    if (greetingRegex.test(msgNorm)) {
      // Mark welcome as sent to avoid duplicate welcome flows
      chatState.hasSentWelcome = true;
      const welcome = await buildWelcomeMessage(chatId);
      try { console.log('[DEBUG] Greeting detected — returning configured welcome message for chat', chatId); } catch(_) {}
      // Send welcome as raw to avoid LLM rewriting/modification
      const sent = await sendAgentReply(chatId, welcome, userMessage, messageId, { forceRaw: true });
      return sent;
    }
  } catch (e) {
    // Non-fatal: continue to smart response if greeting handling fails
    console.warn('Non-fatal: greeting handling failed:', e && e.message ? e.message : e);
  }
  
  // Try to build a smart contextual response — run the generator for
  // all incoming messages (not only flagged follow-ups). If it returns
  // a response, prefer it and send to the user.
  try {
    // buildSmartResponse may be sync or async depending on implementation; ensure we handle both
    const maybeSmart = buildSmartResponse(msgNorm, contextAnalysis, followUpInfo);
    const smartResponse = await Promise.resolve(maybeSmart);
    const hasCriticalIntent = intents && (intents.is_deposit_query || intents.is_withdrawal_query || intents.is_turnover_query || intents.wants_transfer_to_agent);
    try {
      // Create a safe preview for logging (string/JSON/null)
      let preview = null;
      if (smartResponse == null) preview = null;
      else if (typeof smartResponse === 'string') preview = smartResponse.slice(0, 200);
      else {
        try { preview = JSON.stringify(smartResponse).slice(0, 200); } catch (_) { preview = String(smartResponse).slice(0, 200); }
      }
  // suppressed smartResponse preview logging
    } catch (_) {}

    // Allow smartResponse in two cases:
    // 1) No critical domain intent detected (normal behavior), or
    // 2) It is a follow-up (user confirming/adding amount) and the follow-up
    //    does NOT lack context (followUpInfo.missingContext === false).
    const allowSmartOnFollowUp = followUpInfo && followUpInfo.isFollowUp && !followUpInfo.missingContext;
    if (smartResponse && (!hasCriticalIntent || allowSmartOnFollowUp)) {
      try {
        const enhancedResponse = enhanceResponsePersonality(smartResponse, chatState);
        const sentEnhanced = await sendAgentReply(chatId, enhancedResponse, userMessage, messageId);
        return sentEnhanced;
      } catch (err) {
        console.warn('Smart response send failed (non-fatal):', err?.message || err);
      }
    }
  // suppressed buildSmartResponse empty debug
  } catch (e) {
    // Non-fatal: proceed to other flows
    console.warn('Smart response generation failed:', e && e.message ? e.message : e);
  }
  
  // Short-circuit: handle a common Indonesian FAQ phrase requested by the user
  try {
    const normalizedMsg = normalizeForMatch(msgNorm);
    if (normalizedMsg && normalizedMsg.includes('web apa si ini')) {
      const brand = await getBrandNameForChat(chatId);
      const canned = `Ini adalah ${brand}. Kami menyediakan layanan pelanggan dan permainan daring. Ada yang bisa saya bantu, bosku? 😊`;
  const sentCanned = await sendAgentReply(chatId, canned, userMessage, messageId);
  return sentCanned;
    }
  } catch (e) {
    // ignore and continue to normal flow
    console.warn('FAQ short-circuit failed:', e && e.message ? e.message : e);
  }
  // ==== END SMART RESPONSE ENHANCEMENTS ====

  // Handle multiple short messages arriving together (e.g., "banks. slots")
  try {
    const messageParts = String(msgNorm || '')
      .split(/[\n\r]+|[.!?]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (messageParts.length > 1) {
      const combinedResponses = [];
      const handledIntents = new Set();

      for (const part of messageParts) {
        if (!part) continue;

        if (!handledIntents.has('rtp') && isRtpRequest(part)) {
          const wantsRaw = /\b(json|raw)\b/i.test(part);
          if (wantsRaw) {
            try {
              const rawJson = await fs.readFile(RTP_FILE, 'utf8');
              combinedResponses.push(rawJson);
            } catch (e) {
              console.error('RTP handling error (multi-intent raw):', e?.message || e);
            }
          } else {
            try {
              const rtpMsg = await buildRtpResponse(chatId);
              combinedResponses.push(rtpMsg);
            } catch (e) {
              console.error('RTP handling error (multi-intent):', e?.message || e);
            }
          }
          handledIntents.add('rtp');
          continue;
        }

        if (!handledIntents.has('bank') && isBankInfoQuery(part)) {
          try {
            let bankMsg = await buildBankInfoResponse(chatId, getBrandNameForChat);
            bankMsg = addContextualTip(bankMsg, 'banking', context);
            bankMsg = enhanceResponsePersonality(bankMsg, chatState);
            combinedResponses.push(bankMsg);
            handledIntents.add('bank');
          } catch (e) {
            console.error('Bank info handling error (multi-intent):', e?.message || e);
          }
          continue;
        }

        if (!handledIntents.has('game') && /\b(slot|slots|game|gacor)\b/i.test(part)) {
          try {
            const gameListResponse = getGameListResponse();
            const gameMsg = `Daftar Permainan yang Tersedia dYZr

${gameListResponse}

Ada yang bisa saya bantu lagi bosku? dY~S`;
            const sentGame = await sendAgentReply(chatId, gameMsg, userMessage, messageId);
            combinedResponses.push(sentGame || gameMsg);
            handledIntents.add('game');
          } catch (e) {
            console.error('Game list handling error (multi-intent):', e?.message || e);
          }
          continue;
        }
      }

      if (combinedResponses.length > 0) {
        // Send each response as a separate agent message so the user sees
        // multiple replies instead of a single concatenated message.
        chatState.lastResponseType = 'multi_intent';
        let lastSent = null;
        for (const partResponse of combinedResponses) {
          try {
            // sendAgentReply may return the final text that was sent.
            lastSent = await sendAgentReply(chatId, partResponse, userMessage, messageId);
            // small pause to prevent rate issues when sending several messages in quick succession
            await new Promise((r) => setTimeout(r, 120));
          } catch (e) {
            console.warn('Failed to send multi-intent part (non-fatal):', e && e.message ? e.message : e);
          }
        }
        return lastSent;
      }
    }
  } catch (e) {
    console.warn('Multi-intent batch handling failed (non-fatal):', e?.message || e);
  }

  // Enhanced off-topic detection - handle early with polite redirection
  if (isOffTopicConversation(msgNorm)) {
    const offTopicResponse = detectedLanguage === 'en' 
      ? "I'm here to help with casino-related questions like deposits, withdrawals, promotions, and games! 🎰 How can I assist you today?"
      : "Saya di sini untuk bantu seputar kasino, deposit, penarikan, promo, dan game bosku! 🎰 Ada yang bisa dibantu?";
    const sent = await sendAgentReply(chatId, offTopicResponse, userMessage, messageId);
    return sent;
  }

  // Enhanced deposit inquiry detection with support ping
  if (isDepositInquiry(msgNorm)) {
    try {
      // Delegate to the canonical deposit handler so it initializes state,
      // asks for User ID when needed, and performs the silent support ping.
      const pingFn = async (args) => {
        try {
          // args.type is expected to be like 'deposit_check'
      await createAndPingSupport(chatState, args.type || 'deposit', args);
        } catch (_) {}
      };
      const result = await handleDepositInquiry(msgNorm, chatState, context, messageId, pingFn);
      if (result && result.shouldHandle) {
        const sent = await sendAgentReply(chatId, result.response, userMessage, messageId);
        try { chatState.lastResponseType = 'deposit'; } catch (_) {}
        // After acknowledging to the user, perform the silent ping if handler provided pingArgs
        try {
          if (result.pingArgs) {
            await createAndPingSupport(chatState, result.pingArgs.type || 'deposit_check', result.pingArgs).catch(() => {});
          }
        } catch (_) {}
        return sent;
      }
    } catch (e) {
      console.warn('Deposit short-circuit delegation failed (non-fatal):', e && e.message ? e.message : e);
    }
  }

  // Enhanced withdrawal inquiry detection with support ping
  if (isWithdrawalInquiry(msgNorm)) {
    try {
      // Delegate to the canonical withdrawal handler to initialize state and
      // perform pings when the flow advances.
      const pingFn = async (args) => {
  try { await createAndPingSupport(chatState, args.type || 'withdraw', args); } catch (_) {}
      };
      const result = await handleWithdrawalInquiry(msgNorm, chatState, context, messageId, pingFn);
      if (result && result.shouldHandle) {
        const sent = await sendAgentReply(chatId, result.response, userMessage, messageId);
        try { chatState.lastResponseType = 'withdrawal'; } catch (_) {}
        // Perform silent ping after acknowledgement if handler provided pingArgs
        try {
          if (result.pingArgs) {
            await createAndPingSupport(chatState, result.pingArgs.type || 'withdraw_check', result.pingArgs).catch(() => {});
          }
        } catch (_) {}
        return sent;
      }
    } catch (e) {
      console.warn('Withdrawal short-circuit delegation failed (non-fatal):', e && e.message ? e.message : e);
    }
  }

  // If previously asked for turnover User ID, accept a follow-up ID and confirm handoff
  if (chatState.turnoverFlow && chatState.turnoverFlow.active && !chatState.turnoverFlow.userId) {
    const uidFollow = extractUserIdFromText(userMessage);
    if (uidFollow) {
      const uid = uidFollow.trim();
      chatState.turnoverFlow.userId = uid;
      const thanks = detectedLanguage === 'en'
        ? 'Thank you! We\'ve forwarded your turnover request to our team. Please wait a moment.'
        : 'Terima kasih bosku, kami teruskan ke tim untuk cek turnover. Mohon ditunggu sebentar ya.';
      // Send acknowledgement to user first
      const sentThanks = await sendAgentReply(chatId, thanks, userMessage, messageId);
  try { await createAndPingSupport(chatState, 'turnover', { chatId, userId: uid, language: detectedLanguage, message: userMessage }).catch(() => {}); } catch(_) {}
      // Close the flow after ping
      chatState.turnoverFlow.active = false;
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return sentThanks;
    }
  }

  // Always handle turnover requests via human support (silent ping)
  if (isTurnoverInquiry(userMessage)) {
    try {
      // Try to grab a plausible user id from message
        const uidMatch = extractUserIdFromText(userMessage);
        const probableUserId = uidMatch || context.userId || null;
      // Ask for User ID if we don't have one yet. Do NOT ping support until
      // after the bot acknowledges the user-provided ID (or after user supplies it).
      if (!uidMatch && !context.userId) {
        const ask = detectedLanguage === 'en'
          ? 'For turnover checking, our CS team will help you. Could you please provide your User ID?'
          : 'Untuk pengecekan turnover, tim CS kami yang bantu. Boleh minta User ID-nya bosku?';
        chatState.turnoverFlow = { active: true, userId: null, requestedAt: Date.now() };
        context.conversationHistory.push({ message: ask, timestamp: Date.now(), type: 'agent' });
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        markMessageSentInChat(chatId, ask);
        return ask;
      }
      // If we do have a plausible user id (in the same message or via context),
      // ACK first, then silently ping support.
      const msg = 'Terima kasih bosku, kami teruskan ke tim untuk cek turnover. Mohon ditunggu sebentar ya.';
      const sentMsg = await sendAgentReply(chatId, msg, userMessage, messageId);
      try {
        const uidToPing = probableUserId || 'anonymous';
        // Acknowledgement already sent via sendAgentReply
          try { await createAndPingSupport(chatState, 'turnover', { chatId, userId: uidToPing, language: detectedLanguage, message: userMessage }).catch(() => {}); } catch(_) {}
      } catch (_) {}
      return sentMsg;
    } catch (_) {
      // even if ping fails, keep the UX consistent
      const msg = 'Terima kasih bosku, untuk turnover akan dibantu tim kami. Mohon ditunggu sebentar ya.';
      return msg;
    }
  }

  // Short-circuit: if user asks about promos, balas teks Indonesia FIRST (before unrestricted mode)
  // Hanya kirim raw JSON jika user sebut 'json' atau 'raw'.
  // EARLY HEURISTIC: handle explicit game/slot/rtp queries before promo handling
  try {
    const earlyLower = String(userMessage || '').toLowerCase();
    const explicitGame = /\b(game apa|slot|slots|gacor|rtp|which slots|slot apa|game apa)\b/i.test(earlyLower);
  // suppressed earlyGameHeuristic debug
    if (explicitGame) {
      // If it's an RTP-style request, prefer RTP response
      if (isRtpRequest(userMessage)) {
        try {
          const wantsRaw = /\b(json|raw)\b/i.test(userMessage || '');
          if (wantsRaw) {
            const rawJson = await fs.readFile(RTP_FILE, 'utf8');
            context.conversationHistory.push({ message: '[rtp.json sent as raw]', timestamp: Date.now(), type: 'agent' });
            chatState.lastProcessedMessageId = messageId;
            chatState.lastResponseTime = Date.now();
            return rawJson;
          }
          const rtpMsg = await buildRtpResponse(chatId);
          context.conversationHistory.push({ message: rtpMsg, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return rtpMsg;
        } catch (e) {
          console.error('RTP handling error (early heuristic):', e.message);
        }
      }

      // Otherwise, return the game list
      try {
        const gameListResponse = getGameListResponse();
        let response = `Daftar Permainan yang Tersedia 🎮\n\n${gameListResponse}\n\nAda yang bisa saya bantu lagi bosku? 😊`;
        context.conversationHistory.push({ message: response, timestamp: Date.now(), type: 'agent' });
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        return response;
      } catch (e) {
        console.error('Game list handling error (early heuristic):', e.message);
      }
    }
  } catch (e) {
    console.warn('Early game heuristic failed:', e && e.message ? e.message : e);
  }

  // suppressed isPromoRequest debug

  if (isPromoRequest(userMessage)) {
    try {
      const wantsRaw = /\b(json|raw)\b/i.test(userMessage || '');
      if (wantsRaw) {
        // Prefer group-specific promotions JSON when chat is mapped to a group
        try {
          const gid = await getGroupIdForChat(chatId);
          if (gid != null) {
            try {
              const groupPromos = await listGroupPromotions(Number(gid));
              if (Array.isArray(groupPromos) && groupPromos.length) {
                const payload = JSON.stringify({ promotions: groupPromos }, null, 2);
            context.isDiscussingPromos = true;
            // payload is raw JSON - bypass rewrite
            await sendAgentReply(chatId, payload, userMessage, messageId, { forceRaw: true });
            return payload;
              }
            } catch (e) {
              console.warn('Failed to load group promotions for raw JSON:', e && e.message ? e.message : e);
            }
          }
        } catch (_) {
          // ignore and fallback to global file
        }
        const rawJson = await fs.readFile(PROMOTIONS_FILE, 'utf8');
  context.isDiscussingPromos = true;
  await sendAgentReply(chatId, rawJson, userMessage, messageId, { forceRaw: true });
  return rawJson;
      }
      // Balas daftar promo ringkas (Indonesia)
      const promos = await getPromotionsForChat(chatId);
      let msg = formatPromotionsID(promos);
      
      // Add contextual tip and personality
      msg = addContextualTip(msg, 'promotion', context);
      msg = enhanceResponsePersonality(msg, chatState);
      
  context.isDiscussingPromos = true;
  chatState.lastResponseType = 'promotion';
  const sentPromos = await sendAgentReply(chatId, msg, userMessage, messageId);
  return sentPromos;
    } catch (e) {
      console.error('Promo handling error:', e.message);
      return 'Maaf bosku, terjadi kendala saat menampilkan promo. Coba lagi sebentar ya. 🙏';
    }
  }

  // Jika user minta detail/terms tentang promo, kirim detail Indonesia (tanpa perlu konteks sebelumnya)
  const wantsDetails = /\b(details?|more|info|terms?|conditions?|eligible|games?|syarat|ketentuan|cara\s*klaim|how\s*to\s*claim)\b/i.test(userMessage || '');
  if (wantsDetails) {
    try {
  const promos = await getPromotionsForChat(chatId);
      let detailsMsg = formatPromotionsDetailsListID(promos);
      
      // Add contextual tip and personality
      detailsMsg = addContextualTip(detailsMsg, 'promotion', context);
      detailsMsg = enhanceResponsePersonality(detailsMsg, chatState);
      
  chatState.lastResponseType = 'promotion';
  const sentDetails = await sendAgentReply(chatId, detailsMsg, userMessage, messageId);
  return sentDetails;
    } catch (e) {
      console.error('Promo details handling error:', e.message);
    }
  }

  // Short-circuit: if user asks about RTP, default to formatted text from rtp.json.
  // Only return raw JSON if user explicitly mentions 'json' or 'raw'.
  if (isRtpRequest(userMessage)) {
    try {
      const wantsRaw = /\b(json|raw)\b/i.test(userMessage || '');
      if (wantsRaw) {
        const rawJson = await fs.readFile(RTP_FILE, 'utf8');
  await sendAgentReply(chatId, rawJson, userMessage, messageId, { forceRaw: true });
  return rawJson;
      }
      // Prefer per-group RTP
      const link = await getRtpLinkForChat(chatId);
      const cfg = { rtpLink: link };
      const rtpMsg = `${formatRtpConfig(cfg)}\n\nButuh bantuan? Kasih tahu saya ya 😊`;
  const sentRtp = await sendAgentReply(chatId, rtpMsg, userMessage, messageId);
  return sentRtp;
    } catch (e) {
      console.error('RTP handling error:', e.message);
      return 'Maaf bosku, terjadi kendala saat menampilkan RTP. Coba lagi sebentar ya. 🙏';
    }
  }

  // Answer bank info queries immediately with a single concise message
  if (isBankInfoQuery(userMessage)) {
    let msg = await buildBankInfoResponse(chatId, getBrandNameForChat);
    
    // Add contextual tip and personality
    msg = addContextualTip(msg, 'banking', context);
    msg = enhanceResponsePersonality(msg, chatState);
    
  chatState.lastResponseType = 'bankinfo';
  const sentBank = await sendAgentReply(chatId, msg, userMessage, messageId);
  lastResponseTimes.set(chatId, Date.now());
  return sentBank;
  }

  // Answer deposit/withdrawal limit queries immediately
  if (isLimitInquiry(userMessage)) {
    const lang = context.language || context.detectedLanguage || 'id';
    let msg = await buildLimitsResponse(chatId, lang);
    
    // Add contextual tip and personality
    msg = addContextualTip(msg, 'limits', context);
    msg = enhanceResponsePersonality(msg, chatState);
    
  chatState.lastResponseType = 'limits';
  const sentLimits = await sendAgentReply(chatId, msg, userMessage, messageId);
  lastResponseTimes.set(chatId, Date.now());
  return sentLimits;
  }

  // Handle request to change User ID (silent support ping, no mention)
  const isUserIdChange = /\b(ganti|ubah|change|update)\b.*\b(user\s*id|userid|username|id)\b|\b(change|update)\b.*\b(user\s*id|userid|username)\b/i.test(userMessage);
  if (isUserIdChange) {
    const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
    const probableUserId = userIdMatch?.[1]?.trim() || null;
    // If user provided an ID inline, ack first then ping support
    if (probableUserId) {
      const ackMsg = `Siap bosku, kami proses permintaan ganti User ID untuk: ${probableUserId}. Mohon ditunggu sebentar ya.`;
      const sent = await sendAgentReply(chatId, ackMsg, userMessage, messageId);
  try { await createAndPingSupport(chatState, 'userid_change', { chatId, userId: probableUserId, language: 'id', message: userMessage }).catch(() => {}); } catch(_) {}
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return sent;
    }
    // Otherwise set flow so follow-up ID will be handled (ack then ping)
    chatState.userIdChangeFlow = { active: true, userId: null, requestedAt: Date.now() };
    const askId = 'Baik bosku, untuk proses ganti User ID boleh minta User ID-nya?';
    context.conversationHistory.push({ message: askId, timestamp: Date.now(), type: 'agent' });
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return askId;
  }

  // Handle request to create new user/account or new userid (ask phone + desired user id)
  const isNewAccount = /(buat|daftar|register|create|make|bikin)\s+(akun|account)|\bnew\s+(account|userid|user\s*id)\b|\bmake\s+new\s+(account|userid|user\s*id)\b/i.test(userMessage);
  if (isNewAccount) {
    const askData = 'Siap bosku! Untuk buat akun baru, boleh minta Nomor HP dan User ID yang diinginkan?';
    context.conversationHistory.push({ message: askData, timestamp: Date.now(), type: 'agent' });
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return askData;
  }
  
  // Check if we should ping support for this message (always silent; never mention ping)
  if (needsSupportPing(userMessage)) {
    // Detect the specific issue
    let issueType = 'Account Assistance';
    const lowerMessage = userMessage.toLowerCase();

    if (/(lupa|forgot|reset|ganti|change|hilang|lost)\s+(password|sandi|pin)/i.test(lowerMessage)) {
      issueType = 'Password Reset';
    } else if (/(akun|account|login|masuk)\s+(terkunci|diblokir|suspended|banned|hacked|terblokir)/i.test(lowerMessage)) {
      issueType = 'Account Access Issue';
    } else if (/(verif|otp|kode\s+verifikasi|kode\s+otp)/i.test(lowerMessage)) {
      issueType = 'Verification Issue';
    } else if (/(scam|phishing|penipuan|tertipu|hacked|diretas)/i.test(lowerMessage)) {
      issueType = 'Security Concern';
    }

    // Silently ping support and ask for the minimal info; never mention the ping.
    if (issueType === 'Password Reset') {
      // Try to extract a user id from message or context
      const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
      const probableUserId = userIdMatch?.[1]?.trim() || context.userId || null;
      // Defer the ping until after the bot acknowledges the provided User ID.
      chatState.passwordResetFlow = chatState.passwordResetFlow || { active: false, userId: null };
      chatState.passwordResetFlow.active = true;
      if (probableUserId) chatState.passwordResetFlow.userId = probableUserId;

      const askId = 'Baik bosku, untuk bantu reset password boleh minta User ID-nya?';
      context.conversationHistory.push({ message: askId, timestamp: Date.now(), type: 'agent' });
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      return askId;
    }

    // For other support issues: silently ping and ask for CID; no visible support message
    const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
    const probableUserId = userIdMatch?.[1]?.trim() || context.userId || null;
    const pingType = issueType.toLowerCase().replace(/\s+/g, '_');
    // Defer the ping; set a supportFlow so we can capture follow-up User ID and ping after ack.
    chatState.supportFlow = chatState.supportFlow || { active: false, type: null, userId: null };
    chatState.supportFlow.active = true;
    chatState.supportFlow.type = pingType;
    if (probableUserId) chatState.supportFlow.userId = probableUserId;

    const askCid = 'Siap bosku, boleh minta User ID-nya? dY~S';
    context.conversationHistory.push({ message: askCid, timestamp: Date.now(), type: 'agent' });
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return askCid;
  }
  
  // Check if we should skip this response
  if (shouldSkipResponse(chatId, userMessage)) {
    return null;
  }
  
  // Extract context
  extractContext(context, userMessage);
  // Language handling: detect and store, default to English if unknown
  const lang = detectLanguage(userMessage);
  context.language = normalizeLanguageCode(lang);

  // Force deposit flow initiation for deposit inquiry phrases (robust against LLM variance and chat restarts)
// Force deposit flow initiation for deposit inquiry phrases (robust against LLM variance and chat restarts)
// BUT exclude withdraw-related messages
const withdrawKeywords = /\b(withdraw|wd|penarikan|tarik\s*dana)\b/i;
if (isDepositInquiry(userMessage) && !withdrawKeywords.test(userMessage)) {
  // Reset any prior deposit state to enforce ordering: User ID first, then amount
  chatState.deposit_inquiry_active = true;

  // Try to extract from the current message before asking
  const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
  if (userIdMatch && userIdMatch[1]) {
    chatState.deposit_user_id = userIdMatch[1].trim();
  } else {
    chatState.deposit_user_id = null; // Reset if not found in this message
  }

  const amountMatch = userMessage.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(k|rb|ribu|jt|juta|m|million|thousand|rb\.|r\.?p|rupiah)?\b/i);
  if (amountMatch) {
      let num = amountMatch[1].replace(',', '.');
      const unit = (amountMatch[2] || '').toLowerCase();
      let mult = 1;
      if (unit.startsWith('k') || unit === 'rb' || unit === 'rb.' || unit === 'ribu' || unit === 'thousand') mult = 1000;
      else if (unit === 'jt' || unit === 'juta' || unit === 'm' || unit === 'million') mult = 1_000_000;
      const amount = Math.floor(parseFloat(num) * mult);
      if (!Number.isNaN(amount)) chatState.deposit_amount = amount;
  } else {
      chatState.deposit_amount = null; // Reset if not found
  }

  context.lastDepositCheck = { userId: chatState.deposit_user_id, amount: chatState.deposit_amount };

  if (!chatState.deposit_user_id) {
    const response = 'Boleh minta User ID-nya dulu bosku? 😊';
    context.conversationHistory.push({ message: response, timestamp: Date.now(), type: 'agent' });
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    return response;
  }
}
  
  // Prompt-based intent detection (pre-template)
  try {
    // Lightweight heuristic: if the user explicitly asks about games/slots/gacor/rtp,
    // prefer treating this as a game-list or RTP query so we don't accidentally
    // return promotions for clearly game-related questions.
    const lowerMsg = String(userMessage || '').toLowerCase();
    const isExplicitGameQuery = /\b(game apa|slot|slots|gacor|rtp|which slots|game apa|slot apa)\b/i.test(lowerMsg);
  // Reuse early-detected intents when available to avoid duplicate LLM calls
  intents = intents || await detectIntentsLLM(userMessage);
    if (isExplicitGameQuery) {
      intents.is_game_list_query = true;
      intents.is_rtp_query = intents.is_rtp_query || /rtp/.test(lowerMsg);
      intents.is_promotion_query = false; // avoid promo responses for clear game queries
    }
    // --- Activate matching flows early: ensure any detected domain intent starts its flow
    try {
      // Deposit flow activation
      if (isDepositInquiry(userMessage) || intents.is_deposit_query) {
        chatState.deposit_inquiry_active = true;
        // try to pre-extract user id
        const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
        if (userIdMatch && userIdMatch[1]) chatState.deposit_user_id = userIdMatch[1].trim();
        // If no user id yet, ask for it
        if (!chatState.deposit_user_id) {
          const ask = 'Boleh minta User ID-nya dulu bosku? 😊';
          context.conversationHistory.push({ message: ask, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return ask;
        }
        // If we have a user id, let the later deposit state handler do acknowledgement and ping
      }

      // Withdraw flow activation
      if (isWithdrawalInquiry(userMessage) || intents.is_withdrawal_query) {
        const withdrawChatState = getChatState(chatId);
        if (!withdrawChatState.withdrawState) withdrawChatState.withdrawState = { active: false, started: 0, userId: null, amount: null };
        withdrawChatState.withdrawState.active = true;
        const uid = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
        if (uid && uid[1]) withdrawChatState.withdrawState.userId = uid[1].trim();
        if (!withdrawChatState.withdrawState.userId) {
          const askUid = 'Tentu bosku, boleh minta User ID untuk cek withdrawnya?';
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return askUid;
        }
        // If user id present, later withdraw flow will ack and ping
      }

      // Turnover flow activation
      if (isTurnoverInquiry(userMessage) || intents.is_turnover_query) {
        // try to extract uid
        const uidMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i);
        if (uidMatch && uidMatch[1]) {
          // acknowledge and ping
          const uid = uidMatch[1].trim();
          const ack = 'Terima kasih bosku, kami teruskan ke tim untuk cek turnover. Mohon ditunggu sebentar ya.';
      const sent = await sendAgentReply(chatId, ack, userMessage, messageId);
  try { await createAndPingSupport(chatState, 'turnover', { chatId, userId: uid, language: context.language || 'id', message: userMessage }).catch(()=>{}); } catch(_) {}
          return sent;
        } else {
          // ask for user id
          chatState.turnoverFlow = { active: true, userId: null, requestedAt: Date.now() };
          const ask = 'Untuk pengecekan turnover, tim CS kami yang bantu. Boleh minta User ID-nya bosku?';
          context.conversationHistory.push({ message: ask, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return ask;
        }
      }

      // Bank info / limits / password resets: handled by existing handlers but ensure flows are set
      if (isBankInfoQuery(userMessage)) {
        const msg = await buildBankInfoResponse(chatId, getBrandNameForChat);
        const msg2 = addContextualTip(msg, 'banking', context);
        return await sendAgentReply(chatId, enhanceResponsePersonality(msg2, chatState), userMessage, messageId);
      }
      // Password reset and account access are handled later; if detected, set flow flags
      if (/(reset|lupa|ganti)\s*(password|sandi)\b|\b(password|sandi)\s*(reset|lupa|ganti)\b/i.test(userMessage)) {
        chatState.passwordResetFlow = chatState.passwordResetFlow || { active: false, userId: null };
        chatState.passwordResetFlow.active = true;
        // extraction and prompt logic handled later in flow
      }
    } catch (flowErr) {
      console.warn('Flow activation error:', flowErr?.message || flowErr);
    }
    // DEBUG: log intents for troubleshooting
  // suppressed detectIntentsLLM debug
    const wantsPromoDetails = /\b(details?|more|info|terms?|conditions?|syarat|ketentuan|eligible|games?)\b/i.test(userMessage);
    
    // Transfer-to-agent request: record the request but do NOT send an automated canned reply.
    // This prevents the canned 'Baik bosku, saya akan hubungkan...' message from being sent.
    if (intents.wants_transfer_to_agent && !chatState.hasSentTransferNotice) {
      try {
        chatState.hasSentTransferNotice = true;
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        // Optionally log for audit; do not push any agent message or return text
        console.log(`Transfer-to-agent requested (no auto-reply) for chat ${chatId}`);
      } catch (_) {}
    }
    
    // RTP query -> default to formatted text; raw JSON only on explicit ask
  if (intents.is_rtp_query) {
      try {
        const wantsRaw = /\b(json|raw)\b/i.test(userMessage || '');
        if (wantsRaw) {
          const rawJson = await fs.readFile(RTP_FILE, 'utf8');
          if (!wasMessageSentInChat(chatId, '[rtp.json raw]')) {
            context.conversationHistory.push({ message: '[rtp.json sent as raw]', timestamp: Date.now(), type: 'agent' });
            chatState.lastProcessedMessageId = messageId;
            chatState.lastResponseTime = Date.now();
            return rawJson;
          } else {
            return null;
          }
        }
    // Prefer per-group RTP link
    const rtpMsg = await buildRtpResponse(chatId);
        if (!wasMessageSentInChat(chatId, rtpMsg)) {
          context.conversationHistory.push({ message: rtpMsg, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return rtpMsg;
        } else {
          return null;
        }
      } catch (e) {
        console.error('RTP handling error (LLM branch):', e.message);
        return 'Maaf bosku, terjadi kendala saat menampilkan RTP. Coba lagi sebentar ya. 🙏';
      }
    }
    
    // Game list query -> respond with game list
    if (intents.is_game_list_query) {
      const gameListResponse = getGameListResponse();
      let response = `Daftar Permainan yang Tersedia 🎮\n\n${gameListResponse}\n\nAda yang bisa saya bantu lagi bosku? 😊`;
      if (!wasMessageSentInChat(chatId, response)) {
        context.conversationHistory.push({ message: response, timestamp: Date.now(), type: 'agent' });
        chatState.lastProcessedMessageId = messageId;
        chatState.lastResponseTime = Date.now();
        markMessageSentInChat(chatId, response);
        return response;
      } else {
        return null;
      }
    }
    
    // Promotion query -> enforce a finite-state promo flow to avoid loops
    if (intents.is_promotion_query) {
      try {
        context.isDiscussingPromos = true;
        const wantsRaw = /\b(json|raw)\b/i.test(userMessage || '');

        // Handle raw JSON requests quickly (no FSM)
        if (wantsRaw) {
          try {
            const gid = await getGroupIdForChat(chatId);
            if (gid != null) {
              const groupPromos = await listGroupPromotions(Number(gid)).catch(() => null);
              if (Array.isArray(groupPromos) && groupPromos.length) {
                const payload = JSON.stringify({ promotions: groupPromos }, null, 2);
                if (!wasMessageSentInChat(chatId, '[group promotions.json raw]')) {
                  context.conversationHistory.push({ message: '[group promotions.json sent as raw]', timestamp: Date.now(), type: 'agent' });
                  chatState.lastProcessedMessageId = messageId;
                  chatState.lastResponseTime = Date.now();
                  return payload;
                }
                return null;
              }
            }
          } catch (_) {}
          const rawJson = await fs.readFile(PROMOTIONS_FILE, 'utf8');
          if (!wasMessageSentInChat(chatId, '[promotions.json raw]')) {
            context.conversationHistory.push({ message: '[promotions.json sent as raw]', timestamp: Date.now(), type: 'agent' });
            chatState.lastProcessedMessageId = messageId;
            chatState.lastResponseTime = Date.now();
            return rawJson;
          }
          return null;
        }

        // Load promotions and titles
        const promos = await getPromotionsForChat(chatId);
        const allTitles = await promotions.listPromotionTitles(promos);

        // FSM helper
        const pf = chatState.promoFlow || { state: 'idle', startedAt: 0, repeats: 0, lastPromptHash: null };
        const stateBefore = pf.state || 'idle';

        // Quick intent layering: claim vs details vs general list
        const isAskingHowToClaim = /how to claim|how do i claim|claim it|claim the|how to get|cara klaim|cara mendapatkan|gmn caranya|gimana caranya|gimana klaim/i.test(userMessage);
        const isAskingDetails = /\b(details?|more|info|terms?|conditions?|syarat|ketentuan|eligible|games?)\b/i.test(userMessage) && !isAskingHowToClaim;
        const matchedPromo = promotions.findPromotionByNameOrIndex ? promotions.findPromotionByNameOrIndex(userMessage, promos) : null;

        // Re-detection window: if promoFlow started recently (<5s) and new aggregated input suggests details/claim,
        // prefer transitioning to details/claim. This helps when server2 combines replies.
        const now = Date.now();
        if (pf.startedAt && (now - pf.startedAt) <= 5000) {
          // If aggregated message includes a promo index or name, treat as details
          if (matchedPromo) {
            // promote to details
            pf.state = 'promo.details';
          } else if (isAskingHowToClaim) {
            pf.state = 'promo.claim';
          }
        }

        // Determine next action based on FSM state and user intent
        let reply = null;

        if (pf.state === 'idle') {
          // Transition to list state and send titles-only list
          pf.state = 'promo.list';
          pf.startedAt = Date.now();
          pf.repeats = 0;
          pf.lastPromptHash = (allTitles.join('|') || '').toLowerCase().substring(0, 200);
          if (!allTitles.length) {
            reply = 'Saat ini belum ada promo yang tersedia.';
          } else {
            reply = allTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
          }
        } else if (pf.state === 'promo.list') {
          // User responded after list was shown. Check if they asked for details or claim
          // If they referenced a specific promo, show details; if they asked how to claim, show claim steps.
          if (matchedPromo) {
            pf.state = 'promo.details';
            reply = promotions.formatTermsOnly ? promotions.formatTermsOnly(matchedPromo) : promotions.formatPromotions([matchedPromo], userMessage);
          } else if (isAskingHowToClaim) {
            pf.state = 'promo.claim';
            if (matchedPromo) {
              reply = promotions.formatClaimInfoOnly ? promotions.formatClaimInfoOnly(matchedPromo) : promotions.formatHowToClaimOnly ? promotions.formatHowToClaimOnly(matchedPromo) : 'Informasi cara klaim tidak tersedia untuk promo tersebut.';
            } else {
              // Generic claim info across promos
              const claimEntries = [];
              for (const p of promos) {
                try {
                  const info = promotions.formatClaimInfoOnly ? promotions.formatClaimInfoOnly(p) : null;
                  const how = (info && String(info).trim()) ? info : (promotions.formatHowToClaimOnly ? promotions.formatHowToClaimOnly(p) : null);
                  if (how && String(how).trim()) claimEntries.push(`📌 ${p.title}\n${how}`);
                } catch (e) {}
              }
              if (claimEntries.length > 0) reply = claimEntries.join('\n\n');
              else reply = 'Informasi cara klaim tidak tersedia untuk promo-promo ini.';
            }
          } else {
            // No progress: if user repeats same ambiguous request twice, exit politely
            const promptHash = normalizeForMatch(userMessage || '').substring(0, 200);
            if (pf.lastPromptHash && pf.lastPromptHash === promptHash) {
              pf.repeats = (pf.repeats || 0) + 1;
            } else {
              pf.lastPromptHash = promptHash;
              pf.repeats = 1;
            }
            if ((pf.repeats || 0) >= 2) {
              reply = 'Oke bosku, kalau tidak ada promo spesifik yang Anda maksud, ada hal lain yang bisa saya bantu? 😊';
              pf.state = 'idle';
              pf.repeats = 0;
              pf.startedAt = 0;
              pf.lastPromptHash = null;
            } else {
              // Re-send the short prompt asking which promo (but avoid exact duplicates)
              const ask = promos.length > 0 ? `Promo mana yang Anda maksud? (mis. ${promos.slice(0,3).map(p=>p.title).filter(Boolean).join(', ')})` : 'Promo mana yang Anda maksud?';
              if (!wasMessageSentInChat(chatId, ask)) reply = ask;
            }
          }
        } else if (pf.state === 'promo.details' || pf.state === 'promo.claim') {
          // Already in a details/claim state: after responding, reset to idle.
          if (pf.state === 'promo.details') {
            if (matchedPromo) reply = promotions.formatTermsOnly ? promotions.formatTermsOnly(matchedPromo) : promotions.formatPromotions([matchedPromo], userMessage);
            else if (promos.length === 1) reply = promotions.formatTermsOnly ? promotions.formatTermsOnly(promos[0]) : promotions.formatPromotions(promos, userMessage);
            else reply = 'Promo mana yang Anda maksud?';
          } else {
            // claim
            if (matchedPromo) reply = promotions.formatClaimInfoOnly ? promotions.formatClaimInfoOnly(matchedPromo) : promotions.formatHowToClaimOnly ? promotions.formatHowToClaimOnly(matchedPromo) : 'Informasi cara klaim tidak tersedia untuk promo tersebut.';
            else reply = 'Promo mana yang ingin Anda klaim?';
          }
          // After giving details/claim info, reset FSM
          pf.state = 'idle';
          pf.startedAt = 0;
          pf.repeats = 0;
          pf.lastPromptHash = null;
        }

        // Persist FSM back to chatState
        chatState.promoFlow = pf;

        // Log transition
        try { console.log('PROMO_FLOW_TRANSITION', { chatId, stateBefore, stateAfter: pf.state, intentDetected: { isAskingDetails, isAskingHowToClaim, matchedPromo: !!matchedPromo } }); } catch(_) {}

        if (reply && !wasMessageSentInChat(chatId, reply)) {
          context.conversationHistory.push({ message: reply, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          return reply;
        }

        return null;
      } catch (e) {
        console.error('Promo handling FSM error:', e && e.message ? e.message : e);
        return 'Maaf bosku, terjadi kendala saat menampilkan promo. Coba lagi sebentar ya. 🙏';
      }
    }
  } catch (e) {
    console.warn('Pre-LLM intent handling failed:', e.message);
  }
  
  // Template-based intents (RTP, promotions, etc.) take priority before any other flow
  try {
  const templated = await getTemplateResponse(context, userMessage, chatId, messageId);
    if (templated) {
      // Prevent duplicate sends of the same template
      if (wasMessageSentInChat(chatId, templated)) {
        console.log(`🚫 Skipping duplicate template response in chat ${chatId}`);
        return chatState.lastGeneratedReply || null;
      }
      chatState.lastProcessedMessageId = messageId;
      chatState.lastResponseTime = Date.now();
      console.log('🧩 Template response matched (pre-LLM).');
      const sentTemplated = await sendAgentReply(chatId, templated, userMessage, messageId);
      return sentTemplated;
    }
  } catch (e) {
    console.warn('Template response error:', e.message);
  }
  
  // Game list detection handled earlier by detectIntentsLLM
  
  // ===================================================================
  // REFACTORED DEPOSIT CHECK FLOW
  // Align with rule: ask for USER ID only; amount optional.
  // Always acknowledge and ask user to wait; silently ping support.
  // ===================================================================
  const depositState = chatState.depositState || {};
  const isStartingDepositQuery = isDepositInquiry(userMessage);

  if (isStartingDepositQuery || depositState.active) {
    // 1. Activate and initialize state if this is a new inquiry
    if (isStartingDepositQuery) {
        // Always reset state on a new inquiry to ensure we ask for ID again,
        // even if a previous ID was stored from a prior, completed conversation.
        chatState.depositState = { active: true, userId: null, amount: null };
    }

    // 2. Extract information from the current message
    const currentUserId = chatState.depositState.userId;
    const currentAmount = chatState.depositState.amount;

  if (!currentUserId) {
    const userIdMatch = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i)
              || (userMessage && userMessage.trim().length <= 40 ? userMessage.match(/^([A-Za-z0-9_\-]{3,20})(?=\s|$)/) : null);
        if (userIdMatch && userIdMatch[1]) {
            chatState.depositState.userId = userIdMatch[1].trim();
        }
    }

    if (!currentAmount) {
        const amountMatch = userMessage.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(k|rb|ribu|jt|juta|m|million|thousand|rb\.|r\.?p|rupiah)?\b/i);
        if (amountMatch) {
            let num = amountMatch[1].replace(',', '.');
            const unit = (amountMatch[2] || '').toLowerCase();
            let mult = 1;
            if (unit.startsWith('k') || unit === 'rb' || unit === 'rb.' || unit === 'ribu' || unit === 'thousand') mult = 1000;
            else if (unit === 'jt' || unit === 'juta' || unit === 'm' || unit === 'million') mult = 1_000_000;
            const amount = Math.floor(parseFloat(num) * mult);
            if (!Number.isNaN(amount)) chatState.depositState.amount = amount;
        }
    }

    // 3. Ask for information: only require User ID (amount optional)
  if (!chatState.depositState.userId) {
    const response = 'Boleh minta User ID-nya dulu bosku? 😊';
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    const sentAsk = await sendAgentReply(chatId, response, userMessage, messageId);
    return sentAsk;
  }

    // 4. Confirm with or without amount, silently ping support, and reset state.
    const userId = chatState.depositState.userId;
    const amount = chatState.depositState.amount || null;
    const confirmationMsg = amount
      ? `Baik, saya akan cek deposit untuk User ID: ${userId} sejumlah ${new Intl.NumberFormat('id-ID').format(amount)}. Mohon ditunggu sebentar.`
      : `Baik, saya akan cek deposit untuk User ID: ${userId}. Mohon ditunggu sebentar.`;

    // Send acknowledgement to user first
  const sentConf = await sendAgentReply(chatId, confirmationMsg, userMessage, messageId);
  // Silent ping (do not mention in chat)
  try { await createAndPingSupport(chatState, 'deposit_check', { chatId, userId, amount, language: 'id', message: userMessage }).catch(() => {}); } catch(_) {}
    // Reset the state for the next inquiry
    chatState.depositState = { active: false, userId: null, amount: null };

  chatState.lastProcessedMessageId = messageId;
  chatState.lastResponseTime = Date.now();
  return sentConf;
  }
  
  // Withdraw check flow – ask for User ID; amount optional. Always ping support silently.
  const textW = userMessage.toLowerCase();
  const withdrawCheckRe = /(cek\s*(withdraw|wd|penarikan|tarik\s*dana)|\b(withdraw|wd)\b|penarikan|tarik\s*dana)/i;
  
  const withdrawChatState = getChatState(chatId);
  if (!withdrawChatState.withdrawState) {
    withdrawChatState.withdrawState = {
      active: false,
      started: 0,
      userId: null,
      amount: null
    };
  }
  
  const isWithdrawQuery = withdrawCheckRe.test(textW);
  if (isWithdrawQuery || withdrawChatState.withdrawState.active) {
    if (isWithdrawQuery && !withdrawChatState.withdrawState.active) {
      withdrawChatState.withdrawState = {
        active: true,
        started: Date.now(),
        userId: null,
        amount: null
      };
    }
    // Try to extract user ID if missing
    if (!withdrawChatState.withdrawState.userId) {
      const uid = userMessage.match(/(?:user\s*id|id|user|username|userid|user_id|user-id)[:=\s]*([A-Za-z0-9_\-]{3,20})/i) 
               || (userMessage.trim().length <= 40 ? userMessage.match(/^([A-Za-z0-9_\-]{3,20})(?=\s|$)/) : null);
      if (uid && (uid[1] || uid[0])) {
        withdrawChatState.withdrawState.userId = (uid[1] || uid[0]).trim();
      }
    }
    // Try to extract amount if missing
    if (!withdrawChatState.withdrawState.amount) {
      const am = userMessage.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)(\s*(k|rb|ribu|jt|juta|m|million|thousand|rb\.|r\.?p|rupiah))?\b/i);
      if (am) {
        let num = am[1].replace(',', '.');
        const unit = (am[3] || '').toLowerCase();
        let mult = 1;
        if (unit.startsWith('k') || unit === 'rb' || unit === 'rb.' || unit === 'ribu' || unit === 'thousand') mult = 1000;
        else if (unit === 'jt' || unit === 'juta' || unit === 'm' || unit === 'million') mult = 1_000_000;
        const amount = Math.floor(parseFloat(num) * mult);
        if (!Number.isNaN(amount)) withdrawChatState.withdrawState.amount = amount;
      }
    }
  // Ask for missing fields: User ID required; amount optional
  if (!withdrawChatState.withdrawState.userId) {
  const askUid = 'Tentu bosku, boleh minta User ID untuk cek withdrawnya?';
  chatState.lastProcessedMessageId = messageId;
  chatState.lastResponseTime = Date.now();
  const sentAskUid = await sendAgentReply(chatId, askUid, userMessage, messageId);
  return sentAskUid;
}
    // Confirm with or without amount, ping silently, and reset state
    const u = withdrawChatState.withdrawState.userId;
    const a = withdrawChatState.withdrawState.amount || null;
    const conf = a
      ? `Baik, saya akan cek status withdraw untuk User ID: ${u} sejumlah ${new Intl.NumberFormat('id-ID').format(a)}. Mohon ditunggu sebentar ya bosku.`
      : `Baik, saya akan cek status withdraw untuk User ID: ${u}. Mohon ditunggu sebentar ya bosku.`;

    // Send acknowledgement to user first
  const sentConf = await sendAgentReply(chatId, conf, userMessage, messageId);
    // Silent ping (do not mention in chat)
  try { await createAndPingSupport(chatState, 'withdraw_check', { chatId, userId: u, amount: a, language: 'id', message: userMessage }).catch(() => {}); } catch(_) {}

    // reset
    withdrawChatState.withdrawState = { active: false, started: 0, userId: null, amount: null };
  chatState.lastProcessedMessageId = messageId;
  chatState.lastResponseTime = Date.now();
  return sentConf;
  }
  
  // Skip template-based responses entirely to avoid keyword/template-triggered replies
  
      // Use advanced response system as fallback
    try {
      // Check for off-topic content first
      const offTopicDetection = detectOffTopic(userMessage);
      if (offTopicDetection.isOffTopic) {
        console.log(`💬 Smart detection: ${offTopicDetection.type} detected (score: ${offTopicDetection.score})`);
        chatState.offTopicWarningCount++;
        
        // Add off-topic question to the list
        await addOffTopicQuestion(userMessage);
        
  return await getWarningMessage(chatState, context.language);
      }

      // Additional off-topic checks for responses (but allow greetings)
      const userText = userMessage.toLowerCase();
      // Additional off-topic checks for responses (but allow greetings)
  if ((userText.includes('fortnite') || userText.includes('love') || userText.includes('like') || userText.includes('read')) &&
       !userText.includes('hello') && !userText.includes('hi') && !userText.includes('halo') && !userText.includes('hai')) {
    // Treat clearly unrelated entertainment mentions as off-topic, but do NOT
    // block generic "game"/"slot" queries which are domain-relevant.
    chatState.offTopicWarningCount++;
    await addOffTopicQuestion(userMessage);
    return await getWarningMessage(chatState, context.language);
  }

  if (typeof chatState.lastGeneratedReply === 'string' && chatState.lastGeneratedReply.trim()) {
    return chatState.lastGeneratedReply;
  }

  // Unrestricted ChatGPT-like mode: BUT only after promo/RTP/game checks have passed
  // This ensures formatted responses take priority over AI-generated ones
  if (UNRESTRICTED_BOT && aiClient.isEnabled()) {
    // Skip unrestricted mode if this is a promo/RTP/game request (let formatted responses handle it)
    const isFormattedResponse = isPromoRequest(userMessage) || isRtpRequest(userMessage) || /\b(game|slot|permainan)\b/i.test(userMessage);
    if (!isFormattedResponse) {
      try {
        const startTime = Date.now();
        
        // Build lightweight conversation with slightly larger recent history (8 messages max)
        const history = (context.conversationHistory || []).slice(-8).map(h => ({
          role: h.type === 'agent' ? 'assistant' : 'user',
          content: String(h.message || '')
        }));

        // Attach memory summary when available to reduce repetition and keep context
        let memorySummary = null;
        try {
          memorySummary = await updateConversationMemory(chatState).catch(() => null);
        } catch (_) { memorySummary = null; }

        const groupName = await getBrandNameForChat(chatId);
        const gid = await getGroupIdForChat(chatId);

        // Enhanced smart system prompt with comprehensive slang understanding
        const system = `You are ${groupName} support AI. Smart, helpful, context-aware casino assistant with PERFECT Indonesian slang understanding.

YOUR CAPABILITIES:
✅ Answer deposit, withdrawal, account questions
✅ Help with bank account changes, limits, verification
✅ Provide general casino info, support, guidance
✅ Remember conversation context and continue topics naturally
✅ Understand ALL Indonesian slang, abbreviations, typos, and casual language

MASTER ALL INDONESIAN SLANG:
**Pronouns**: gw/gue/ane (saya), lo/lu/elu (kamu), doi (dia)
**Yes/No**: ya/iya/yoi (yes), ga/gak/enggak/ngga (tidak)
**Time**: udh/dah (sudah), blm/blom (belum), skrg/skg (sekarang), ntar (nanti)
**Verbs**: pgn/pengen (ingin), mo (mau), bs/bsa (bisa), tlg/tlong (tolong), bntu (bantu)
**Casino**: depo/dp (deposit), wd (withdraw), promo/prm (promosi), sldo (saldo), duit/cuan (uang)
**Questions**: gmn/gimana (bagaimana), brp (berapa), knp/napa (kenapa)
    
            
**Adverbs**: bgt/bngt (banget), bnr/bener (benar), byk (banyak), dkit (sedikit)
**Phrases**: gpp/gapapa (tidak apa apa), makasih/mksh/thx (terima kasih)
**Amounts**: 50k/50rb (50.000), 100k (100.000), 1jt/1m (1.000.000)

UNDERSTAND THESE PERFECTLY:
- "depo gw udh blm masuk" = My deposit hasn't arrived yet
- "wd 500k blm cair" = 500k withdrawal not cleared
- "brp minimal dp?" = What's minimum deposit?
- "gmn caranya tarik duit?" = How to withdraw money?
- "ada promo baru ga?" = Any new promos?
- "tlg cek dong" = Please check
- "kok lama bgt?" = Why so long?

CRITICAL RULES:
❌ NEVER list promotions/bonuses yourself - say "let me get the promo list for you"
❌ NEVER list games/RTP yourself - say "I'll fetch the game info"
❌ NEVER give made-up information - be honest if unsure

RESPONSE STYLE:
- Call user "bosku" (Indonesian friend/boss)
- Use emojis naturally: 😊💰💸🎰🏦
- Reply in Indonesian (default) or match user's language
- Be brief but complete (2-3 sentences max)
- Show personality: friendly, helpful, professional
- If user refers to "it"/"that", infer from conversation context
- For yes/no/short replies, understand they're continuing the topic
- Understand slang PERFECTLY - never ask for clarification on common slang

Remember: Be smart, be natural, understand ALL slang, be helpful! 💯`;

  // Add short operational workflows to provide concrete, actionable steps
  // for deposit/withdrawal/turnover/password reset so the model always
  // includes required fields and next steps when relevant.
  const operationalWorkflows = `\n\nOPERATIONAL WORKFLOWS (use for deposit/withdraw/turnover/password reset):\n- DEPOSIT: If user asks about a deposit, ALWAYS ask only for User ID (do NOT ask for the deposit amount). If an amount is provided by the user, you may confirm it, but do not request it. After receiving the User ID, acknowledge and then silently forward the request to CS. Do NOT request passwords or full card data. If verification is needed, instruct the user to provide proof (transaction ID or screenshot) and state you'll forward to CS.\n- WITHDRAWAL: For withdrawal inquiries, ALWAYS ask for User ID and bank name/account number if not provided. Mention typical processing time and any limits. Remind the user that the account holder name must match verification documents. Do NOT ask for passwords.\n- TURNOVER: For turnover checks, ALWAYS request User ID if missing, explain the team will review turnover, expected reply time, and quietly forward the request to CS after acknowledging the User ID.\n- PASSWORD RESET: For password reset, ALWAYS ask for User ID only, never ask for current password. Explain verification steps (registered phone or email confirmation) and that CS will handle the reset.\nUse these workflows to give clear next steps, required fields, and expected times when responding.`;

        const messages = [
          { role: 'system', content: system + operationalWorkflows },
          ...(memorySummary ? [{ role: 'system', content: `Memory summary (short):\n${memorySummary}` }] : []),
          ...history,
          { role: 'user', content: msgNorm }
        ];

        const completion = await aiClient.chatCompletion({
          model: 'gpt-3.5-turbo',
          messages,
          temperature: 0.7, // Increased for more natural, varied responses
          max_tokens: 200,  // More tokens for complete answers
          presence_penalty: 0.6, // Encourage new topics and avoid repetition
          frequency_penalty: 0.5 // Reduce word repetition
  }, await buildMeta(chatId, 'gc.unrestricted.fast'));

        let reply = (completion.choices?.[0]?.message?.content || '').trim();
        
        // Enhance AI response with personality and tips
        reply = addContextualTip(reply, contextAnalysis.topic, context);
        reply = enhanceResponsePersonality(reply, chatState);
        
        const responseTime = Date.now() - startTime;
        
        console.log(`⚡ Fast response generated in ${responseTime}ms`);

        // Save to conversation history
        context.conversationHistory.push({ message: userMessage, timestamp: Date.now(), type: 'user' });
        if (reply) {
          context.conversationHistory.push({ message: reply, timestamp: Date.now(), type: 'agent' });
          chatState.lastProcessedMessageId = messageId;
          chatState.lastResponseTime = Date.now();
          markMessageSentInChat(chatId, reply);
        }
        return reply || 'Terima kasih atas pesannya. Tim kami siap membantu.';
      } catch (e) {
        console.warn('Unrestricted mode failed, using fallback:', e.message);
        // Fall through to standard AI fallback
      }
    }
  }

  if (typeof chatState.lastGeneratedReply === 'string' && chatState.lastGeneratedReply.trim()) {
    return chatState.lastGeneratedReply;
  }

  const brandForPrompt = await getBrandNameForChat(chatId);
  const gidForPrompt = await getGroupIdForChat(chatId);
  const aiCfg = await getGroupAiSettingsForChat(chatId);
  const hasCustomRules = !!(aiCfg && (aiCfg.customRules || aiCfg.exampleMessage));
  
    // Load custom messages (group-specific preferred)
    const getCustomMessagesForChat = await getCustomMessages();
    const globalCustomMessages = await getCustomMessagesForChat(null); // returns nulls; kept for compatibility
    const effectiveCustomMessages = (aiCfg && aiCfg.customMessages && (aiCfg.customMessages.welcomeMessage || aiCfg.customMessages.waitMessage || aiCfg.customMessages.endMessage))
      ? aiCfg.customMessages
      : await getCustomMessagesForChat(chatId);
    const customMessages = effectiveCustomMessages || { welcomeMessage: null, waitMessage: null, endMessage: null };
    const customMessagesText = (customMessages.welcomeMessage || customMessages.waitMessage || customMessages.endMessage)
      ? `\n\nCUSTOM MESSAGES (use these when appropriate):
 Welcome Message: ${customMessages.welcomeMessage || 'Use default greeting'}
 Wait Message (when checking/processing): ${customMessages.waitMessage || 'Use default wait message'}
 End Message (when closing conversation): ${customMessages.endMessage || 'Use default closing'}`
      : '';
  
  // Add supported banks list to the prompt using group-configured payments when available
  let supportedBanksList = SUPPORTED_BANKS.join(', ');
  try {
    const paymentsForPrompt = await getPaymentsForChat(chatId);
    if (paymentsForPrompt && Array.isArray(paymentsForPrompt.banks) && paymentsForPrompt.banks.length) {
      supportedBanksList = paymentsForPrompt.banks.join(', ');
    } else {
      // If group has no configured banks, mention that bank list is not configured
      supportedBanksList = 'No banks configured for this group';
    }
  } catch (e) {
    supportedBanksList = SUPPORTED_BANKS.join(', ');
  }

  const banksInfoText = `\n\nSUPPORTED BANKS FOR DEPOSITS/WITHDRAWALS:\n${supportedBanksList.split(', ').map(b=>'- '+b).join('\n')}\n\nWhen user asks about banks ("bank apa saja?", "which banks?", "daftar bank"):\n- List these banks in a friendly, concise way\n- Mention that account changes require verification (account holder name & number)\n- Use intent: "bankinfo"`;
  
  // Load and add deposit/withdrawal limits to the prompt
  const limits = await getDepositWithdrawalLimits(chatId);
  let limitsInfoText = '\n\nDEPOSIT & WITHDRAWAL LIMITS:\n';
  if (limits.minDeposit || limits.maxDeposit || limits.minWithdrawal || limits.maxWithdrawal) {
    if (limits.minDeposit) limitsInfoText += `- Minimum Deposit: Rp ${formatDepositAmount(limits.minDeposit)}\n`;
    if (limits.maxDeposit) limitsInfoText += `- Maximum Deposit: Rp ${formatDepositAmount(limits.maxDeposit)}\n`;
    if (limits.minWithdrawal) limitsInfoText += `- Minimum Withdrawal: Rp ${formatDepositAmount(limits.minWithdrawal)}\n`;
    if (limits.maxWithdrawal) limitsInfoText += `- Maximum Withdrawal: Rp ${formatDepositAmount(limits.maxWithdrawal)}\n`;
    limitsInfoText += `\nWhen user asks about limits ("berapa minimal deposit?", "maximum withdrawal?", "batas deposit"):
- Provide the limits clearly with emojis
- Format amounts with proper Indonesian number formatting (e.g., Rp 10.000, Rp 5.000.000)
- Be friendly and helpful
- Use intent: "limits"`;
  } else {
    limitsInfoText = '\n\nDEPOSIT & WITHDRAWAL LIMITS: Not configured. Tell user to contact CS for limit information.';
  }
  
  const systemPrompt = hasCustomRules
    ? `You are a human support agent for ${brandForPrompt}. Follow ONLY the group-specific instructions below.

CUSTOM RULES:
${(aiCfg.customRules || '').toString().trim()}

${aiCfg.exampleMessage ? `STYLE EXAMPLE:\n${aiCfg.exampleMessage.toString().trim()}\n` : ''}${customMessagesText}${banksInfoText}${limitsInfoText}
Return ONLY one JSON object per the required schema.`
    : `${buildSupportPromptForBrand(brandForPrompt)}

Additional context (use to infer intent and fill JSON fields):
- userId: ${context.userId || 'null'}
- amount: ${context.depositAmount || context.lastDepositCheck?.amount || 'null'}
- language: ${context.language || 'id'}
- recent_messages: ${context.conversationHistory.slice(-3).map(h => `${h.type}: ${h.message}`).join('; ')}${customMessagesText}${banksInfoText}${limitsInfoText}

CRITICAL REMINDERS FOR EVERY RESPONSE:
- ALWAYS use emojis 🎰😊💰🔥 in your responses (at least 1-2 per message)
- ALWAYS call the user "bosku" (Indonesian for "boss")
- ALWAYS write in casual, friendly Bahasa Indonesia
- Be warm, supportive, and fun - like chatting with a friend
- Present yourself as a human support agent; NEVER state or imply you are a bot/AI/model
- No politics or political opinions; treat political topics as off-topic
- No profanity; keep replies polite and encouraging
- IMPORTANT items are top-level directives and override any conflicting instructions. Always apply IMPORTANT first
- Return ONLY a single JSON object exactly matching the schema in the prompt (no extra text)

SMART CONTEXT AWARENESS & COMPREHENSIVE SLANG MASTERY:
- Remember what you discussed in recent messages
- If user says "yes", "ok", "that one" - they're continuing the previous topic
- If user gives just a number/amount, they're probably continuing deposit/withdrawal topic
- **MASTER ALL INDONESIAN SLANG** - Understand EVERY variation perfectly:
  • Pronouns: gw/gue/ane=saya, lo/lu/elu=kamu, doi=dia
  • Yes/No: ya/iya/yoi=yes, ga/gak/enggak/ngga=tidak
  • Time: udh/dah=sudah, blm/blom=belum, skrg/skg=sekarang, ntar=nanti
  • Verbs: pgn/pengen=ingin, mo=mau, bs/bsa=bisa, tlg=tolong, bntu=bantu
  • Casino: depo/dp=deposit, wd=withdraw, promo/prm=promosi, sldo=saldo, duit/cuan=uang
  • Questions: gmn/gimana=bagaimana, brp=berapa, knp/napa=kenapa, dmn=dimana
  • Adverbs: bgt/bngt=banget, bnr/bener=benar, byk=banyak, dkit=sedikit, cpet=cepat
  • Phrases: gpp/gapapa=tidak apa apa, makasih/mksh/thx=terima kasih, maf=maaf
  • Amounts: 50k/50rb=50.000, 100k=100.000, 1jt/1m=1.000.000
- **EXAMPLES**: "depo gw blm masuk"=deposit saya belum masuk, "wd 500k kok lama bgt?"=withdrawal 500.000 kok lama banget?, "gmn cara dpt bonus?"=bagaimana cara dapat bonus?
- Be patient with typos and casual language
- Don't repeat yourself - vary your responses naturally
- Add helpful tips occasionally (not every time)
- NEVER ask for clarification on common Indonesian slang - understand it perfectly!

CRITICAL RULES FOR SPECIFIC TOPICS:
- **PROMOTIONS**: NEVER list or summarize promotions yourself. If user asks about promos/bonuses, tell them you're fetching the list. The system will automatically display the formatted promotion list.
  Good: "Tunggu sebentar bosku, saya ambilkan daftar promo terbaru ya! 🎁😊"
  Bad: "Tentu! Saat ini kami memiliki Welcome Bonus, Weekend Reload, etc."
- **RTP/GAMES**: NEVER list games yourself. Tell user you're getting the info.
  Good: "Saya carikan info RTP terbaru bosku! 🎰"
  Bad: "Game yang tersedia: Slot A, Slot B, etc."
- **BANKS**: When user asks about supported banks, list them concisely with emojis. Mention that we support major Indonesian banks.
  Good: "Kami terima transfer dari bank BCA, Mandiri, BNI, BRI, CIMB Niaga, Permata, Danamon, dan banyak lagi bosku! 🏦💰 Mau ganti rekening? Nanti kami pandu verifikasinya ya 😊"
  Bad: "Maaf saya tidak tahu bank apa saja yang diterima."
- **LIMITS**: When user asks about deposit/withdrawal limits or minimum/maximum amounts, provide the limits clearly.
  Good: "Minimal deposit Rp 10.000 bosku, maksimal Rp 5.000.000 💰 Untuk withdrawal minimal Rp 50.000 ya! 😊"
  Bad: "Maaf saya tidak tahu berapa batas deposit."

Example good responses:
- "Baik bosku! Saya bantu cek deposit ya. Boleh minta User ID-nya? 💰😊"
- "Siap bosku! Withdrawal biasanya 1-5 menit aja. Mohon ditunggu ya 🔥"
- "Tunggu sebentar bosku, saya ambilkan daftar promo terbaru ya! 🎁😊"
- "Santai bosku! 😊 Semua pemain juga pernah ngalamin hal yang sama. Coba istirahat sebentar dulu ya 💪"
- "Kami support semua bank major Indonesia bosku! BCA, Mandiri, BNI, BRI, dll 🏦 Transfer langsung masuk kok 💰😊"`;



  // Include memory summary and recent history for fallback mode as well
  let memorySummaryForFallback = null;
  try { memorySummaryForFallback = await updateConversationMemory(chatState).catch(() => null); } catch (_) { memorySummaryForFallback = null; }
  const fallbackHistory = (context.conversationHistory || []).slice(-10).map(h => ({ role: h.type === 'agent' ? 'assistant' : 'user', content: String(h.message || '') }));
  const fallbackMessages = [
        { role: 'system', content: systemPrompt },
        ...(memorySummaryForFallback ? [{ role: 'system', content: `Memory summary (short):\n${memorySummaryForFallback}` }] : []),
        { role: 'system', content: `Kunci bahasa: Selalu balas HANYA dalam Bahasa Indonesia.` },
        ...fallbackHistory,
        { role: 'user', content: userMessage }
  ];

  const response = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: fallbackMessages,
      temperature: 0.3,
      max_tokens: 300,
  }, await buildMeta(chatId, 'gc.fallback', { injectGroupRules: hasCustomRules }));

    let customerReply = response.choices[0].message.content.trim();
    // Try to parse JSON per GOODCASINO schema and extract the user-facing reply
    try {
      const parsed = JSON.parse(customerReply);
      if (parsed && typeof parsed === 'object') {
        if (parsed.context) {
          if (parsed.context.userId) context.userId = parsed.context.userId;
          if (parsed.context.amount) context.depositAmount = parsed.context.amount;
          if (parsed.context.language) context.language = parsed.context.language;
        }
        if (parsed.intent) {
          context.issueType = parsed.intent;
        }
        if (parsed.reply && typeof parsed.reply === 'string') {
          customerReply = parsed.reply;
        }
      }
    } catch (_) {
      // If not JSON, keep original string
    }
  // If response system gives a generic, empty, or unhelpful answer, fallback
    if (!customerReply || customerReply.length < 3 || /i\s*am\s*an\s*ai|as an ai|i'm an ai|i am an ai|i am a language model|i cannot|i'm sorry|i do not understand|i don't know|i am unable/i.test(customerReply)) {
      const templates = context.language === 'id' ? [
        "Ada yang bisa saya bantu lagi bosku? 😊",
        "Bosku, saya tidak paham maksudmu. Bisakah kamu jelaskan lagi? 🤔",
        "Maaf bosku, saya tidak bisa membantu dengan itu. 😊🎰"
      ] : [
        "What can i help you with boss? 😊",
        "Boss, I didn't quite get that. Can you explain again? 🤔",
        "Sorry boss, I'm not sure I can help with that. 😊"
      ];
      customerReply = templates[Math.floor(Math.random() * templates.length)];
    }
    
    // POST-PROCESSING: Ensure proper emoji and "bosku" usage
    // Check if response is in Indonesian and missing key elements
    if (context.language === 'id' || /^[^a-zA-Z]*$/.test(customerReply.substring(0, 20))) {
      // Add "bosku" if completely missing (but don't overdo it)
      const hasBoskuVariant = /\bbosku\b|\bbos\b|\bkak\b|\bgan\b/i.test(customerReply);
      if (!hasBoskuVariant && customerReply.length > 10 && !/^(baik|siap|ok|oke|terima kasih|mohon|tunggu)/i.test(customerReply)) {
        // Add bosku naturally at the beginning if it's a longer response
        const startsWithGreeting = /^(halo|hai|selamat)/i.test(customerReply);
        if (startsWithGreeting) {
          customerReply = customerReply.replace(/^(halo|hai|selamat[^!.]*)([!.]?)/i, '$1 bosku$2');
        }
      }
      
      // Ensure at least one emoji is present
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(customerReply);
      if (!hasEmoji) {
        // Add contextual emoji based on content
        if (/deposit|depo|setor/i.test(customerReply)) {
          customerReply += ' 💰';
        } else if (/withdraw|tarik|wd/i.test(customerReply)) {
          customerReply += ' 💸';
        } else if (/promo|bonus/i.test(customerReply)) {
          customerReply += ' 🎁';
        } else if (/game|slot|main/i.test(customerReply)) {
          customerReply += ' 🎰';
        } else if (/terima kasih|thank/i.test(customerReply)) {
          customerReply += ' 😊';
        } else if (/tunggu|wait|proses/i.test(customerReply)) {
          customerReply += ' ⏳';
        } else if (/santai|tenang|sabar/i.test(customerReply)) {
          customerReply += ' 😊💪';
        } else {
          // Default friendly emoji
          customerReply += ' 😊';
        }
      }
    }
    
    // Check if this exact response was already sent recently
    if (wasMessageSentInChat(chatId, customerReply)) {
      console.log(`🚫 Skipping duplicate AI response in chat ${chatId}`);
      return null;
    }
    
    // No translation needed (Indonesian only)

    // IMPORTANT: Never reveal bot identity; sanitize profanity
    const profanityRe = /(anjing|bangsat|kontol|memek|pepek|pantek|goblog|goblok|tolol|bajingan|fuck|shit|bitch|asshole|bastard|cunt)/i;
    if (profanityRe.test(customerReply)) {
      customerReply = customerReply.replace(profanityRe, '***');
    }
    const identityLeakRe = /(saya\s+adalah\s+bot|saya\s+adalah\s+ai|saya\s+adalah\s+model|as an ai|i am an ai|i am a bot|i'm a bot|language model)/i;
    if (identityLeakRe.test(customerReply)) {
      customerReply = 'Saya support agent di sini untuk bantu Anda.';
    }

    context.conversationHistory.push({
      message: customerReply,
      timestamp: Date.now(),
      type: 'agent'
    });
    
    chatState.lastProcessedMessageId = messageId;
    chatState.lastResponseTime = Date.now();
    markMessageSentInChat(chatId, customerReply);
    
    return customerReply;
    
  } catch (error) {
    console.error('Response system error:', error.message);
    const templates = [
      "Ada yang bisa saya bantu lagi bosku? 😊",
      "Bosku, saya tidak paham maksudmu. Bisakah kamu jelaskan lagi? 🤔",
      "Maaf bosku, saya tidak bisa membantu dengan itu. 😊"
    ];
    let fallbackMessage = templates[Math.floor(Math.random() * templates.length)];
    
    // Check if this exact fallback was already sent recently
    if (wasMessageSentInChat(chatId, fallbackMessage)) {
      console.log(`🚫 Skipping duplicate fallback message in chat ${chatId}`);
      return null;
    }
    
    markMessageSentInChat(chatId, fallbackMessage);
    return fallbackMessage;
  }
}

// Get appropriate warning message based on warning count and message type
async function getWarningMessage(chatState, _language) {
  const warningCount = chatState.offTopicWarningCount || 0;
  
  // Custom warning messages (Indonesian only)
  const messages = [
    "Saya di sini untuk membantu dengan dukungan kasino dan permainan. Bisakah Anda beri tahu apa yang ingin Anda ketahui tentang permainan atau layanan kami?",
    "Sepertinya pertanyaan Anda tidak terkait layanan kami. Saya bisa bantu informasi permainan, deposit, penarikan, atau masalah akun. Ada yang bisa saya bantu?",
    "Mari kita fokus pada dukungan kasino dan permainan. Jika ada pertanyaan tentang game, deposit, atau akun, saya siap bantu!"
  ];

  const idx = Math.min(warningCount - 1, messages.length - 1);
  if (idx >= 0) {
    // REMOVED: Automatic RTP link spam after every off-topic message
    // Only return the helpful redirect message, without forcing RTP link
    return messages[idx];
  }

  // Default fallback (Indonesian only)
  if (warningCount === 1) return "Bosku, saya tidak paham maksudmu. Bisakah kamu jelaskan lagi? 🤔";
  if (warningCount === 2) return "Maaf bosku, saya tidak bisa membantu dengan itu. 😊";
  if (warningCount >= 3) return "Bosku, saya tidak bisa membantu dengan pertanyaan yang tidak terkait dengan layanan kami. 😊";
  return "Ada yang bisa saya bantu lagi bosku? 😊";
}

// API Functions - ULTRA FAST VERSION
async function acceptChat(chatId) {
  try {
    await livechatPost('/agent/action/accept_chat', { chat_id: chatId }, { retries: 1, backoffMs: 300, label: 'accept_chat' });
    console.log(`🙋 Accepted chat ${chatId}`);
    return true;
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.warn(`accept_chat failed for ${chatId}: ${msg}`);
    return false;
  }
}

async function joinChat(chatId) {
  try {
    await livechatPost('/agent/action/join_chat', { chat_id: chatId }, { retries: 1, backoffMs: 300, label: 'join_chat' });
    console.log(`🤝 Joined chat ${chatId}`);
    return true;
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    // It's fine if we are already a member
    if (/already\s+in\s+chat/i.test(msg)) {
      return true;
    }
    console.warn(`join_chat failed for ${chatId}: ${msg}`);
    return false;
  }
}

async function ensureChatActive(chatId) {
  try {
    const data = await livechatPost('/agent/action/get_chat', { chat_id: chatId }, { retries: 1, backoffMs: 300, label: 'get_chat' });
  const status = (data?.chat?.status || data?.status || '').toString().toLowerCase();
  if (!status) return false; // be conservative if unknown
  if (status.includes('archived') || status.includes('closed') || status.includes('inactive') || status.includes('ended') || status.includes('resolved')) return false;
  if (status.includes('queued') || status.includes('pending')) {
      await acceptChat(chatId);
    }
    // Ensure we're a participant
    await joinChat(chatId);
    return true;
  } catch (e) {
    console.warn(`ensureChatActive failed for ${chatId}:`, e.response?.data?.error?.message || e.message);
  return false; // don't proceed when we can't verify
  }
}

// Safe sendMessage with single sequential attempt to avoid duplicate sends
async function sendMessage(chatId, message) {
  try {
    // Skip if chat is under cooldown
    const until = inactiveChatUntil.get(chatId) || 0;
    if (until && Date.now() < until) {
      console.log(`⏸️  Skipping send to ${chatId} (cooldown active)`);
      return false;
    }
    const okActive = await ensureChatActive(chatId);
    if (!okActive) {
      console.log(`📁 Chat ${chatId} not active; skipping send.`);
      return false;
    }
    await livechatPost(
      '/agent/action/send_event',
      {
        chat_id: chatId,
        event: {
          type: 'message',
          text: message,
          recipients: 'all'
        }
      },
      { retries: 3, backoffMs: 500, label: 'send_event' }
    );
    console.log(`✅ Message sent to ${chatId}`);
    return true;
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message || '';
    console.log('sendMessage failed:', errMsg);
    // If chat is not active/closed, avoid retrying blindly
    if (/chat\s*not\s*active/i.test(errMsg) || /closed/i.test(errMsg) || /not\s*found/i.test(errMsg)) {
      console.log(`🔁 Attempting to accept/join chat ${chatId} and retry once...`);
      const ok = await ensureChatActive(chatId);
      if (ok) {
        try {
          await livechatPost(
            '/agent/action/send_event',
            {
              chat_id: chatId,
              event: { type: 'message', text: message, recipients: 'all' }
            },
            { retries: 1, backoffMs: 300, label: 'send_event_retry' }
          );
          console.log(`✅ Message sent to ${chatId} after re-activating`);
          return true;
        } catch (e2) {
          const msg2 = e2.response?.data?.error?.message || e2.message;
          console.log('Retry send failed:', msg2);
        }
      }
  // Put chat on cooldown for 15 minutes to avoid repeated attempts
  inactiveChatUntil.set(chatId, Date.now() + 15 * 60 * 1000);
      console.log(`📁 Chat ${chatId} appears inactive/closed; skipping further sends this cycle.`);
    }
    return false;
  }
}

async function getLatestCustomerMessage(chatId) {
  try {
    const data = await livechatPost(
      '/agent/action/list_threads',
      { chat_id: chatId },
      { retries: 2, backoffMs: 700, label: 'list_threads' }
    );

    const allEvents = (data.threads || data?.data?.threads || []).flatMap(thread => thread.events || []);
    
    const customerMessages = allEvents
      .filter(event => {
        // Must be a message with text
        if (event.type !== 'message' || !event.text || !event.author_id) {
          return false;
        }
        // Only consider customer-authored messages when available
        if (event.author_type && String(event.author_type).toLowerCase() !== 'customer') {
          return false;
        }
        // Exclude agent, bot, and system messages
        const authorId = event.author_id.toLowerCase();
        if (authorId.includes('agent') || authorId.includes('bot') || authorId.includes('system')) {
          return false;
        }
        
        // Exclude messages that look like bot responses
        const messageText = event.text.toLowerCase();
        const botIndicators = [
          'hello boss', 'how can i help', 'bosku', 'mohon ditunggu', 'baik bosku',
          'selamat bermain', 'good luck', 'terima kasih', 'thank you',
          'deposit has been processed', 'withdrawal has been processed',
          'please wait', 'mohon menunggu', 'will be processed', 'ty', 'thanks', 'thank',
          'terimakasih', 'makasih', 'tq', 'thx', 'tyvm', 'tysm'
        ];
        
        if (botIndicators.some(indicator => messageText.includes(indicator))) {
          return false;
        }
        
        return true;
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (customerMessages.length === 0) return null;

    const latestMessage = customerMessages[0];
    return {
      ...latestMessage,
      messageId: `${chatId}_${latestMessage.id || Date.now()}`
    };
    
  } catch (error) {
    console.error(`❌ Error getting messages for ${chatId}:`, error.response?.data || error.message);
    return null;
  }
}

// Check if chat is archived
async function isChatArchived(chatId) {
  try {
    const data = await livechatPost(
      '/agent/action/get_chat',
      { chat_id: chatId },
      { retries: 2, backoffMs: 600, label: 'get_chat' }
    );
    
    // Check if chat status is archived
    const status = data?.chat?.status || data?.status || data?.data?.chat?.status;
    return status === 'archived' || status === 'closed';
    
  } catch (error) {
    console.error(`❌ Error checking chat status for ${chatId}:`, error.response?.data || error.message);
    return false; // Assume not archived if we can't check
  }
}

// Helper function to ensure response ends with a thank you message
function ensureThankYouMessage(response, language = 'en') {
  if (!response) return response;
  
  const thankYou = '';
  
  // Only skip if an explicit thank-you phrase already exists
  const lower = response.toLowerCase();
  const hasThanks = lower.includes('thank you') || lower.includes('terima kasih');
  if (hasThanks) return response;

  // Always append the thank-you message
  return `${response.trim()} ${thankYou}`;
}

// Cleanup old data every 2 hours
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [chatId, chatState] of chatStates.entries()) {
    if (now - chatState.started > 24 * 60 * 60 * 1000) { // 24 hours
      chatStates.delete(chatId);
      cleaned++;
    }
  }
  
  // Clean old response times
  for (const [chatId, responseTime] of lastResponseTimes.entries()) {
    if (now - responseTime > 60 * 60 * 1000) { // 1 hour
      lastResponseTimes.delete(chatId);
    }
  }
  
  // Clean old sent messages
  for (const [chatId, sentMessagesSet] of sentMessages.entries()) {
    const recentMessages = Array.from(sentMessagesSet).filter(msg => {
      return now - msg.timestamp < 10 * 60 * 1000; // Keep only last 10 minutes
    });
    if (recentMessages.length === 0) {
      sentMessages.delete(chatId);
    } else {
      sentMessages.set(chatId, new Set(recentMessages));
    }
  }
  
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old chat states`);
}, 2 * 60 * 60 * 1000);

// Additional cleanup every 30 minutes for better performance
setInterval(() => {
  const now = Date.now();
  
  // Clean old response times more frequently
  for (const [chatId, responseTime] of lastResponseTimes.entries()) {
    if (now - responseTime > 30 * 60 * 1000) { // 30 minutes
      lastResponseTimes.delete(chatId);
    }
  }
  
  // Clean old sent messages more frequently
  for (const [chatId, sentMessagesSet] of sentMessages.entries()) {
    const recentMessages = Array.from(sentMessagesSet).filter(msg => {
      return now - msg.timestamp < 5 * 60 * 1000; // Keep only last 5 minutes
    });
    if (recentMessages.length === 0) {
      sentMessages.delete(chatId);
    } else {
      sentMessages.set(chatId, new Set(recentMessages));
    }
  }
}, 30 * 60 * 1000);

// Export functions for testing
module.exports = {
  detectOffTopic,
  getTemplateResponse,
  getChatState,
  extractContext,
  shouldSkipResponse,
  wasMessageSentInChat,
  markMessageSentInChat,
  getCustomerServiceResponse,
  // Expose helpers so external modules (like server2 batching) can reuse finalizer and rewrite
  sendAgentReply,
  rewriteWithLlm,
  summarizeCombined,
  // Enhanced smart detection functions (added for server integration)
  isDepositInquiry,
  isWithdrawalInquiry,
  detectLanguage,
  isOffTopicConversation,
  detectIntentsLLM,
  // Deposit & Withdrawal limits functions
  getDepositWithdrawalLimits,
  getDepositLimitsText,
  getWithdrawalLimitsText,
  getCustomMessages,
  formatAmount: formatDepositAmount, // Export the imported function with the old name for compatibility
  // Allow server to update brand name live when settings change
  setGlobalBrandName: function setGlobalBrandName(newName) {
    try { updateGlobalBrandName(String(newName || '')); } catch (_) {}
  },
  // Reload all settings from file (clear cache)
  reloadSettings: function reloadSettings() {
    console.warn('reloadSettings called but global settings are deprecated. Use group-level settings and clearGroupCaches(groupId) after updates.');
    return true;
  },
  // Clear group-related caches after group-level updates
  clearGroupCaches: function clearGroupCaches(groupId) {
    try {
      if (groupId != null) {
        groupConfigCache.delete(Number(groupId));
        groupPromotionsCache.delete(Number(groupId));
        console.log('✅ Cleared caches for group', groupId);
      } else {
        groupConfigCache.clear();
        groupPromotionsCache.clear();
        console.log('✅ Cleared all group caches');
      }
      return true;
    } catch (e) {
      console.warn('clearGroupCaches failed:', e && e.message ? e.message : e);
      return false;
    }
  }
};

// Small deterministic simulator wrapper for tests/scripts.
// Calls the main getCustomerServiceResponse path so behaviour matches runtime.
async function simulateReply(message, chatId, options = {}) {
  try {
    // Ensure chat state exists
    if (chatId != null) getChatState(chatId);
    const mid = `${chatId || 'sim'}_${Date.now()}`;
    const reply = await getCustomerServiceResponse(chatId, String(message || ''), mid);
    return reply;
  } catch (e) {
    console.error('simulateReply error:', e && e.message ? e.message : e);
    // Return an error object instead of throwing so callers (scripts/tests)
    // can handle failures without crashing the process.
    return { error: e && e.message ? e.message : String(e) };
  }
}

// Expose simulator globally for legacy scripts that check global.__gc_simulateReply
try { if (typeof global !== 'undefined') global.__gc_simulateReply = simulateReply; } catch (_) {}

// Add simulateReply to the exported API
module.exports.simulateReply = simulateReply;

if (require.main === module) {
  (async () => {
    const readline = require('readline');
    const { initDb } = require('./db-utils.js');

    await initDb();

    // Basic CLI arg parsing (e.g., --chat mychat --message "hello")
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (token.startsWith('--')) {
        const key = token.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      } else if (!options.message) {
        options.message = token;
      }
    }

    const chatId = String(options.chat || options.chatId || `standalone_${Date.now()}`);
    const initialMessage = options.message || options.msg || '';
    const groupId = options.group ? Number(options.group) : null;

    // If group specified, map the chat to it
    if (groupId && Number.isFinite(groupId)) {
      const { setChatGroup } = require('./db-utils.js');
      try {
        await setChatGroup(chatId, groupId);
        console.log(`📌 Mapped chat ${chatId} to group ${groupId}`);
      } catch (e) {
        console.warn('Failed to map chat to group:', e.message);
      }
    }

  console.log('🤖 GoodCasino AI Assistant (standalone mode)');
  console.log('   • Type your message and press Enter');
  console.log('   • Ctrl+C to exit');
  console.log('   • Use --message "hi" for one-off replies');
  console.log('   • Use --group <id> to test with a specific group');
  console.log('');

    // Helper to get a reply
    async function respond(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return '(no response)';
      try {
        getChatState(chatId);
        const reply = await getCustomerServiceResponse(chatId, trimmed, `${chatId}_${Date.now()}`);
        // reply may be a string or a structured JSON object { reply: 'text', ... }
        if (!reply) return '(no response)';
        if (typeof reply === 'string') return reply.trim() || '(no response)';
        if (typeof reply === 'object') {
          // Prefer `.reply` field when present
          if (typeof reply.reply === 'string') return reply.reply.trim() || '(no response)';
          // Fallback to stringifying minimal useful fields
          try {
            if (reply && typeof reply === 'object') return (reply.text || reply.message || JSON.stringify(reply)).toString().trim() || '(no response)';
          } catch (_) { return '(no response)'; }
        }
        return '(no response)';
      } catch (error) {
        console.error('❌ Failed to generate response:', error.message || error);
        return '(error generating response)';
      }
    }

    if (initialMessage) {
      const reply = await respond(initialMessage);
      console.log(`You  > ${initialMessage}`);
      console.log(`Bot  > ${reply}`);
      process.exit(0);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You  > ' });
    rl.prompt();

    rl.on('line', async (line) => {
      const userText = line.trim();
      if (!userText) {
        rl.prompt();
        return;
      }
      const reply = await respond(userText);
      console.log(`Bot  > ${reply}`);
      rl.prompt();
    });

    rl.on('close', () => {
      console.log('👋 Bye!');
      process.exit(0);
    });
  })().catch((err) => {
    console.error('❌ Standalone bot failed to start:', err.message || err);
    process.exit(1);
  });
}


