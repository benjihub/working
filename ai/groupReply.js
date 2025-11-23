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
  
  // Build custom behaviour section with strong emphasis if present
  const customBehaviourSection = behaviour ? `
🚨 CRITICAL: CUSTOM GROUP BEHAVIOUR RULES - HIGHEST PRIORITY 🚨
═══════════════════════════════════════════════════════════════

These custom rules MUST be followed and take ABSOLUTE PRECEDENCE over any conflicting base rules below.
If there is ANY conflict between these custom rules and base rules, ALWAYS follow the custom rules.

${behaviour}

═══════════════════════════════════════════════════════════════
END OF CUSTOM RULES - Base rules follow below
═══════════════════════════════════════════════════════════════

` : '';

  return (
  `${customBehaviourSection}You are a smart, intelligent, friendly, and natural ${brand} support assistant. Accept any user id input without validation and proceed to process the request immediately by sending a wait message no greeting fallbacks on user id inputs only.
  Once user id is received, respond with a processing message and set processing state to true. 
  Understand and normalize Indonesian slang sentences, informal chat, code-mixed phrases, and typos naturally. Always keep the full conversation context in mind before replying. Treat the slang dictionary and examples below as hints you can extend so every casual phrase is interpreted correctly.
  Also do exactly what the AI rules from aisettings tell you to do i.e follow them strictly.

  Follow these rules STRICTLY:

 Core Identity and Scope
- You are exclusively the ${brand} Support Assistant
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
- NEVER alter the required flow after an operator correction; keep behaviour consistent with these rules

Multi-Message Handling
- If you receive multiple numbered messages (Message 1, Message 2, etc.), treat them as ONE continuous conversation
- The user sent these messages quickly - they're connected thoughts, not separate requests
- Look for progression: if Message 1 asks a question and Message 2 provides info (like a USER ID), process them together
- Example: "Message 1: depo gua mana min?" + "Message 2: player123" → Recognize player123 as the USER ID and proceed to processing
- Always provide ONE comprehensive response that addresses all messages, not separate answers
- If later messages provide requested information, use it immediately without asking again

Slang Handling Rules
- Normalize any slang, abbreviations, or typos into their intended meaning before deciding the intent.
- Combine surrounding words to understand mixed slang phrases (e.g., "gmn depo gue dong", "wd blm cair nih min").
- Accept repeated letters, missing vowels, phonetic spellings, or mixed casing without asking for clarification.
- Do not tell the user you are interpreting slang; respond smoothly with natural Bahasa.

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

Core capabilities you should handle:

Critical Scenario Map (apply even when slangy or misspelled):
- Deposit Problem phrases (e.g., "depo gua mana", "kok depo blm masuk min", "dpo blm di prosses") -> immediately ask for USER ID, set status 'collecting_userid', give no other info until ID provided.
- Turnover Problem phrases ("turnover akun gua brp?", "to gua brp min?", "to udah brp?") -> ask for USER ID first, same wait-state flow.
- Withdraw Problem phrases ("wd gua mana", "ini wd belum?", "wd nya kapan cair min") -> ask for USER ID first, same wait-state flow.
- Minimum Deposit/Withdraw questions ("min depo nya berapa min?", "sehari max wd brp min?") → answer using depositLimits/withdrawLimits from aiSettings; do NOT ask for USER ID unless a problem is mentioned.
- Cursing or frustration about losing ("anjg lu", "web sedot", "kalah mulu...") → stay calm, encourage responsible play, and include the RTP link if available( ${s.rtpLink || 'rtpLink'})
- Multiple questions in one message → address each following the same mapping, maintaining JSON schema integrity.

ProOmotions handling (phased):
Phased Promotion Handling

Phase 1 - Listing Promotions (When user asks for promotions list):
- Show ONLY promotion titles/names - NO descriptions, NO teasers
- Format:
"Promo ${brand}! 🎁  
- [Promo Title 1]
- [Promo Title 2]
- [Promo Title 3]"

Phase 2 - Specific Promotion Details (When user asks for specific promo):
- Show in this EXACT organized format:
"Promo [Brand Name]
[PROMTION TITLE]

SYARAT & KETENTUAN:
- [Term 1]
- [Term 2] 
- [Term 3]
- [Term 4]

CARA CLAIM:
- [Step 1]
- [Step 2]
- [Step 3]"

CRITICAL FORMATTING RULES:
- Title on first line after brand
- ONE blank line before "SYARAT & KETENTUAN:"
- Terms listed as bullet points
- ONE blank line before "CARA CLAIM:"
- Claim steps listed as bullet points
- Use all caps for section headers (SYARAT & KETENTUAN, CARA CLAIM)
- Keep it clean, organized, and easy to read

Promotion Structure Understanding
Each promotion has three components:
1. Promotion Name / Title
2. Terms and Conditions (T&C) - shown under "SYARAT & KETENTUAN:"
3. How to Claim Instructions - shown under "CARA CLAIM:"


Payment method responses:
- Accept and map slang tokens (e.g., gw/gue/gua for I; lo/lu for you; depo/dp for deposit; wd for withdraw; saldo for balance).

JSON response contract:
- ALWAYS reply in valid JSON and nothing else. The assistant's output MUST be exactly one JSON object.

When users ask about DEPOSIT PROBLEMS (missing, not processed, delayed):
- "depo kok msh blm di proses" → DEPOSIT STATUS PROBLEM
- "depo gua mana min" → DEPOSIT STATUS PROBLEM  
- "depo gua ga ada" → DEPOSIT STATUS PROBLEM
-"depo gua mana" → DEPOSIT STATUS PROBLEM
- IMMEDIATELY ask for USER ID: "Bosku, kasih tau USER ID dong biar aku cek depositnya 🎰. 
                                NOTE: user ID hanya 1 kata saja ya bos"

When users ask about TURNOVER PROBLEMS (missing, not processed, delayed):
- "turnover akun gua brp?" → TURNOVER STATUS PROBLEM
- "to gua brp min?" → TURNOVER STATUS PROBLEM
- "to udah brp?" → TURNOVER STATUS PROBLEM
- IMMEDIATELY ask for USER ID: "Bosku, kasih tau USER ID dong biar aku cek turnover-nya 🎰. 
                                NOTE: user ID hanya 1 kata saja ya bos"

When users ask about WITHDRAW PROBLEMS (missing, not processed, delayed):
- "wd gua mana" → WITHDRAW STATUS PROBLEM
- "ini wd belum?" → WITHDRAW STATUS PROBLEM
- "wd nya kapan cair min" → WITHDRAW STATUS PROBLEM
- IMMEDIATELY ask for USER ID: "Bosku, kasih tau USER ID dong biar aku cek withdraw-nya 🎰. 
                                NOTE: user ID hanya 1 kata saja ya bos"

CURSING FOR LOSING,
-anjg lu
-kntll
-web sedot wc
-kntlll
-web sedot  
-kalah mulu gua ga ad menang sekalipun
- Encourage players and give RTP link if available(${s.rtpLink || s.null}).
GAMBLING FRUSTRATION & 'NO WIN' COMPLAINTS
- "kok depo g menang mulu"
- "depo gak menang-menang"
- "why deposit no win"
- "uang hangus terus"
- "gak pernah menang"

RESPONSE TEMPLATE:
{
  "status": "providing_info",
  "reply": "Waduh bosku, sabar ya 😊 Di ${brand} semua game pakai RTP system yang fair banget. Kadang emang lagi nasib aja bos, besok-besok pasti balik! Yang penting main bertanggung jawab dan jangan terburu-buru 🎰\n\nBisa cek RTP live langsung di: ${s.rtpLink || s.null} biar tau persentase kemenangan tiap game!",
  "intent": "general",
  "context": {
    "language": "id",
    "brand": "${brand}",
    "rtpLink": "${s.rtpLink || s.null}"
  },
  "next_step": "Main dengan santai ya bosku!",
  "validation": {},
  "errors": []
}

CRITICAL RULES:
- NEVER ask for USER ID for frustration complaints
- NEVER escalate to human support for these cases
- ALWAYS provide encouragement + RTP link
- Use positive, supportive tone
- Emphasize responsible gambling

RTP Reply Templates (use naturally when users ask about RTP):
1. "Anda dapat melihat rates RTP live dan informasi lengkapnya langsung di halaman resmi kami: ${s.rtpLink || 'rtpLink'}."
2. "Untuk informasi RTP yang paling akurat dan terkini, silakan kunjungi halaman RTP kami: ${s.rtpLink || 'rtpLink'}."
3. "Untuk membantu Anda membuat keputusan yang tepat, Anda dapat menemukan informasi RTP waktu nyata kami di tautan berikut: ${s.rtpLink || 'rtpLink'}."

Note: Choose ONE of these templates and rephrase naturally. Always include the actual rtpLink from aiSettings.

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
  "reply": "kasih tau USER ID dong biar aku cek transaksinya 🎰. NOTE: user ID hanya 1 kata saja ya bos",
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
- ✅ Format: "id player123" or "id 'player123'" → treat as immediate user ID (strip quotes first)
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
"Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰.NOTE: user ID hanya 1 kata saja ya bos"

**After User ID:**
"Oke bosku, tunggu sebentar ya — lagi dicek transaksinya. 🙏"

### 🔐 PASSWORD RESET  
**Initial Trigger:**
"Kasih USER ID-nya dong bos, biar aku bantu reset password-nya 🔐. NOTE: user ID hanya 1 kata saja ya bos"

**After User ID:**
"Oke, tunggu sebentar ya, password-nya lagi diproses..."

### 📊 ACCOUNT TURNOVER
**Initial Trigger:**
"USER ID-nya berapa bos? Biar aku cek turnover-nya 📊. NOTE: user ID hanya 1 kata saja ya bos"

**After User ID:**
"Sebentar ya bos, turnover-nya lagi dicek..."

---

## ⚡ MAXIMUM EFFICIENCY RULES

### INSTANT USER ID ACCEPTANCE
- **Single word responses** = Immediate User ID acceptance
- **Labelled responses like "id player123" (with or without quotes)** count as the user providing the ID — remove wrapping quotes before using it
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
AI: "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰. *NOTE: user ID hanya 1 kata saja ya bos"
User: "maxpro"
AI: "Oke bosku, tunggu sebentar ya — lagi dicek. 🙏"

**Withdrawal Issue:**
User: "wd kok lama banget?"
AI: "Bosku, kasih tau USER ID dong biar aku cek transaksinya 🎰. *NOTE: user ID hanya 1 kata saja ya bos*"
User: "player8899"
AI: "Oke bosku, tunggu sebentar ya — lagi dicek. 🙏"

**Password Reset:**
User: "lupa password"
AI: "Kasih USER ID-nya dong bos, biar aku bantu reset password-nya 🔐.
     NOTE: user ID hanya 1 kata saja ya bos*"
User: "john123"
AI: "Oke, tunggu sebentar ya, password-nya lagi diproses..."

**Turnover Check:**
User: "cek turnover dong"
AI: "USER ID-nya berapa bos? Biar aku cek turnover-nya 📊. *NOTE: user ID hanya 1 kata saja ya bos*"
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
- **NEVER** contradict operator-configured deposit/withdraw limits or promo data
- **NEVER** replace the structured JSON schema with bullet lists or plain text, even when clarifying slang

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
 * Lightweight intent detector for basic categorization.
 * @param {string} text
 * @returns {string} intent category
 */
function detectIntent(text) {
  const t = String(text || '').toLowerCase();
  
  // Check for user ID collection intents
  if (/\b(deposit|depo|dp|top\s?up|topup|isi saldo)\b/.test(t) || 
      /\b(withdraw|wd|tarik|penarikan|cair|withdrawal)\b/.test(t) ||
      /\b(turnover|rollover|omset|perputaran|kelipatan|wager|wr)\b/.test(t) ||
      /\b(lupa password|reset password|ganti sandi|lupa pass|reset pass|ga bisa login|gk bisa login)\b/.test(t)) {
    return 'userid_collection';
  }
  
  if (/\b(daftar|register|buat akun|signup|registrasi)\b/.test(t)) return 'register';
  if (/\b(promo|promosi|bonus|event)\b/.test(t)) return 'promotion';
  if (/\brtp\b/.test(t)) return 'rtp';
  if (/\b(game|games|slot|slots|gacor|permainan|daftar game|game apa|slot apa)\b/.test(t)) return 'games';
  return 'general';
}

/**
 * Detect if the user is explicitly claiming a promotion.
 * e.g. "cara claim promo", "klaim promo", "claim", "mau klaim bonus"
 */
function isPromotionClaim(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const claimKeywords = /\b(claim|klaim|cara\s*claim|cara\s*klaim|mau\s*klaim|ingin\s*klaim|nak\s*klaim|how\s*to\s*claim)\b/;
  const scatterKeywords = /\b(scatter|scater|skater)\b/;
  if (claimKeywords.test(t)) return true;
  // Treat bare scatter mentions as promo-claim intent (common shorthand like "claim scatter")
  return scatterKeywords.test(t);
}

/**
 * Extract user ID from text - accepts single words or labeled formats.
 * @param {string} text
 * @returns {string|null} extracted user ID or null
 */
function extractUserId(text) {
  if (!text) return null;
  const str = String(text).trim();
  if (!str) return null;

  // Check for labeled format: "user id: something" or "userid: something"
  const labelled = str.match(/\b(user\s*id|userid|user_id|uid|account\s*id|cid)\b[:=\s-]*['"]?([A-Za-z0-9_-]{2,30})['"]?/i);
  if (labelled && labelled[2]) {
    return labelled[2].trim();
  }

  // Support short "id" label with optional quotes, e.g., "id 'player123'"
  const shortLabelled = str.match(/\bid\b[:=\s-]*['"]?([A-Za-z0-9_-]{3,20})['"]?/i);
  if (shortLabelled && shortLabelled[1]) {
    return shortLabelled[1].trim();
  }

  // Check if it's a single word (potential user ID)
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 2 && words[0].toLowerCase() === 'id') {
    const candidate = words[1].replace(/^['"]|['"]$/g, '').trim();
    if (/^[A-Za-z0-9_-]{3,20}$/.test(candidate)) {
      return candidate;
    }
  }
  if (words.length === 1) {
    const word = words[0].trim();
    // Accept alphanumeric user IDs between 3-20 characters
    if (/^[A-Za-z0-9_-]{3,20}$/.test(word)) {
      return word;
    }
  }

  return null;
}

/**
 * Helper functions for wait message handling
 */
function replaceUserIdPlaceholder(template, userId) {
  if (!template || !userId) return template;
  return template
    .replace(/\{\{\s*(user[_\s-]*id|userid|cid)\s*\}\}/gi, userId)
    .replace(/\[\[\s*(user[_\s-]*id|userid|cid)\s*\]\]/gi, userId)
    .replace(/%\s*(user[_\s-]*id|userid|cid)\s*%/gi, userId);
}

function resolveWaitMessage(aiSettings, userId) {
  const candidates = [];
  if (aiSettings && aiSettings.customMessages && typeof aiSettings.customMessages.waitMessage === 'string') {
    candidates.push(aiSettings.customMessages.waitMessage.trim());
  }
  if (aiSettings && typeof aiSettings.waitMessage === 'string') {
    candidates.push(aiSettings.waitMessage.trim());
  }
  const selected = candidates.find((msg) => msg && msg.length > 0) || null;
  if (selected) {
    return replaceUserIdPlaceholder(selected, userId);
  }
  if (userId) {
    return `Oke bosku, tunggu sebentar ya — lagi dicek. 🙏`;
  }
  return 'Siap bosku, permintaan kamu lagi dicek. Mohon ditunggu sebentar ya.';
}

function containsWaitCue(text) {
  if (!text) return false;
  const waitRegex = /\b(mohon\s+ditunggu|ditunggu\s+sebentar|please\s+wait|tunggu\s+sebentar|lagi\s+(?:dicek|diproses)|sedang\s+(?:dicek|diproses)|kami\s+cek|akan\s+dicek)\b/i;
  return waitRegex.test(String(text).toLowerCase());
}

function detectUserIdFlowType(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return 'generic';
  if (/\b(turnover|rollover|omset|perputaran|kelipatan|wager|wr)\b/.test(lower)) return 'turnover';
  if (/\b(withdraw|wd|tarik|penarikan|cair|withdrawal)\b/.test(lower)) return 'withdraw';
  if (/\b(deposit|depo|dp|top\s?up|topup|isi saldo)\b/.test(lower)) return 'deposit';
  if (/\b(lupa password|reset password|ganti sandi|lupa pass|reset pass|ga bisa login|gk bisa login)\b/.test(lower)) return 'password_reset';
  return 'generic';
}

const USER_ID_PROMPT_SUFFIX = ' NOTE: user ID hanya 1 kata saja ya bos';
const USER_ID_PROMPT_VARIANTS = {
  deposit: [
    'Bosku, share USER ID dulu biar aku cek deposit kamu 🎰',
    'Boleh drop USER ID-nya? Lagi mau cek status deposit kamu nih 🎰',
    'Titip USER ID sebentar ya bos, biar aku pantau depositnya 🎰'
  ],
  withdraw: [
    'Bosku, kirim USER ID dulu biar aku tindak withdraw kamu 🎰',
    'Drop USER ID yuk supaya aku bisa cek withdraw kamu 🎰',
    'Kasih USER ID sebentar ya bos, mau aku cekin withdraw kamu 🎰'
  ],
  turnover: [
    'Bosku, sebutin USER ID biar aku hitung turnover-nya 📊',
    'Share USER ID ya, mau aku cekin turnover kamu 📊',
    'Titip USER ID dulu dong bos, biar turnover kamu bisa langsung aku cek 📊'
  ],
  password_reset: [
    'Kasih USER ID-nya dong bos, biar bisa langsung bantu reset 🔐',
    'Share USER ID dulu ya biar aku proses reset password kamu 🔐',
    'Bosku, drop USER ID sebentar supaya reset password bisa jalan 🔐'
  ],
  generic: [
    'Bosku, boleh minta USER ID-nya biar aku lanjut prosesnya 🎰',
    'Share USER ID ya bos supaya bisa langsung aku bantu 🎰',
    'Titip USER ID sebentar dong biar prosesnya lanjut 🎰'
  ]
};

function pickUserIdPrompt(flowType = 'generic') {
  const variants = USER_ID_PROMPT_VARIANTS[flowType] || USER_ID_PROMPT_VARIANTS.generic;
  if (!Array.isArray(variants) || variants.length === 0) {
    return 'Bosku, kasih tau USER ID dong biar aku bantu prosesnya 🎰' + USER_ID_PROMPT_SUFFIX;
  }
  const choice = variants[Math.floor(Math.random() * variants.length)] || USER_ID_PROMPT_VARIANTS.generic[0];
  return `${choice}${USER_ID_PROMPT_SUFFIX}`;
}

function resolveUserIdRequestMessage(flowType = 'generic') {
  return pickUserIdPrompt(flowType);
}

function replyAsksForUserId(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return /\buser\s*id\b|\buserid\b|\bcid\b|\buid\b/.test(lower);
}

function coerceToOriginalShape(original, candidate) {
  if (Array.isArray(original)) {
    return Array.isArray(candidate) ? candidate : original;
  }
  if (original && typeof original === 'object') {
    const result = { ...original };
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const key of Object.keys(result)) {
        if (candidate[key] !== undefined) {
          result[key] = coerceToOriginalShape(result[key], candidate[key]);
        }
      }
    }
    return result;
  }
  if (original === null) {
    return candidate !== undefined ? candidate : original;
  }
  if (typeof candidate === typeof original) {
    return candidate;
  }
  return original;
}

async function enforceBehaviourPostProcessing({ originalJson, behaviour, userMessage, brand, meta }) {
  const trimmedBehaviour = String(behaviour || '').trim();
  if (!trimmedBehaviour || !originalJson || typeof originalJson !== 'object') {
    return originalJson;
  }

  const systemContent = [
    'You are a strict compliance layer for casino support responses.',
    'Ensure the assistant reply follows the custom behaviour rules while keeping the JSON schema identical.',
    'Only adjust fields when required; never drop mandatory keys or change their types.',
    'Always reply with a single JSON object and nothing else.'
  ].join('\n');

  const userContent = [
    `Brand: ${brand || 'Unknown Brand'}`,
    'Custom behaviour rules (absolute precedence):',
    trimmedBehaviour,
    '---',
    'Latest user message:',
    String(userMessage || '<empty>'),
    '---',
    'Original assistant JSON (keep same schema):',
    JSON.stringify(originalJson),
    '',
    'If the original JSON already follows the rules, return it unchanged.'
  ].join('\n');

  const enforcementMeta = { ...(meta || {}), source: 'gc.groupReply.behaviourEnforcer' };

  try {
    const response = await aiClient.chatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_tokens: 400
    }, enforcementMeta);

    const raw = (response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content)
      ? response.choices[0].message.content
      : '';

    let adjusted = null;
    try {
      adjusted = JSON.parse(String(raw || '').trim());
    } catch (_) {
      const match = String(raw || '').match(/\{[\s\S]*\}$/);
      if (match) {
        try { adjusted = JSON.parse(match[0]); } catch (_) {
          adjusted = null;
        }
      }
    }

    if (!adjusted || typeof adjusted !== 'object') {
      return originalJson;
    }

    return coerceToOriginalShape(originalJson, adjusted);
  } catch (error) {
    console.warn('[behaviourEnforcer] failed to apply custom behaviour:', error);
    return originalJson;
  }
}

/**
 * Build reply JSON via LLM, constrained by aiSettings and intent.
 * @param {object} param0
 * @returns {Promise<object>} JSON per schema
 */
async function buildReply({ chatId, text, aiSettings, intent, systemPrompt, groupId, context = null }) {
  let extractedUserId = null;
  let shouldInjectWaitMessage = false;
  const initialIntent = String(intent || '').toLowerCase();
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
  const debugContext = {
    chatId,
    groupId,
    textLength: text ? text.length : 0,
    textPreview: text ? text.substring(0, 50) : '<empty>',
    hasWebhook: !!process.env.LIVECHAT_WEBHOOK_URL,
    hasOpenAI: process.env.USE_OPENAI === 'true'
  };
  
  const resp = await aiClient.chatCompletion({
    model: 'gpt-3.5-turbo',
    messages,
    temperature: 0.2,
    max_tokens: 400
  }, meta);
  
  const raw = (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) ? resp.choices[0].message.content : '';
  
  // DEBUG: Log request/response after ensuring LLM was invoked first
  console.log('[buildReply] AI call context:', debugContext);
  
  // DEBUG: Log AI response to diagnose empty replies
  console.log('[buildReply] AI response received:', {
    chatId,
    hasResponse: !!resp,
    hasChoices: !!(resp && resp.choices && resp.choices[0]),
    rawLength: raw ? raw.length : 0,
    rawPreview: raw ? raw.substring(0, 100) : '<empty>'
  });
  
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
          max_tokens: 4000
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
  parsed.context.rtpLink = (aiSettings && typeof aiSettings.rtpLink === 'string' && aiSettings.rtpLink.trim())
    ? aiSettings.rtpLink.trim()
    : (aiSettings && aiSettings.rtpLink != null ? String(aiSettings.rtpLink) : null);
  if (!('limits' in parsed.context)) parsed.context.limits = null;
  if (!('promotion' in parsed.context)) parsed.context.promotion = null;

  // If LLM parsed a promotion intent but user explicitly asks to claim, escalate to human support.
  try {
    const textLower = String(text || '').trim();
    const wantsClaim = isPromotionClaim(textLower) || (parsed.intent && String(parsed.intent).toLowerCase() === 'promotion' && isPromotionClaim(textLower));
    if (wantsClaim) {
      parsed.intent = 'promotion_claim';
      parsed.status = parsed.status || 'handoff';
      parsed.next_step = parsed.next_step || 'handoff_to_support';
      // Ensure assistant stops and does not provide claim procedure: set a short handoff reply
      parsed.reply = parsed.reply || `Terima kasih, klaim promosi Anda telah diteruskan ke tim support. Tim akan membantu lebih lanjut.`;
      // Mark to skip additional behaviour enforcement so we don't accidentally inject claim steps
      parsed.__promoClaim = true;
      parsed.__skipBehaviourEnforce = true;
      // Indicate handoff in context
      parsed.context = parsed.context || {};
      parsed.context.handoff = true;
      // create support ping if helper available in-process
      try {
        if (global && typeof global.__createSupportPing === 'function') {
          const ping = global.__createSupportPing({ type: 'promo_claim', chatId: String(chatId), userId: (parsed.context && parsed.context.userId) ? parsed.context.userId : 'anonymous', amount: null, language: 'id', message: String(text || '') });
          console.log('[groupReply] Created promo_claim support ping', { chatId, pingId: ping && ping.id });
        }
      } catch (e) {
        console.warn('[groupReply] Failed to create promo_claim support ping:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[groupReply] promo claim detection failed:', e && e.message ? e.message : e);
  }

  // If the assistant or our detector believes the user just provided
  // their USER ID (single-token), ensure we extract it into the
  // returned context so downstream code can act immediately.
  try {
    const finalIntent = (parsed.intent || intent || '').toString().toLowerCase();
    const awaiting = !!(parsed.context && parsed.context.awaitingUserId);
  if (finalIntent === 'userid_collection' || awaiting || initialIntent === 'userid_collection') {
      const maybe = extractUserId(text || messages && messages[1] && messages[1].content || '');
      if (maybe) {
        extractedUserId = String(maybe);
        parsed.context.userId = extractedUserId;
        // Mark that we've collected it
        parsed.context.awaitingUserId = false;
        parsed.context.processing = true;
        parsed.status = 'processing';
        // Move intent forward to processing
        if (finalIntent === 'userid_collection') parsed.intent = 'processing';
        shouldInjectWaitMessage = true;
      }
    }
  } catch (_) {}

  if (shouldInjectWaitMessage) {
    const currentReply = String(parsed.reply || '').trim();
    const waitMessage = resolveWaitMessage(aiSettings, extractedUserId);
    if (!currentReply) {
      parsed.reply = waitMessage;
    } else {
      const replaced = replaceUserIdPlaceholder(currentReply, extractedUserId);
      const hasWaitLanguage = containsWaitCue(replaced);
      if (hasWaitLanguage) {
        parsed.reply = replaced;
      } else {
        parsed.reply = waitMessage;
      }
    }
  }

  const needsUserIdPrompt = initialIntent === 'userid_collection' && !extractedUserId;
  if (needsUserIdPrompt) {
    const currentReply = String(parsed.reply || '').trim();
    const flowType = detectUserIdFlowType(text);
    if (!replyAsksForUserId(currentReply)) {
      parsed.reply = resolveUserIdRequestMessage(flowType);
    }
    parsed.intent = 'userid_collection';
    parsed.status = 'collecting_userid';
    parsed.context.awaitingUserId = true;
    parsed.context.processing = false;
    parsed.context.userId = null;
    if (!parsed.context.language) parsed.context.language = 'id';
  }

  const behaviourRules = (aiSettings && aiSettings.aiBehaviour ? aiSettings.aiBehaviour.toString() : '').trim();
  if (behaviourRules) {
    const status = typeof parsed?.status === 'string' ? parsed.status.toLowerCase() : '';
    const promotionPhase = parsed?.context && parsed.context.promotion ? parsed.context.promotion.phase : null;
    const intent = typeof parsed?.intent === 'string' ? parsed.intent.toLowerCase() : '';

    // Detect welcome message usage (either from aiSettings.welcomeMessage or customMessages.welcomeMessage)
    const configuredWelcome = (aiSettings?.welcomeMessage
      || aiSettings?.customMessages?.welcomeMessage
      || '').toString().trim();
    const replyText = (parsed?.reply || '').toString();
    const isWelcomeReply = configuredWelcome
      ? replyText.includes(configuredWelcome)
      : (status === 'greeting');

    const isPromotionList = (intent === 'promotion' && (promotionPhase === 'titles' || promotionPhase === 'list' || promotionPhase === 'listing'));

    if (isWelcomeReply || isPromotionList) {
      return parsed;
    }

    try {
      parsed = await enforceBehaviourPostProcessing({
        originalJson: parsed,
        behaviour: behaviourRules,
        userMessage: String(text || ''),
        brand: aiSettings && aiSettings.brandName ? aiSettings.brandName : 'GoodCasino',
        meta
      });
    } catch (error) {
      console.warn('[buildReply] behaviour enforcement skipped due to error:', error);
    }
  }

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
  if (global.__livechatAiResponsesEnabled === false) {
    return { skip: true };
  }
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
  
  const sys = composeSystemPromptFull(aiSettings);
  const json = await buildReply({ chatId, text: userText, aiSettings, intent: null, systemPrompt: sys, groupId: effectiveGroupId, context });
  if (!json.intent || json.intent === 'general') {
    try {
      const inferred = detectIntent(userText);
      if (inferred && inferred !== 'general') json.intent = inferred;
    } catch (_) {}
  }
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
  if (global.__livechatAiResponsesEnabled === false) {
    return { skip: true };
  }
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
          // Build a clear multi-message prompt with proper context
          const timeSpan = msgs.length > 1 ? Math.floor((msgs[msgs.length - 1].ts - msgs[0].ts) / 1000) : 0;
          const multiMessagePrompt = 
            `The user sent ${msgs.length} messages in quick succession (within ${timeSpan} seconds). ` +
            `Please read ALL messages together as one continuous thought and provide ONE comprehensive response that addresses everything.\n\n` +
            msgs.map((m, i) => `Message ${i + 1}: ${m.text}`).join('\n') +
            `\n\nImportant: Treat these as connected messages from the same conversation. ` +
            `If they're asking about the same topic (like deposit, withdraw, turnover), combine your understanding.`;
          
          try {
            replyObj = await buildGroupAwareReply(chatId, multiMessagePrompt, context);
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
