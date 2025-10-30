// Optimized configuration for faster automatic responses
module.exports = {
  // Faster OpenAI settings
  FAST_AI_CONFIG: {
    model: 'gpt-3.5-turbo',
    temperature: 0.3,           // Lower temperature for faster, more consistent responses
    max_tokens: 150,           // Reduced from 400 to 150 for faster responses
    top_p: 0.9,                // Optimize for speed
    frequency_penalty: 0.1,    // Slight penalty to avoid repetition
    presence_penalty: 0.1      // Slight penalty for diversity
  },
  
  // Timeout settings
  OPENAI_TIMEOUT_MS: 8000,     // 8 second timeout (down from unlimited)
  RESPONSE_DEADLINE_MS: 10000, // Total response deadline: 10 seconds
  
  // Database optimization
  HISTORY_LIMIT: 4,            // Reduce conversation history from 8 to 4 messages
  
  // Caching
  ENABLE_RESPONSE_CACHE: true,
  CACHE_TTL_MS: 2 * 60 * 1000, // 2 minute cache for similar messages
  
  // Performance monitoring
  LOG_RESPONSE_TIMES: true,
  SLOW_RESPONSE_THRESHOLD_MS: 5000, // Log if response takes > 5 seconds
  
  // Fast fallback responses
  FAST_FALLBACKS: {
    welcome: "Halo! Ada yang bisa saya bantu?",
    processing: "Terima kasih bosku, kami proses pesannya.",
    general: "Tim kami siap membantu. Ada yang bisa dibantu?"
  }
};