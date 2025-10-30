// livechatAuth.js
// Builds LiveChat Authorization headers with sane preference order.
require('dotenv').config({ override: true });

function buildBasicFromUserPass(user, pass) {
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

function getAuthHeaderPreferred() {
  const user = process.env.LIVECHAT_USERNAME;
  const pass = process.env.LIVECHAT_PASSWORD;
  if (user && pass) return buildBasicFromUserPass(user, pass);

  const pat = process.env.LIVECHAT_PAT; // expected to be base64(AccountId:Token)
  if (pat && /^[A-Za-z0-9+/=]+$/.test(pat)) return { Authorization: `Basic ${pat}` };

  const bearer = process.env.LIVECHAT_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  if (bearer) return { Authorization: `Bearer ${bearer}` };

  return null;
}

function getHeaderVariants() {
  const headers = [];
  const preferred = getAuthHeaderPreferred();
  if (preferred) headers.push(preferred);

  // Build supplemental variants for robustness
  const user = process.env.LIVECHAT_USERNAME;
  const pass = process.env.LIVECHAT_PASSWORD;
  const pat = process.env.LIVECHAT_PAT;
  const bearer = process.env.LIVECHAT_ACCESS_TOKEN || process.env.ACCESS_TOKEN;

  // Ensure Basic is included if possible
  if (!(preferred && preferred.Authorization.startsWith('Basic '))) {
    if (user && pass) headers.push(buildBasicFromUserPass(user, pass));
    else if (pat && /^[A-Za-z0-9+/=]+$/.test(pat)) headers.push({ Authorization: `Basic ${pat}` });
  }

  // Ensure Bearer is included if present
  if (bearer && !(preferred && preferred.Authorization.startsWith('Bearer '))) {
    headers.push({ Authorization: `Bearer ${bearer}` });
  }

  return headers;
}

module.exports = { buildBasicFromUserPass, getAuthHeaderPreferred, getHeaderVariants };
