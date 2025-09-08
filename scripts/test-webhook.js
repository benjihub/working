// scripts/test-webhook.js
// Local tester to simulate LiveChat webhook call
require('dotenv').config();
const axios = require('axios');

async function main() {
  const candidates = [];
  if (process.env.TEST_BASE_URL) candidates.push(process.env.TEST_BASE_URL);
  const envPort = process.env.PORT || 3002;
  candidates.push(`http://localhost:${envPort}`);
  candidates.push('http://localhost:3002', 'http://localhost:3003', 'http://localhost:3004');
  const tried = new Set();
  const secret = process.env.LIVECHAT_WEBHOOK_SECRET || 'changeme';
  const sample = {
    secret_key: secret,
    action: 'incoming_event',
    payload: {
      chat_id: 'test_chat_123',
      event: {
        type: 'message',
        text: 'hello from tester'
      }
    }
  };
  for (const base of candidates) {
    if (tried.has(base)) continue; tried.add(base);
    const url = `${base}/livechat/webhook`;
    try {
      const { data } = await axios.post(url, sample, {
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': secret
        }
      });
      console.log(`OK at ${base}:`, data);
      return;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data || err.message;
      console.error(`Failed at ${base}:`, status, body);
    }
  }
  console.error('All attempts failed. Ensure the server is running and LIVECHAT_WEBHOOK_SECRET matches.');
  process.exit(1);
}

main();
