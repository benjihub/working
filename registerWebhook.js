// registerWebhook.js
// Robust CLI to register LiveChat webhook (tries Bearer/Basic and v3.6/v3.5/v3.3)
require('dotenv').config({ override: true });
const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

const clientId = process.env.LIVECHAT_CLIENT_ID;
const headerVariants = getHeaderVariants();
const webhookUrl = process.env.LIVECHAT_WEBHOOK_URL;
const secret = process.env.LIVECHAT_WEBHOOK_SECRET;
const description = process.env.LIVECHAT_WEBHOOK_DESCRIPTION || 'GoodCasino LiveChat webhook';
const type = process.env.LIVECHAT_WEBHOOK_TYPE || 'license';
const actionsEnv = process.env.LIVECHAT_WEBHOOK_ACTIONS || 'incoming_event,customer_message,chat_started,thread_started';
const actions = actionsEnv.split(',').map(a => a.trim()).filter(Boolean);

if (!clientId || !webhookUrl || !secret || !headerVariants || headerVariants.length === 0) {
  console.error('Missing env: LIVECHAT_CLIENT_ID, LIVECHAT_WEBHOOK_URL, LIVECHAT_WEBHOOK_SECRET, and LiveChat credentials');
  process.exit(1);
}

if (actions.length === 0) {
  console.error('No webhook actions provided. Set LIVECHAT_WEBHOOK_ACTIONS or leave default.');
  process.exit(1);
}

async function attemptRegistration({ url, body, label }) {
  let lastErr = null;
  for (const variant of headerVariants) {
    const variantName = Object.values(variant)[0]?.toString().startsWith('Basic') ? 'Basic' : 'Bearer';
    try {
      const { data, status } = await axios.post(url, body, {
        headers: { ...variant, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 20000
      });
      console.log(`✅ Registered ${body.action} via ${label} using ${variantName} (status ${status})`);
      return { ok: true, data };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.response?.data || err.message;
      console.warn(`⚠️ ${body.action} attempt ${label} with ${variantName} failed:`, status, msg);
      // Continue trying other variants/versions
    }
  }
  return { ok: false, error: lastErr };
}

async function register() {
  const failures = [];
  for (const action of actions) {
    let registered = false;
    const payloadBase = {
      url: webhookUrl,
      description,
      action,
      secret_key: secret,
      owner_client_id: clientId,
      type
    };
    const payloadWithFilters = /incoming_event|customer_message/.test(action)
      ? { ...payloadBase, filters: { author_type: 'customer' } }
      : payloadBase;

    const attempts = [
      {
        label: 'v3.6',
        url: 'https://api.livechatinc.com/v3.6/configuration/action/register_webhook',
        body: payloadWithFilters
      },
      {
        label: 'v3.5',
        url: 'https://api.livechatinc.com/v3.5/configuration/action/register_webhook',
        body: payloadWithFilters
      },
      {
        label: 'v3.3 (fallback)',
        url: 'https://api.livechatinc.com/v3.3/configuration/action/register_webhook',
        body: payloadBase
      }
    ];

    for (const attempt of attempts) {
      const result = await attemptRegistration(attempt);
      if (result.ok) {
        registered = true;
        break;
      }
    }

    if (!registered) {
      const err = `Failed to register action ${action}. Check credentials and retry.`;
      console.error(err);
      failures.push(action);
    }
  }

  if (failures.length) {
    console.error(`❌ Webhook registration failed for: ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log('🎉 All requested webhooks registered successfully.');
}

register();
