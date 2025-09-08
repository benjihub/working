// registerWebhook.js
// Robust CLI to register LiveChat webhook (tries Bearer/Basic and v3.6/v3.5/v3.3)
require('dotenv').config();
const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

const clientId = process.env.LIVECHAT_CLIENT_ID;
const headerVariants = getHeaderVariants();
const webhookUrl = process.env.LIVECHAT_WEBHOOK_URL;
const secret = process.env.LIVECHAT_WEBHOOK_SECRET;
const description = process.env.LIVECHAT_WEBHOOK_DESCRIPTION || 'Webhook for incoming chat events';
const type = process.env.LIVECHAT_WEBHOOK_TYPE || 'license';

if (!clientId || !webhookUrl || !secret || !headerVariants || headerVariants.length === 0) {
  console.error('Missing env: LIVECHAT_CLIENT_ID, LIVECHAT_WEBHOOK_URL, LIVECHAT_WEBHOOK_SECRET, and LiveChat credentials');
  process.exit(1);
}

async function register() {
  const attempts = [];
  for (const ver of ['v3.6', 'v3.5']) {
    attempts.push({
      label: `${ver}`,
      url: `https://api.livechatinc.com/${ver}/configuration/action/register_webhook`,
      // Top-level payload per API docs; single action per registration
      body: {
        url: webhookUrl,
        description: 'GoodCasino bot incoming customer messages',
        action: 'incoming_event',
        secret_key: secret,
        owner_client_id: clientId,
        type,
        filters: {
          author_type: 'customer'
        }
      }
    });
  }
  attempts.push({
    label: 'v3.3 (flat)',
    url: 'https://api.livechatinc.com/v3.3/configuration/action/register_webhook',
    body: {
      url: webhookUrl,
      description: 'GoodCasino bot incoming messages (v3.3 fallback)',
      action: 'incoming_event',
      secret_key: secret,
      owner_client_id: clientId,
      type
    }
  });

  let lastErr = null;
  for (const attempt of attempts) {
    for (const variant of headerVariants) {
      try {
        const { data, status } = await axios.post(
          attempt.url,
          attempt.body,
          { headers: { ...variant, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 }
        );
        const variantName = Object.values(variant)[0]?.toString().startsWith('Basic') ? 'Basic' : 'Bearer';
        console.log(`Webhook registered via ${attempt.label} using ${variantName} (status ${status})`);
        console.log(data);
        return;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.response?.data || err.message;
        const variantName = Object.values(variant)[0]?.toString().startsWith('Basic') ? 'Basic' : 'Bearer';
        console.warn(`Attempt ${attempt.label} with ${variantName} failed:`, status, msg);
        lastErr = err;
      }
    }
  }
  console.error('All attempts failed. Last error:', lastErr?.response?.data || lastErr?.message);
  process.exit(1);
}

register();
