// deleteWebhook.js
// Delete a LiveChat webhook by ID
require('dotenv').config();
const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

async function main() {
  const id = process.argv[2] || process.env.LIVECHAT_WEBHOOK_ID;
  if (!id) {
    console.error('Usage: node deleteWebhook.js <webhook_id>  (or set LIVECHAT_WEBHOOK_ID)');
    process.exit(1);
  }
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    console.error('LiveChat credentials missing');
    process.exit(1);
  }
  const endpoints = [
    'https://api.livechatinc.com/v3.6/configuration/action/delete_webhook',
    'https://api.livechatinc.com/v3.5/configuration/action/delete_webhook',
    'https://api.livechatinc.com/v3.3/configuration/action/delete_webhook'
  ];
  for (const url of endpoints) {
    for (const variant of headerVariants) {
      try {
        const { status, data } = await axios.post(url, { id }, { headers: { ...variant, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 });
        const variantName = Object.values(variant)[0]?.toString().startsWith('Basic') ? 'Basic' : 'Bearer';
        console.log(`Deleted webhook ${id} via ${url} using ${variantName} (status ${status})`);
        console.log(data);
        return;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data || err.message;
        console.warn(`Delete via ${url} failed with one variant:`, status, msg);
      }
    }
  }
  console.error('Failed to delete webhook.');
  process.exit(1);
}

main();
