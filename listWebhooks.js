// listWebhooks.js
// List registered webhooks across versions using available auth variants
require('dotenv').config();
const axios = require('axios');
const { getHeaderVariants } = require('./livechatAuth');

(async () => {
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    console.error('LiveChat credentials missing');
    process.exit(1);
  }
  const endpoints = [
    { label: 'v3.6', url: 'https://api.livechatinc.com/v3.6/configuration/action/list_webhooks' },
    { label: 'v3.5', url: 'https://api.livechatinc.com/v3.5/configuration/action/list_webhooks' },
    { label: 'v3.3', url: 'https://api.livechatinc.com/v3.3/configuration/action/list_webhooks' }
  ];
  for (const ep of endpoints) {
    for (const variant of headerVariants) {
      try {
        const { data, status } = await axios.post(ep.url, {}, { headers: { ...variant, Accept: 'application/json' }, timeout: 15000 });
        const variantName = Object.values(variant)[0]?.toString().startsWith('Basic') ? 'Basic' : 'Bearer';
        console.log(`List webhooks via ${ep.label} using ${variantName} (status ${status})`);
        console.dir(data, { depth: 6 });
        break;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data || err.message;
        console.warn(`List ${ep.label} failed with one variant:`, status, msg);
        continue;
      }
    }
  }
})();
