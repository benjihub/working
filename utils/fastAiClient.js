// utils/fastAiClient.js
// Optimized OpenAI wrapper with timeouts and fast response configuration
require('dotenv').config({ override: true });

const dbx = require('../db-utils');
const { FAST_AI_CONFIG, OPENAI_TIMEOUT_MS, FAST_FALLBACKS } = require('./fastResponseConfig');
const aiClient = require('./aiClient');

// Compact governance prompt for faster processing
const FAST_GOVERNANCE = 'Act as a helpful human casino support agent. No AI mentions. Keep responses short and friendly.';

// Fast response cache
const responseCache = new Map();

function getCacheKey(messages, model) {
  const lastMessage = messages[messages.length - 1]?.content || '';
  return `${model}_${lastMessage.slice(0, 100)}`.toLowerCase();
}

function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 2 * 60 * 1000) { // 2 minute cache
    return cached.response;
  }
  return null;
}

function setCachedResponse(cacheKey, response) {
  responseCache.set(cacheKey, { response, timestamp: Date.now() });
  
  // Clean cache if it gets too large
  if (responseCache.size > 100) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
}

// Optimized chat completion with timeout and fast settings
async function fastChatCompletion(params = {}, meta = {}) {
  const startTime = Date.now();
  try {
    // Apply fast AI configuration
    const optimizedParams = {
      ...FAST_AI_CONFIG,
      ...params,
      messages: params.messages || []
    };

    // Check cache first
    const cacheKey = getCacheKey(optimizedParams.messages, optimizedParams.model);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      console.log('⚡ Cache hit for fast response');
      return { choices: [{ message: { content: cached } }] };
    }

    // Reduce message history for speed
    const messages = optimizedParams.messages.slice(-4); // Keep only last 4 messages
    
    // Add fast governance
    if (messages[0]?.role !== 'system' || !messages[0]?.content?.includes('casino support')) {
      messages.unshift({ role: 'system', content: FAST_GOVERNANCE });
    }

    // Create request with timeout
    // Delegate to the central aiClient.chatCompletion which may route to webhook AI
    const resp = await aiClient.chatCompletion({ ...optimizedParams, messages }, { chatId: meta.chatId || null, source: meta.source || 'fast', groupId: meta.groupId || null });
    
    const responseTime = Date.now() - startTime;
    const content = resp?.choices?.[0]?.message?.content || '';
    
    // Cache successful response
    if (content) {
      setCachedResponse(cacheKey, content);
    }
    
    console.log(`⚡ Fast AI response in ${responseTime}ms`);
    
    // Log if response is slow
    if (responseTime > 5000) {
      console.warn(`🐌 Slow AI response: ${responseTime}ms`);
    }

    return resp;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.warn(`❌ Fast AI failed after ${responseTime}ms:`, error?.message || error);
    // Return fast fallback
    return { choices: [{ message: { content: FAST_FALLBACKS.processing } }] };
  }
}

module.exports = {
  isEnabled: typeof aiClient.isEnabled === 'function' ? aiClient.isEnabled : () => false,
  fastChatCompletion,
  FAST_FALLBACKS
};