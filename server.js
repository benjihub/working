// server.js
// Express server for LiveChat + local APIs
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { sendMessage: sendLivechatMessage } = require('./livechatApi');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const dbUtils = require('./db-utils');
const {
  getDb,
  getChatState,
  updateChatState,
  addMessage,
  getChatMessages
} = dbUtils;
let db;

// Initialize database
const initializeDatabase = async () => {
  try {
    db = await dbUtils.initDb();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    process.exit(1);
  }
};

// Import the smart payment AI
const smartPaymentAI = require('./smart-payment-ai.js');
const { 
  getSmartResponse, 
  detectOffTopic,
  extractCID,
  extractPlanType,
  extractCurrencyPreference,
  PAYMENT_STATES,
  PAYMENT_TEMPLATES
} = smartPaymentAI;
const getPaymentChatState = smartPaymentAI.getChatState;

// Import GoodCasino bot functions for local chat API
const {
  getCustomerServiceResponse: gcGetResponse,
  getChatState: gcGetChatState
} = require('./newtest3');

const app = express();
const INITIAL_PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = '0.0.0.0';

// Global server instance
let serverInstance = null;
let activePort = INITIAL_PORT;

// In-memory deduplication for webhook events (prevent spam on duplicates)
const processedEvents = new Map(); // id -> timestamp
function isDuplicateEvent(eventId, ttlMs = 5 * 60 * 1000) {
  if (!eventId) return false;
  const now = Date.now();
  const prev = processedEvents.get(eventId);
  if (prev && now - prev < ttlMs) return true;
  processedEvents.set(eventId, now);
  // occasional prune
  if (processedEvents.size > 5000) {
    const cutoff = now - ttlMs;
    for (const [id, ts] of processedEvents) {
      if (ts < cutoff) processedEvents.delete(id);
    }
  }
  return false;
}

// Function to get server instance
function getServerInstance() {
  if (!serverInstance) {
    throw new Error('Server not initialized');
  }
  return serverInstance;
}

// Function to start the server
const startServer = async () => {
  try {
    await initializeDatabase();
    
    // Helper to attempt listening on a port and resolve/reject accordingly
    const listenOnce = (port) => new Promise((resolve, reject) => {
      const server = app.listen(port, () => resolve(server));
      server.on('error', (err) => reject(err));
    });

    // Try initial port, then next two if busy (total up to 3 attempts)
    let portToTry = INITIAL_PORT;
    let attemptsLeft = 2;
    while (true) {
      try {
        const server = await listenOnce(portToTry);
        serverInstance = server;
        activePort = portToTry;

        const addressInfo = server.address();
        let localUrl = `http://localhost:${portToTry}`;
        let networkUrl = `http://${getLocalIpAddress()}:${portToTry}`;
        if (addressInfo) {
          if (typeof addressInfo === 'string') {
            localUrl = addressInfo;
            networkUrl = addressInfo;
          } else if (typeof addressInfo === 'object' && addressInfo.port) {
            localUrl = `http://localhost:${addressInfo.port}`;
            networkUrl = `http://${getLocalIpAddress()}:${addressInfo.port}`;
          }
        }

        console.log(`\n🚀 Server Details:`);
        console.log(`   • Address: ${localUrl}`);
        console.log(`   • Network: Accessible from other devices on the network`);
        console.log(`   • Time: ${new Date().toISOString()}`);

        console.log('\n🔍 Available Endpoints:');
        console.log(`   • GET  /api/promotions - List all promotions`);
        console.log(`   • POST /api/promotions - Add a new promotion`);
        console.log(`   • PUT  /api/promotions/:id - Update a promotion`);
        console.log(`   • DELETE /api/promotions/:id - Delete a promotion`);
        console.log(`   • GET  /api/rtp - Get RTP link (JSON)`);
        console.log(`   • PUT  /api/rtp - Update RTP link (persisted)`);
        console.log(`   • POST /api/rtp - Get RTP link (JSON)`);
        console.log(`   • GET  /api/trp - Alias RTP link (JSON)`);
        console.log(`   • POST /api/trp - Alias RTP link (JSON)`);

        console.log('\n✨ Server Features:');
        console.log('   • Payment processing automation');
        console.log('   • Real-time promotions management');
        console.log('   • Smart AI response generation');
        console.log('   • Bilingual support (EN/ID)');

        console.log('\nServer is running on:');
        console.log(`   - Local: ${localUrl}`);
        console.log(`   - Network: ${networkUrl}`);
        console.log('\n✨ Server is ready!');

        // Also attach a generic error logger for runtime errors
        server.on('error', (error) => {
          console.error('\n❌ Server error:', error);
        });
        break; // success
      } catch (error) {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
          console.error(`\n❌ Port ${portToTry} in use. Retrying on ${portToTry + 1}...`);
          portToTry += 1;
          attemptsLeft -= 1;
          continue;
        }
        if (error.code === 'EADDRINUSE') {
          console.error(`\n❌ All attempted ports are in use starting from ${INITIAL_PORT}.`);
          console.log('Please close the other application or set a free PORT in .env.');
        } else {
          console.error('\n❌ Failed to start server:', error);
        }
        process.exit(1);
      }
    }

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
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
  
  // Update last activity in the database
  try {
    if (!db) {
      console.error('Database not initialized');
      return;
    }
    
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT OR IGNORE INTO chats (id, state, last_activity) VALUES (?, ?, ?)',
        [chatId, '{}', now],
        (err) => err ? reject(err) : resolve()
      );
    });
    
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE chats SET last_activity = ? WHERE id = ?',
        [now, chatId],
        (err) => err ? reject(err) : resolve()
      );
    });
  } catch (error) {
    console.error('Error updating chat activity:', error);
  }
}

app.use(cors({
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-bot-secret']
}));
app.use(bodyParser.json());
app.use(express.static(__dirname));
// Also serve assets from ./public for the web chat UI
app.use(express.static(path.join(__dirname, 'public')));

// LiveChat webhook endpoint
// Lightweight GET for external health checks
app.get('/livechat/webhook', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/livechat/webhook', async (req, res) => {
  const { secret_key, action, payload } = req.body || {};
  const headerSecret = (req.headers['x-webhook-secret'] ?? req.headers['x-livechat-webhook-secret'] ?? '').toString().trim();
  const provided = ((secret_key ?? headerSecret) || '').toString().trim();
  const expected = (process.env.LIVECHAT_WEBHOOK_SECRET ?? '').toString().trim();
  if (!expected || provided !== expected) {
    console.warn('Invalid webhook secret', { providedLen: provided.length, expectedSet: !!expected });
    return res.status(403).json({ error: 'Forbidden' });
  }
  console.log('Webhook action:', action);
  console.log('Webhook payload:', payload);
  // Ack immediately to prevent LiveChat retries
  res.json({ status: 'received' });

  // Process asynchronously to avoid timeouts/retries
  setImmediate(async () => {
    try {
      if (!(action === 'incoming_event' && payload?.event?.type === 'message')) return;

      const chatId = payload.chat_id;
      const text = payload.event?.text || '';
      const eventId = payload.event?.id || payload.event?.custom_id;
      if (isDuplicateEvent(eventId)) {
        console.log('Ignored duplicate event', eventId);
        return;
      }
      // Avoid loops: ignore events created by this app/client_id
      const sourceClient = payload?.event?.properties?.source?.client_id;
      if (sourceClient && process.env.LIVECHAT_CLIENT_ID && sourceClient === process.env.LIVECHAT_CLIENT_ID) {
        console.log('Ignored own message');
        return;
      }
  // Only respond to customer messages; try multiple shapes
  const authorType = payload?.event?.author_type || payload?.event?.properties?.source?.type || payload?.author_type;
      if (authorType && authorType !== 'customer') {
        console.log('Ignored non-customer message');
        return;
      }

      // Cooldown per chat to avoid rapid-fire replies
      const cooldownMs = parseInt(process.env.LIVECHAT_REPLY_COOLDOWN_MS || '3000', 10);
      if (!global.__lastReplyByChat) global.__lastReplyByChat = new Map();
      const now = Date.now();
      const last = global.__lastReplyByChat.get(chatId) || 0;
      if (now - last < cooldownMs) {
        console.log('Cooldown active; skipping reply', { chatId, waited: now - last });
        return;
      }
      global.__lastReplyByChat.set(chatId, now);

      // Generate a smart reply via GoodCasino bot logic
      gcGetChatState(chatId);
      const reply = await gcGetResponse(chatId, text, `${chatId}_${Date.now()}`);
      const finalText = (reply && reply.trim()) ? reply.trim() : 'Thanks for your message.';
      await sendLivechatMessage(chatId, finalText);
      console.log('Bot reply sent');
    } catch (err) {
      console.error('Error processing webhook:', err.response?.data || err.message);
    }
  });
});


// API endpoint to get dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }

    // better-sqlite3 is synchronous; use .prepare().get()
    const row = db.prepare(
      'SELECT COUNT(*) AS totalChats, COUNT(DISTINCT json_extract(state, "$.userId")) AS uniqueUsers FROM chats'
    ).get();
    const stats = row || { totalChats: 0, uniqueUsers: 0 };
    
    res.json({
      activeUsers: stats.uniqueUsers || 0,
      openTickets: stats.totalChats || 0,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error getting dashboard stats:', error);
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

// In-memory support ping store
const supportPings = [];

// Helper: create a support ping entry
function createSupportPing({ type = 'deposit_check', chatId, userId, amount = null, language = 'id', message = '' }) {
  if (!chatId || !userId) return;
  const ping = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    type,
    chatId,
    userId,
    amount,
    language,
    message,
    timestamp: Date.now(),
    read: false
  };
  supportPings.push(ping);
  return ping;
}

// Helper: detect support-worthy events from a free-text message
function detectSupportEvent(textRaw) {
  if (!textRaw) return null;
  const text = String(textRaw).toLowerCase();
  
  // Password reset
  if (/reset\s*password|password\s*reset|forgot\s*password|lupa\s*(password|sandi)/i.test(text)) {
    return { type: 'password_reset' };
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

// LiveChat API helper: prefer Basic auth (username/password or base64 PAT), fallback to Bearer
const { getHeaderVariants } = require('./livechatAuth');
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

// Import promotions module
const { 
  getPromotions, 
  addPromotion, 
  updatePromotion, 
  deletePromotion,
  formatPromotions
} = require('./promotions');

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

app.post('/api/promotions', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      discount, 
      code,
      timeLimit,
      terms,
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
    
    const promotionData = { 
      title, 
      description, 
      discount: Number(discount), 
      code: code || null,
      timeLimit: timeLimit || null,
      terms: terms || null,
      endDate: endDate || null,
      // Store under both keys for compatibility with different consumers
      eligibleItems: Array.isArray(elig) ? elig : [],
      eligibleGames: Array.isArray(elig) ? elig : []
    };
    
    const newPromotion = await addPromotion(promotionData);
    res.status(201).json({ success: true, promotion: newPromotion });
  } catch (error) {
    console.error('Error adding promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to add promotion' });
  }
});

app.put('/api/promotions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const updated = await updatePromotion(Number(id), updates);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
    res.json({ success: true, promotion: updated });
  } catch (error) {
    console.error('Error updating promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to update promotion' });
  }
});

app.delete('/api/promotions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const success = await deletePromotion(Number(id));
    if (!success) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
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

// In-memory settings for templates and brand name
let settings = {
  brandName: 'Cekipos Payment Assistant',
  welcomeMessage: 'Hello! I\'m here to help you with your Cekipos payment, bro. Can you share your CID?',
  waitMessage: 'Alright boss, please wait while we check this for you 😊',
  endMessage: 'Thank you boss, we wish you good luck! 😘'
};

// (Note) LiveChat send is handled via helper in livechatApi.js

// Enhanced send-message endpoint with smart AI
app.post('/send-message', async (req, res) => {
  // Optional shared-secret protection for browser bridge
  const requiredSecret = process.env.BOT_SECRET || '';
  if (requiredSecret) {
    const provided = req.headers['x-bot-secret'];
    if (!provided || provided !== requiredSecret) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }
  const { chatId, message, userId } = req.body;
  
  if (!chatId || !message) {
    return res.status(400).json({ success: false, error: 'chatId and message are required' });
  }
  
  // Lightweight detection for urgent support events to notify the dashboard
  try {
    const evt = detectSupportEvent(message);
    if (evt) {
      // Create a support ping for the dashboard (in-memory queue)
      createSupportPing({
        type: evt.type,
        chatId,
        userId: userId || 'anonymous',
        amount: evt.amount || null,
        language: evt.language || 'id',
        message: message
      });
    }
  } catch (_) {
    // non-fatal
  }

  try {
    // Update chat activity
    await updateChatActivity(chatId, userId || 'anonymous');
    
    // Get or create chat state from database
    let chatState = await getChatState(db, chatId);
    let parsedState;
    
    // If no chat state exists, initialize it
    if (!chatState) {
      parsedState = {
        context: {
          language: 'en',
          telegram_username: null,
          telegram_from_id: null,
          cid: null,
          plan: 'EXTEND',
          subscription_type: null,
          preferred_currency: 'USDT',
          transfer_address: null,
          transfer_amount: null,
          original_price_usdt: null,
          converted_price_idr: null,
          idr_rate: null,
          transaction_date: null,
          transaction_id: null,
          currency: null,
          transaction_amount: null,
          conversationHistory: []
        },
        payment_state: PAYMENT_STATES.GREETING,
        lastProcessedMessageId: null,
        lastResponseTime: null,
        started: Date.now(),
        offTopicWarningCount: 0,
        hasSentWelcome: false,
        validation: {
          telegram_user_identified: null,
          cid_verified: null,
          plan_validated: null,
          plan_refetched: null,
          subscription_confirmed: null,
          currency_conversion_applied: null,
          payment_details_ready: null,
          transaction_extracted: null,
          data_submitted_to_agent: null,
          ready_for_processing: null,
          cid_attempts: 0,
          subscription_attempts: 0,
          payment_attempts: 0
        }
      };
      // Save initial state to database
      await updateChatState(db, chatId, parsedState);
    } else {
      // Parse the existing state
      parsedState = typeof chatState.state === 'string' ? JSON.parse(chatState.state) : chatState.state;
    }
    
    // Get database instance once
    const db = getDb();
    
    // Save user message to database
    await addMessage(db, chatId, 'user', message);
    
    // Get smart response - pass the parsed state to getSmartResponse
    const response = await getSmartResponse(chatId, message);
    
    // Save bot response to database
    if (response) {
      await addMessage(db, chatId, 'assistant', response);
    }
    
    // Update chat state in database with the parsed state
    await updateChatState(db, chatId, parsedState);
    
    res.json({ 
      success: true, 
      response,
      aiFeatures: {
        offTopicDetected: detectOffTopic(message).isOffTopic,
        cidExtracted: extractCID(message),
        planType: extractPlanType(message),
        currency: extractCurrencyPreference(message)
      }
    });
  } catch (error) {
    console.error('Error in send-message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// New endpoint to get chat state information
app.get('/chat-state/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const db = getDb();
    const chatState = await getChatState(db, chatId);
    
    if (!chatState) {
      return res.status(404).json({ success: false, error: 'Chat not found' });
    }
    
    // Get chat messages
    const messages = await getChatMessages(db, chatId);
    
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

// New endpoint to test smart AI features
app.post('/test-smart-ai', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  
  try {
    const testChatId = 'test_' + Date.now();
    const smartResponse = await getSmartResponse(testChatId, message, `test_${Date.now()}`);
    const offTopicDetection = detectOffTopic(message);
    const cid = extractCID(message);
    const planType = extractPlanType(message);
    const currency = extractCurrencyPreference(message);
    
    res.json({
      success: true,
      originalMessage: message,
      smartResponse: smartResponse,
      analysis: {
        offTopic: offTopicDetection,
        cid: cid,
        planType: planType,
        currency: currency
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    const { title, description, discount, code, timeLimit, terms, eligibleItems, eligibleGames, endDate } = req.body;
    if (!title || !description || discount == null) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    // Normalize eligible items/games
    let elig = eligibleItems || eligibleGames || [];
    if (typeof elig === 'string') {
      elig = elig.split(',').map(s => s.trim()).filter(Boolean);
    }
    const newPromo = await addPromotion({
      title,
      description,
      discount: Number(discount),
      code: code || null,
      timeLimit: timeLimit || null,
      terms: terms || null,
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
app.get('/settings', (req, res) => {
  res.json({ success: true, settings });
});

// --- GoodCasino Bot (newtest3) local chat endpoint ---
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
    gcGetChatState(id);
    const reply = await gcGetResponse(id, message, `${id}_${Date.now()}`);
    return res.json({ success: true, chatId: id, reply: reply || '' });
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
    // Ensure state exists and get reply from GoodCasino bot
    gcGetChatState(id);
    const reply = await gcGetResponse(id, message, `${id}_${Date.now()}`);
    return res.json({ success: true, chatId: id, reply: reply || '' });
  } catch (e) {
    console.error('Error in /api/bot/chat:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// --- LiveChat debug/admin endpoints (guarded by optional BOT_SECRET) ---
function requireBotSecret(req, res) {
  const required = process.env.BOT_SECRET || '';
  if (!required) return true;
  const provided = req.headers['x-bot-secret'];
  if (!provided || provided !== required) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// List chats with optional ?status=active,queued,pending (defaults to active,queued,pending)
app.get('/api/livechat/chats', async (req, res) => {
  if (!requireBotSecret(req, res)) return;
  const statuses = (req.query.status || 'active,queued,pending')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const body = { filters: { status: statuses }, limit: 50 };
  const resp = await livechatPost('/agent/action/list_chats', body, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  const chats = resp.data?.chats_summary || resp.data?.chats || resp.data?.data?.chats || resp.data?.results || resp.data;
  res.json({ success: true, count: Array.isArray(chats) ? chats.length : 0, chats });
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
  const resp = await livechatPost('/agent/action/send_event', {
    chat_id: chatId,
    event: { type: 'message', text, recipients: 'all' }
  }, {});
  if (!resp.ok) return res.status(resp.status).json({ success: false, error: resp.error, details: resp.raw });
  res.json({ success: true, result: resp.data });
});
app.post('/settings', (req, res) => {
  const { brandName, welcomeMessage, waitMessage, endMessage } = req.body;
  if (!brandName || !welcomeMessage || !waitMessage || !endMessage) {
    return res.status(400).json({ success: false, error: 'All fields are required' });
  }
  settings = { brandName, welcomeMessage, waitMessage, endMessage };
  res.json({ success: true, settings });
});

// --- Support Ping Endpoints ---
// Create a new support ping (e.g., when a user says they've deposited)
app.post('/support-ping', (req, res) => {
  try {
    const { type = 'deposit_check', chatId, userId, amount = null, language = 'id', message } = req.body || {};
    if (!chatId || !userId) {
      return res.status(400).json({ success: false, error: 'chatId and userId are required' });
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
    const unread = supportPings.filter(p => !p.read).sort((a, b) => a.timestamp - b.timestamp);
    const { markRead } = req.query;
    if (markRead === 'true') {
      unread.forEach(p => { p.read = true; });
    }
    return res.json({ success: true, pings: unread });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// New endpoint to get AI capabilities
app.get('/ai-capabilities', (req, res) => {
  res.json({
    success: true,
    capabilities: {
      paymentProcessing: true,
      cidExtraction: true,
      planTypeDetection: true,
      currencyConversion: true,
      offTopicDetection: true,
      bilingualSupport: true,
      stateMachine: true,
      smartResponseGeneration: true,
      paymentStates: Object.values(PAYMENT_STATES),
      supportedLanguages: ['en', 'id'],
      supportedCurrencies: ['USDT', 'IDR'],
      supportedPlans: ['EXTEND', 'UPGRADE', 'DOWNGRADE']
    }
  });
});

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
  
  console.log('\n👋 Shutting down server...');
  
  // Close server instance first
  if (serverInstance) {
    console.log('🛑 Closing server...');
    serverInstance.close((err) => {
      if (err) {
        console.error('Error closing server:', err);
      } else {
        console.log('✅ Server has been stopped');
      }
      
      // Close database connection after server is closed
      if (db) {
        console.log('🔒 Closing database connection...');
        try {
          // better-sqlite3 uses synchronous close()
          db.close();
          console.log('✅ Database connection closed');
          process.exit(0);
        } catch (dbError) {
          console.error('Error during database close:', dbError);
          process.exit(0); // Still exit even if DB close fails
        }
      } else {
        process.exit(0);
      }
    });
    
    // Force close after 5 seconds if server doesn't close gracefully
    setTimeout(() => {
      console.warn('⚠️ Forcing server shutdown...');
      process.exit(0); // Use exit code 0 to prevent error reporting
    }, 5000);
  } else {
    // No server instance, just close DB if it exists
    if (db) {
      console.log('🔒 Closing database connection...');
      try {
        db.close((err) => {
          if (err) {
            console.error('Error closing database:', err);
          } else {
            console.log('✅ Database connection closed');
          }
          process.exit(0);
        });
      } catch (dbError) {
        console.error('Error during database close:', dbError);
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);