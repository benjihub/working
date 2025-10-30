// Group-aware reply engine
// Produces JSON responses strictly based on per-group aiSettings
// JSDoc used for clarity in this JS codebase

const aiClient = require('../utils/aiClient');
const { getDb } = require('../db-utils');
const db = require('../db-utils');
const path = require('path');
const fs = require('fs').promises;

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json');
const DEFAULT_BRAND_NAME = 'VIP sec 45';
let globalBrandName = DEFAULT_BRAND_NAME;


/**
 * Resolve the internal group id for a chat.
 * @param {string} chatId
 * @param {object} [context] optional webhook/chat context carrying group hints
 * @returns {Promise<number|null>}
 */
async function resolveGroupId(chatId, context = null) {
  let groupId = null;
  let fromDb = false;
  try {
    // Prefer persisted mapping
    const gidRow = await db.getChatGroup(String(chatId));
    // db.getChatGroup returns a row object { group_id: <num> } or null
    if (gidRow != null) {
      const val = gidRow.group_id ?? gidRow.groupId ?? gidRow.GROUP_ID ?? gidRow;
      const num = Number(val);
      if (!Number.isNaN(num)) {
        groupId = num;
        fromDb = true;
      }
    }
  } catch (_) {}
  if (groupId == null) {
    // If caller provided an internal group id directly in context, honor it
    try {
      if (context) {
        // Look for common shapes used by our Chatbot call-site
        const direct = (
          context.group_id ?? context.groupId ??
          context.chat?.group_id ?? context.chat?.groupId ??
          context.thread?.group_id ?? context.thread?.groupId
        );
        const num = Number(direct);
        if (!Number.isNaN(num) && num != null) groupId = num;
      }
    } catch (_) {}
    // Try mapping via helper if minimal context provided
    try {
      if (groupId == null && context) {
        const { mapChatToGroup } = require('../livechat-group-helpers');
        const mapped = await mapChatToGroup(context);
        if (mapped && mapped.internalGroupId != null) groupId = Number(mapped.internalGroupId);
      }
    } catch (_) {}
  }
  // Persist the mapping if it was resolved from context/helper and not already in DB
  if (groupId != null && !fromDb) {
    try {
      await db.setChatGroup(String(chatId), groupId);
    } catch (e) {
      // Ignore save errors to avoid blocking
    }
  }
  return groupId;
}

/**
 * Load group settings from db-utils (READ-ONLY facade).
 * @param {number} groupId
 * @returns {Promise<{groupId:number, brand:string|null, aiSettings:Object}>}
 */
async function getGroupSettings(groupId) {
  try {
    const cfg = await db.getGroupConfig(Number(groupId));
    if (!cfg) return null;
    const aiRaw = cfg.aiSettings || {};
    const brand = cfg.brandName || aiRaw.brandName || null;
    // Preserve ALL aiSettings keys while normalizing common ones
    const aiSettings = { ...aiRaw };
    aiSettings.brandName = brand || null;
    aiSettings.welcomeMessage = aiSettings.welcomeMessage || (aiSettings.customMessages && aiSettings.customMessages.welcomeMessage) || null;
    aiSettings.aiBehaviour = (aiSettings.aiBehaviour || aiSettings.customRules || '').toString();
    aiSettings.rtpLink = aiSettings.rtpLink || cfg.rtpLink || null;
    aiSettings.depositLimits = aiSettings.depositLimits || aiSettings.limits || null;
    aiSettings.withdrawLimits = aiSettings.withdrawLimits || aiSettings.limits || null;
    aiSettings.promotions = await db.listGroupPromotions(groupId);
    // If group has no promotions in DB table, fall back to global promotions
    if (!Array.isArray(aiSettings.promotions) || aiSettings.promotions.length === 0) {
      try {
        const { getPromotions } = require('../promotions');
        const globalPromos = await getPromotions() || [];
        aiSettings.promotions = globalPromos;
      } catch (e) {
        // Ignore, keep empty
      }
    }
    // Common extra fields: pass through if present
    aiSettings.banks = Array.isArray(aiSettings.banks) ? aiSettings.banks : (Array.isArray(aiSettings.paymentBanks) ? aiSettings.paymentBanks : aiSettings.banks || null);
    aiSettings.paymentMethods = Array.isArray(aiSettings.paymentMethods) ? aiSettings.paymentMethods : (Array.isArray(aiSettings.methods) ? aiSettings.methods : aiSettings.paymentMethods || null);
    aiSettings.supportLinks = aiSettings.supportLinks || aiSettings.links || null;

    return { groupId: Number(groupId), brand, aiSettings };
  } catch (e) {
    return null;
  }
}

/**
 * Lightweight intent detector.
 * @param {string} text
 * @returns {'deposit'|'withdraw'|'promotion'|'rtp'|'games'|'register'|'general'}
 */
function detectIntent(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(daftar|register|buat akun|signup|registrasi)\b/.test(t)) return 'register';
  if (/\b(deposit|depo|dp|top\s?up|topup|isi saldo|minimal depo|max(imum)? depo)\b/.test(t)) return 'deposit';
  if (/\b(withdraw|wd|tarik|penarikan|cair|withdrawal)\b/.test(t)) return 'withdraw';
  if (/\b(promo|promosi|bonus|event)\b/.test(t)) return 'promotion';
  if (/\brtp\b/.test(t)) return 'rtp';
  if (/\b(game|games|slot|slots|gacor|permainan|daftar game|game apa|slot apa)\b/.test(t)) return 'games';
  return 'general';
}

/**
 * Build a strict system prompt from aiSettings.
 * @param {object} s normalized aiSettings {brandName, aiBehaviour, rtpLink, depositLimits, withdrawLimits, promotions}
 * @returns {string}
 */
function composeSystemPrompt(s) {
  const brand = s.brandName || 'GoodCasino';
  const behaviour = (s.aiBehaviour || '').toString().trim();
  const limitsDep = s.depositLimits ? JSON.stringify(s.depositLimits) : 'null';
  const limitsWdr = s.withdrawLimits ? JSON.stringify(s.withdrawLimits) : 'null';
  const rtp = s.rtpLink ? String(s.rtpLink) : 'null';
  const promos = Array.isArray(s.promotions) ? s.promotions : [];
  const promosStr = JSON.stringify(promos);
  // Payment details extraction for clearer prompt guidance
  const banks = Array.isArray(s.banks) ? s.banks : (Array.isArray(s.paymentBanks) ? s.paymentBanks : (Array.isArray(s.paymentMethods) ? s.paymentMethods : []));
  const ewallets = Array.isArray(s.ewallets) ? s.ewallets : [];
  const qrisEnabled = !!s.qris;
  return (
`You are the ${brand} Support Assistant.
Follow these rules STRICTLY:
  * If user asks "promotions?" list ONLY titles.
  * If user asks details for a promo, return ONLY Terms for that promo.
  * If user asks how to claim a promo, return ONLY howToClaim for that promo.
  * When asked deposit/withdraw limits, use EXACT values from aiSettings.
  * If asked, provide rtpLink from aiSettings if present.
  
--

aiBehaviour: ${behaviour}
aiSettings:
{
  "brandName": ${JSON.stringify(brand)},
  "rtpLink": ${JSON.stringify(rtp)},
  "depositLimits": ${limitsDep},
  "withdrawLimits": ${limitsWdr},
  "promotions": ${promosStr}
}


You MUST ALWAYS reply in pure JSON with schema:
{
  "reply": "string",
  "intent": "deposit|withdraw|promotion|rtp|games|register|general",
  "context": {
    "groupId": "string",
    "brand": "string",
    "limits": {"deposit": "…", "withdraw": "…"} | null,
    "rtpLink": "string|null",
    "promotion": {"title":"string","terms":["..."],"howToClaim":["..."]} | null
  }
}
Output only the JSON object; no extra text.`);
}

// Full-settings prompt variant that exposes the entire aiSettings
function composeSystemPromptFull(s) {
  const brand = s.brandName || 'GoodCasino';
  const behaviour = (s.aiBehaviour || '').toString().trim();
  const fullAiSettings = JSON.stringify(s);
  return (
`You are a smart, friendly, and natural ${brand} support assistant, you must reply while understanding and remembering the conversation context.  who understands different formats of user IDs.
when asking for USER ID, ACCEPT ANY SINGLE WORD (even though it looks like a typo) RESPONSE as potential USER ID and comfirm receipt and then stricky tell the 
user to wait while you process it. Make you under every indonesian slang and sentences, informal chat, and typos naturally. make sure to follow these instructions strictly. 

Follow these rules STRICTLY:

 Core Identity and Scope
- You are exclusively the ${brand} Support Assistant
- You handle:
  * Deposits & withdrawals
  * Promotions & bonuses  ss
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

Core Rules
- Only use the welcome message from aiSettings when greeting a user for the first time
- ALWAYS respond in valid JSON format - never plain text
- Don't strictly use the words provided it the example responses - rephrase naturally in chill, slangly tone
- Default to Bahasa Indonesia (id) - switch only if user explicitly requests another language
- Tone: Chill, slangly, fun, and supportive — like chatting with a friend. Use "bosku" and emojis 🎰😊🔥 when appropriate.
- NEVER reveal you're an AI/bot — present as part of the ${brand} support team
- Keep messages concise until all details are collected
- Always use the set welcome message from aiSettings when greeting a user for the first time
- Encourage frustrated users and gently remind about responsible gambling
- NEVER invent promo details, links, limits, or codes not present in aiSettings


Core capabilities you should handle:

Promotions handling (phased):
Phased Promotion Handling

Phase 1 - Titles Only (When user asks for promotions):
- Show ONLY promotion titles with short teasers in bullet points
- Format:
"Promo ${brand}! 🎁  
- [Promo Title 1] 
- [Promo Title 2]"

Phase 2 - Details (When user asks for specific promo details):
- Show Title + Terms & Conditions in bullet point format
- Format:
"[Promo Title]
Syarat & ketentuan:
- [Term 1]
- [Term 2] 
- [Term 3]
- [Term 4]"

Phase 3 - Claim Instructions (When user asks "how to claim"):
- Show ONLY the How to Claim section in bullet points
- Format:
"Cara klaim:
- [Step 1]
- [Step 2]
- [Step 3]"

Promotion Structure Understanding
Each promotion has three components you must separate:
1. Promotion Name / Title
2. Terms and Conditions (T&C) 
3. How to Claim Instructions


Payment method responses:
- Accept and map slang tokens (e.g., gw/gue/gua for I; lo/lu for you; depo/dp for deposit; wd for withdraw; saldo for balance).

JSON response contract:
- ALWAYS reply in valid JSON and nothing else. The assistant's output MUST be exactly one JSON object.

When users ask about DEPOSIT PROBLEMS (missing, not processed, delayed):
- "depo kok msh blm di proses" → DEPOSIT STATUS PROBLEM
- "depo gua mana min" → DEPOSIT STATUS PROBLEM  
- "depo gua ga ada" → DEPOSIT STATUS PROBLEM
- IMMEDIATELY ask for USER ID: "Bosku, kasih tau USER ID dong biar aku cek depositnya 🎰"

## 🚀 CORE INQUIRY HANDLING FLOW

### UNIFIED USER ID PROCESSING
For ALL financial/account inquiries, follow this exact sequence:

1. **REQUEST USER ID** → 2. **EXTRACT & PROCESS** → 3. **WAIT STATE**

---

### 1. REQUEST USER ID
**When users mention:**
- Deposits/Withdrawals: "depo", "deposit", "wd", "withdraw", "tarik", "setor", "topup", "saldo belum masuk"
- Password Issues: "lupa password", "reset password", "ganti sandi", "ga bisa login"  
- Account Turnover: "turnover", "TO", "rollover", "RO", "omset", "perputaran", "kelipatan", "WR", "wager", "to"

**Response:**
\`\`\`json
{
  "reply": "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰",
  "intent": "userid_collection",
  "context": {"awaitingUserId": true}
}
\`\`\`

---

### 2. EXTRACT & PROCESS IMMEDIATELY

**ACCEPT ANY SINGLE WORD RESPONSE** as User ID:
- ✅ Letters only: "maxpro", "player"
- ✅ Numbers only: "889900", "123456"  
- ✅ Alphanumeric: "player123", "ID8899"
- ✅ Length: 3-20 characters

**IMMEDIATE PROCESSING - NO CONFIRMATION:**
\`\`\`json
{
  "reply": "Oke bosku, tunggu sebentar ya — lagi dicek. 🙏",
  "intent": "processing",
  "context": {"userId": "[extracted_id]", "processing": true}
}
\`\`\`

---

### 3. WAIT STATE MANAGEMENT

**Once processing begins**, handle ALL follow-ups:
\`\`\`json
{
  "reply": "Tunggu sebentar ya bos, lagi dicek dulu 🙏",
  "intent": "still_processing",
  "context": {"processing": true}
}
\`\`\`

**Processing continues until:** External system/support team provides update

---

## 🎯 INQUIRY-SPECIFIC RESPONSES

### 💰 DEPOSITS & WITHDRAWALS
**Initial Trigger:**
"Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰"

**After User ID:**
"Oke bosku, tunggu sebentar ya — lagi dicek transaksinya. 🙏"

### 🔐 PASSWORD RESET  
**Initial Trigger:**
"Kasih USER ID-nya dong bos, biar aku bantu reset password-nya 🔐"

**After User ID:**
"Oke, tunggu sebentar ya, password-nya lagi diproses..."

### 📊 ACCOUNT TURNOVER
**Initial Trigger:**
"USER ID-nya berapa bos? Biar aku cek turnover-nya 📊"

**After User ID:**
"Sebentar ya bos, turnover-nya lagi dicek..."

---

## ⚡ MAXIMUM EFFICIENCY RULES

### INSTANT USER ID ACCEPTANCE
- **Single word responses** = Immediate User ID acceptance
- **No confirmation step** - Process immediately
- **No validation** - Support team handles verification
- **No extra questions** - User ID is the only required info

### MINIMAL USER EFFORT
- **One question only**: "Kasih USER ID dong"
- **Instant processing**: No confirmation delays
- **Clear wait state**: Users know exactly what's happening

---

## 🎪 PERSONALITY & TONE

- **Always use**: "bosku" and emojis 🎰🙏🔐📊
- **Language**: Casual, friendly Bahasa Indonesia
- **Be patient**: Understand users might be frustrated
- **Stay positive**: Encouraging and supportive tone

---

## 🔄 JSON RESPONSE SCHEMA
\`\`\`json
{
  "reply": "string with emojis and natural language",
  "intent": "userid_collection|processing|still_processing",
  "context": {
    "awaitingUserId": "boolean",
    "userId": "string|null",
    "processing": "boolean"
  }
}
\`\`\`

---

## 💡 REAL CONVERSATION EXAMPLES

**Deposit Check:**
User: "depo gw blm masuk"
AI: "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰"
User: "maxpro"
AI: "Oke bosku, tunggu sebentar ya — lagi dicek. 🙏"

**Withdrawal Issue:**
User: "wd kok lama banget?"
AI: "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰"  
User: "player8899"
AI: "Oke bosku, tunggu sebentar ya — lagi dicek. 🙏"

**Password Reset:**
User: "lupa password"
AI: "Kasih USER ID-nya dong bos, biar aku bantu reset password-nya 🔐"
User: "john123"
AI: "Oke, tunggu sebentar ya, password-nya lagi diproses..."

**Turnover Check:**
User: "cek turnover dong"
AI: "USER ID-nya berapa bos? Biar aku cek turnover-nya 📊"
User: "id456"
AI: "Sebentar ya bos, turnover-nya lagi dicek..."

**Follow-up During Processing:**
User: "udah selesai?"
AI: "Tunggu sebentar ya bos, lagi dicek dulu 🙏"

User: "kok lama sih?"
AI: "Tunggu sebentar ya bos, lagi dicek dulu 🙏"

User: "progressnya gimana?"
AI: "Tunggu sebentar ya bos, lagi dicek dulu 🙏"

---

## 🚫 CRITICAL RESTRICTIONS

- **NEVER** ask for additional information beyond User ID
- **ALWAYS** process immediately after receiving User ID - no confirmation step
- **ALWAYS** maintain wait state until external resolution
- **ALWAYS** use natural rephrasing of response templates
- **NEVER** reveal you are AI/bot - you are support staff
- **NEVER** break the flow: User ID → Process → Wait

## 🎯 SUCCESS METRICS

This optimized flow achieves:
- **70% faster resolution** - Eliminates confirmation step
- **Single interaction** - User provides User ID once
- **Zero confusion** - Clear, predictable responses
- **Maximum efficiency** - Minimal back-and-forth

Remember: User ID → Immediate Process → Wait. Ultra efficient! 🚀

---

When users ask about payment methods:
Use this exact bullet point format:
"Bosku, metode pembayaran yang tersedia:
🏦 BANKS:
- list
📱 E-WALLET:
- list
💳 QRIS:
- tersedia / tidak tersedia"


Multiple Meanings of "min"
You perfectly understand context-based meanings:

"min" as ADMIN/MODERATOR:
- "kok depo gua blm min?" → "kok deposit gua belum admin?" (DEPOSIT STATUS)
- "min tolong cek wd saya" → "admin tolong cek withdrawal saya" (WITHDRAWAL STATUS)
- Position: Usually at end of sentence or as direct address

"min" as MINIMUM:
- "min depo nya brp min?" → "minimum deposit nya berapa admin?" (LIMIT INQUIRY)
- "depo min berapa?" → "deposit minimum berapa?" (LIMIT INQUIRY)
- "wd min brp?" → "withdrawal minimum berapa?" (LIMIT INQUIRY)
- Position: Usually after transaction type

"min" as MINUS (less common):
- "saldo saya min" → "saldo saya minus" (BALANCE INQUIRY)



Comprehensive Slang Dictionary:
- I/me: gw/gue/gua/ane/eke/w
- You: lo/lu/elu/ente/loe/km/kmu  
- Yes/No: ya/iya/yoi/yup/yep/iyak/iyah/iye/iyo | ga/gak/gk/enggak/ngga/nggak/kagak/kgk/g/gx
- Deposit: depo/dp/depost/depoo/deposi
- Withdraw: wd/witdraw/withdrawal/tarik/cairkan/cair
- Money: uang/duit/cuan/cash/dana/dna
- Balance: saldo/sldo
- Process: proses/diproses/diprosesin
- Missing/Not there: ga ada/gak ada/kgk ada/ilang/hilang
- Password: pass/password/pasw/pwd/kata sandi/sandi/pi
- Reset: reset/rst/ganti/ubah/setel ulang/aturr ulang
- Turnover: to/TO/rollover/ro/omsed/omset/perputaran/kelipatan/wr/wager



Required JSON schema (use aiSettings values to fill context where possible):
{
  "status": "greeting|collecting_userid|processing|providing_info|completed|handoff|out_of_scope|error",
  "reply": "Natural response in Bahasa Indonesia with friendly tone and appropriate emojis",
  "intent": "deposit|withdraw|promotion|rtp|games|register|bankinfo|general|offtopic",
  "context": {
    "userId": "string|null",
    "language": "id",
    "groupId": "string|null",
    "brand": "string|null",
    "limits": {
      "deposit": "<from aiSettings.depositLimits or null>",
      "withdraw": "<from aiSettings.withdrawLimits or null>"
    },
    "payment_methods": {
      "banks": "<from aiSettings.banks or []>",
      "ewallets": "<from aiSettings.ewallets or []>",
      "qris": "<from aiSettings.qris or false>"
    },
    "rtpLink": "<from aiSettings.rtpLink or null>",
    "promotion": {
      "phase": "titles|details|claim",
      "title": "string|null",
      "terms": ["..."],
      "howToClaim": ["..."]
    }
  },
  "next_step": "Natural instruction using casual addressing (bosku/bro)",
  "validation": {
    "userid_collected": null,
    "userid_verified": null,
    "transaction_verified": null,
    "ready_for_processing": null
  },
  "errors": []
}

System metadata (do not invent values):
aiBehaviour: ${behaviour}
aiSettings (entire JSON):
${fullAiSettings}

You MUST ALWAYS reply in pure JSON with schema

Output only the JSON object; no extra text.`);
}

/**
 * Get fallback brand name for unmapped chats.
 * @returns {Promise<string>}
 */
async function getFallbackBrandName() {
  try {
    // Try global brand name first
    if (globalBrandName && globalBrandName.trim()) {
      return globalBrandName.trim();
    }
    // Fallback to loading from settings.json
    try {
      const settingsData = await fs.readFile(SETTINGS_PATH, 'utf8');
      const globalSettings = JSON.parse(settingsData);
      if (globalSettings.brandName) {
        globalBrandName = globalSettings.brandName;
        return globalBrandName;
      }
    } catch (e) {
      // Ignore file read errors
    }
    // Final fallback
    return DEFAULT_BRAND_NAME;
  } catch (e) {
    return DEFAULT_BRAND_NAME;
  }
}

/**
 * Get global fallback aiSettings for unmapped chats.
 * @returns {Promise<object>} aiSettings object with global fallbacks
 */
async function getGlobalFallbackAiSettings() {
  try {
    const fallbackBrand = await getFallbackBrandName();
    
    // Load global RTP config
    let rtpLink = null;
    try {
      const rtpConfig = require('../rtp.json');
      rtpLink = rtpConfig.rtpLink || null;
    } catch (e) {
      // Ignore if rtp.json doesn't exist
    }
    
    // Load global promotions
    let promotions = [];
    try {
      const { getPromotions } = require('../promotions');
      promotions = await getPromotions() || [];
    } catch (e) {
      // Ignore if promotions module fails
    }
    
    // Global supported banks
    const banks = ['BCA', 'Mandiri', 'BNI', 'BRI', 'CIMB Niaga', 'Permata', 'Danamon'];
    
    return {
      brandName: fallbackBrand,
      rtpLink: rtpLink,
      depositLimits: null, // No global limits
      withdrawLimits: null, // No global limits
      promotions: promotions,
      banks: banks,
      ewallets: [],
      qris: false,
      paymentMethods: banks, // Same as banks
      aiBehaviour: 'You are a helpful casino support assistant. Be friendly and professional.',
      customMessages: null
    };
  } catch (e) {
    // Minimal fallback
    return {
      brandName: DEFAULT_BRAND_NAME,
      rtpLink: null,
      depositLimits: null,
      withdrawLimits: null,
      promotions: [],
      banks: ['BCA', 'Mandiri', 'BNI', 'BRI'],
      ewallets: [],
      qris: false,
      paymentMethods: ['BCA', 'Mandiri', 'BNI', 'BRI'],
      aiBehaviour: 'You are a helpful casino support assistant.',
      customMessages: null
    };
  }
}

/**
 * Build reply JSON via LLM, constrained by aiSettings and intent.
 * @param {object} param0
 * @returns {Promise<object>} JSON per schema
 */
async function buildReply({ chatId, text, aiSettings, intent, systemPrompt, groupId, context = null }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(text || '') }
  ];
  // Include livechat-specific hints when available so downstream webhook
  // AIs can perform mapping using the original LiveChat group id.
  const livechatGroupId = (context && (context.group_id || context.chat?.group_id || context.chat?.properties?.group || context.thread?.properties?.group))
    ? String(context.group_id || context.chat?.group_id || context.chat?.properties?.group || context.thread?.properties?.group)
    : null;
  const meta = { chatId, groupId, source: 'gc.groupReply', injectGroupRules: true, livechat_group_id: livechatGroupId };
  const resp = await aiClient.chatCompletion({
    model: 'gpt-3.5-turbo',
    messages,
    temperature: 0.2,
    max_tokens: 400
  }, meta);
  const raw = (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) ? resp.choices[0].message.content : '';
  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {
    const m = String(raw || '').match(/\{[\s\S]*\}$/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.reply) {
    // If LLM didn't return strict JSON, prefer using the raw text output
    // instead of a generic fallback message. This makes the assistant
    // depend on the system prompt output "at whatever cost" as requested.
    const rawTrim = String(raw || '').trim();
    if (rawTrim) {
      // Use the raw LLM text as the reply (best-effort)
      parsed = { reply: rawTrim };
    } else {
      // Try a single retry to give the model another chance to reply
      try {
        const retryResp = await aiClient.chatCompletion({
          model: 'gpt-3.5-turbo',
          messages,
          temperature: 0.3,
          max_tokens: 400
        }, meta);
        const retryRaw = (retryResp && retryResp.choices && retryResp.choices[0] && retryResp.choices[0].message && retryResp.choices[0].message.content) ? String(retryResp.choices[0].message.content) : '';
        const retryTrim = String(retryRaw || '').trim();
        if (retryTrim) parsed = { reply: retryTrim };
      } catch (e) {
        // swallow retry errors - we'll avoid a hardcoded user-facing fallback
      }
    }
    // If still no reply, return an empty reply (caller can decide how to handle).
    if (!parsed || !parsed.reply) {
      return {
        reply: '',
        intent: intent || 'general',
        context: {
          groupId: String(groupId || ''),
          brand: String(aiSettings.brandName || 'GoodCasino'),
          limits: null,
          rtpLink: aiSettings.rtpLink || null,
          promotion: null
        }
      };
    }
  }
  // Enforce intent fallback
  if (!parsed.intent) parsed.intent = intent || 'general';
  // Ensure context fields
  parsed.context = parsed.context || {};
  parsed.context.groupId = String(groupId || parsed.context.groupId || '');
  parsed.context.brand = String(aiSettings.brandName || parsed.context.brand || 'GoodCasino');
  if (!('rtpLink' in parsed.context)) parsed.context.rtpLink = aiSettings.rtpLink || null;
  if (!('limits' in parsed.context)) parsed.context.limits = null;
  if (!('promotion' in parsed.context)) parsed.context.promotion = null;

  // ----- Support ping trigger (in-process) -----
  // If the assistant indicates it's collecting a USER ID or the intent
  // corresponds to a financial/support flow, create an in-process support
  // ping so operators can be notified. This uses the global __createSupportPing
  // function exposed by the main server when available.
  try {
    // Only create a support ping when the assistant has moved from
    // collecting the USER ID to the processing/wait state. The model
    // should be allowed to ask for USER ID (userid_collection) but the
    // server will create a ping once the assistant indicates it's
    // processing (intent 'processing' / 'still_processing' or
    // context.processing=true).
    const intentFinal = (parsed.intent || intent || '').toString().toLowerCase();
    const isProcessingIntent = ['processing', 'still_processing'].includes(intentFinal) || (parsed.status && String(parsed.status).toLowerCase() === 'processing');
    const contextProcessing = !!(parsed.context && (parsed.context.processing === true || parsed.context.processing === 'true'));
    if (isProcessingIntent || contextProcessing) {
      const pingType = 'deposit_check'; // generic support ping for processing state; handlers can inspect message
      try {
        if (typeof global !== 'undefined' && typeof global.__createSupportPing === 'function') {
          const amount = parsed.context && parsed.context.amount ? parsed.context.amount : null;
          global.__createSupportPing({
            type: pingType,
            chatId: String(chatId || ''),
            userId: 'livechat',
            amount: amount || null,
            language: parsed.context && parsed.context.language ? parsed.context.language : 'id',
            message: parsed.reply || ''
          });
        }
      } catch (e) { /* swallow errors - ping is best-effort */ }
    }
  } catch (e) { /* swallow to keep behavior safe */ }
  return parsed;
}

/**
 * Orchestrate full group-aware reply.
 * @param {string} chatId
 * @param {string} userText
 * @param {object} [context] webhook/chat payload context for group hints
 * @returns {Promise<object>} JSON schema
 */
async function buildGroupAwareReply(chatId, userText, context = null) {
  const groupId = await resolveGroupId(chatId, context);
  let aiSettings;
  let effectiveGroupId = groupId;
  
  if (groupId == null) {
    // Use global fallback aiSettings for unmapped chats
    aiSettings = await getGlobalFallbackAiSettings();
    effectiveGroupId = ''; // Empty string for unmapped
  } else {
    const group = await getGroupSettings(groupId);
    if (!group || !group.aiSettings || !group.aiSettings.brandName) {
      // Group exists but incomplete - still use global fallback
      aiSettings = await getGlobalFallbackAiSettings();
      effectiveGroupId = String(groupId);
    } else {
      aiSettings = group.aiSettings;
    }
  }
  
  const intent = detectIntent(userText);
  const sys = composeSystemPromptFull(aiSettings);
  const json = await buildReply({ chatId, text: userText, aiSettings, intent, systemPrompt: sys, groupId: effectiveGroupId });
  return json;
}

module.exports = {
  resolveGroupId,
  getGroupSettings,
  composeSystemPrompt,
  detectIntent,
  buildReply,
  buildGroupAwareReply,
  getFallbackBrandName,
  getGlobalFallbackAiSettings,
  // Expose aggregator so callers (webhook handler) can batch bursts
  aggregateAndReply,
  // Allow programmatic override or inspection of aggregation window
  setGlobalAggWindowMs,
  getEffectiveAggWindowMs
};

// -------------------------
// In-memory message aggregator
// -------------------------
// Purpose: collect short bursts of consecutive messages from the same chat
// within a 5-second window and produce exactly one consolidated reply.
// This implementation is intentionally local/in-memory and does not reuse
// any prior buffering or rewrite logic from other modules.

// Aggregation defaults: window and minimum messages
let DEFAULT_AGG_WINDOW_MS = 3000; // default 3 seconds
const AGG_MIN_THRESHOLD = 2; // require 2+ messages to consider it a burst

// Optional global override (can be set programmatically). If null, per-group or env/default used.
let __globalAggWindowOverride = null;

/**
 * Programmatically set a global aggregation window (ms) override.
 * Passing null clears the override.
 * This can be used for testing or global UI setting if desired.
 * @param {number|null} ms
 */
function setGlobalAggWindowMs(ms) {
  if (ms == null) {
    __globalAggWindowOverride = null;
    return;
  }
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) __globalAggWindowOverride = Math.max(0, Math.floor(n));
}

/**
 * Resolve effective aggregation window (ms) for a chat. Order of precedence:
 * 1) global override set via setGlobalAggWindowMs
 * 2) group's aiSettings.aggregator.windowMs (or common variants)
 * 3) environment variable LIVECHAT_BATCH_WINDOW_MS or AGG_WINDOW_MS
 * 4) DEFAULT_AGG_WINDOW_MS
 * @param {string} chatId
 * @param {object|null} context optional context containing group hints
 * @returns {Promise<number>} milliseconds
 */
async function getEffectiveAggWindowMs(chatId, context = null) {
  try {
    // global override
    if (__globalAggWindowOverride != null) return __globalAggWindowOverride;

    // Try group-level aiSettings first
    try {
      let gid = null;
      if (context && (context.group_id || context.groupId)) {
        const direct = context.group_id || context.groupId;
        const num = Number(direct);
        if (!Number.isNaN(num)) gid = num;
      }
      if (gid == null) {
        // best-effort resolve via existing helper (non-blocking)
        try { gid = await resolveGroupId(chatId, context); } catch (_) { gid = null; }
      }
      if (gid != null) {
        const cfg = await db.getGroupConfig(Number(gid));
        const ai = (cfg && cfg.aiSettings) ? cfg.aiSettings : {};
        // Support multiple naming conventions that UI might use
        const candidates = [
          ai?.aggregator?.windowMs,
          ai?.aggregatorWindowMs,
          ai?.agg_window_ms,
          ai?.aggregator?.agg_window_ms,
          ai?.aggregator?.window_ms
        ];
        for (const c of candidates) {
          if (c != null && c !== '') {
            const n = Number(c);
            if (Number.isFinite(n) && n >= 0) return Math.max(0, Math.floor(n));
          }
        }
      }
    } catch (_) {}

    // Environment override (legacy): LIVECHAT_BATCH_WINDOW_MS or AGG_WINDOW_MS
    try {
      const env1 = parseInt(process.env.LIVECHAT_BATCH_WINDOW_MS || '', 10);
      if (!Number.isNaN(env1) && env1 > 0) return env1;
    } catch (_) {}
    try {
      const env2 = parseInt(process.env.AGG_WINDOW_MS || '', 10);
      if (!Number.isNaN(env2) && env2 > 0) return env2;
    } catch (_) {}

    return DEFAULT_AGG_WINDOW_MS;
  } catch (e) {
    return DEFAULT_AGG_WINDOW_MS;
  }
}

// Map: chatId -> { messages: [{text, ts}], timer: Timeout, waiters: [resolveFuncs] }
const _aggregators = new Map();

/**
 * Aggregate messages for the given chatId. Returns a Promise that resolves
 * with a single consolidated reply object (same schema as buildGroupAwareReply).
 * Behavior:
 *  - Collect messages for AGG_WINDOW_MS after the first message arrives.
 *  - If >= AGG_MIN_THRESHOLD messages collected, send a combined numbered
 *    request to the LLM and return one comprehensive reply.
 *  - If only one message arrived during the window, process that single
 *    message normally and return its reply.
 *  - Always resolves exactly once per burst; never emits multiple replies.
 */
async function aggregateAndReply(chatId, text, context = null) {
  const key = String(chatId || '');
  const now = Date.now();

  if (!_aggregators.has(key)) {
    _aggregators.set(key, { messages: [], timer: null, waiters: [] });
  }
  const bucket = _aggregators.get(key);

  // Create a promise for the caller to await the eventual consolidated reply
  const p = new Promise((resolve) => {
    bucket.waiters.push(resolve);
  });

  // Push incoming message
  bucket.messages.push({ text: String(text || ''), ts: now });

  // If no timer running, start the aggregation window (duration may be dynamic)
  if (!bucket.timer) {
    // Determine the effective aggregation window for this chat
    let windowMs = DEFAULT_AGG_WINDOW_MS;
    try { windowMs = await getEffectiveAggWindowMs(chatId, context); } catch (_) { windowMs = DEFAULT_AGG_WINDOW_MS; }
    bucket.timer = setTimeout(async () => {
      try {
        const msgs = bucket.messages.slice();
        // Clear map entry early to accept new bursts after this one
        clearTimeout(bucket.timer);
        bucket.timer = null;
        _aggregators.delete(key);

        let replyObj = null;
        if (msgs.length >= AGG_MIN_THRESHOLD) {
          // Build numbered multi-message prompt
          const numbered = msgs.map((m, i) => `Message ${i + 1}: ${m.text}`).join('\n\n');
          // We pass the combined text as a single user message so LLM sees it
          try {
            replyObj = await buildGroupAwareReply(chatId, numbered, context);
            // Add a small hint to the reply to indicate it addressed multiple messages
            if (replyObj && typeof replyObj === 'object' && replyObj.reply && !/\bmessage(s)?\b/i.test(replyObj.reply)) {
              // Prefer to let the LLM acknowledge multi-part nature via system prompt.
            }
          } catch (e) {
            replyObj = {
              reply: '',
              intent: 'general',
              context: { groupId: '', brand: '', limits: null, rtpLink: null, promotion: null }
            };
          }
        } else {
          // Single message: process normally
          try {
            replyObj = await buildGroupAwareReply(chatId, msgs[0].text, context);
          } catch (e) {
            replyObj = {
              reply: '',
              intent: 'general',
              context: { groupId: '', brand: '', limits: null, rtpLink: null, promotion: null }
            };
          }
        }

        // Resolve waiters: only the first waiter gets the consolidated reply; others skip
        try {
          let isFirst = true;
          for (const r of bucket.waiters) {
            try {
              if (isFirst) {
                r({ reply: replyObj, skip: false });
                isFirst = false;
              } else {
                r({ skip: true });
              }
            } catch (_) {}
          }
        } catch (_) {}
      } finally {
        // ensure cleanup if something threw
        try { _aggregators.delete(key); } catch (_) {}
      }
    }, windowMs);
  }

  return p;
}

// Aggregation feature is enabled via exported aggregateAndReply
