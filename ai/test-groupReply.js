// Test script for groupReply.js
// Mocks aiClient and db to test buildGroupAwareReply

const path = require('path');

// Mock aiClient before requiring groupReply
const mockAiClient = {
  chatCompletion: async (params, meta) => {
    // Return a mock response that matches the expected JSON schema
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            status: 'providing_info',
            reply: 'Bosku, kita terima:\n🏦 Bank: BCA, BNI, Mandiri\n📱 E-Wallet: GoPay, ShopeePay\n',
            intent: 'bankinfo',
            context: {
              userId: null,
              language: 'id',
              groupId: '1',
              brand: 'VIP Casino Group 1',
              limits: { deposit: '50000', withdraw: '100000' },
              payment_methods: { banks: ['BCA', 'BNI', 'Mandiri'], ewallets: ['GoPay', 'ShopeePay'], qris: false },
              rtpLink: 'https://vipcasino.com/rtp',
              promotion: null
            },
            next_step: 'Bosku, ada lagi yang bisa dibantu?',
            validation: { userid_collected: null, userid_verified: null, transaction_verified: null, ready_for_processing: null },
            errors: []
          })
        }
      }]
    };
  }
};

// Mock db-utils
const mockDb = {
  getChatGroup: async (chatId) => ({ group_id: 1 }),
  getGroupConfig: async (groupId) => ({
    aiSettings: {
      brandName: 'VIP Casino Group 1',
      aiBehaviour: 'Be super friendly and use lots of emojis.',
      banks: ['BCA', 'BNI', 'Mandiri'],
      ewallets: ['GoPay', 'ShopeePay'],
      qris: false,
      depositLimits: '50000',
      withdrawLimits: '100000',
      rtpLink: 'https://vipcasino.com/rtp',
      promotions: []
    }
  }),
  listGroupPromotions: async (groupId) => []
};

// Override requires
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === '../utils/aiClient') return mockAiClient;
  if (id === '../db-utils') return mockDb;
  return originalRequire.apply(this, arguments);
};

// Now require groupReply
const groupReply = require('./groupReply.js');

async function runTest() {
  try {
    console.log('Running test for buildGroupAwareReply...');

    const result = await groupReply.buildGroupAwareReply('chat123', 'apa metode pembayaran yang tersedia?', { group_id: 1 });

    console.log('Test result:', JSON.stringify(result, null, 2));

    // Basic assertions
    if (typeof result === 'object' && result.reply && result.intent && result.context) {
      console.log('✅ Test passed: Response has expected structure');
    } else {
      console.log('❌ Test failed: Response missing required fields');
    }

    // Check if payment methods are included in reply
    if (result.reply.includes('Bank:') && result.reply.includes('E-Wallet:')) {
      console.log('✅ Test passed: Payment methods included in reply');
    } else {
      console.log('❌ Test failed: Payment methods not found in reply');
    }

  } catch (error) {
    console.error('Test error:', error);
  }
}

runTest();