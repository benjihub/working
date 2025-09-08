# Payment Assistant + LiveChat Bot

Node/Express webhook bot for LiveChat with an optional local chat UI. Uses PAT (Basic auth) for LiveChat Agent API sends and a secure webhook handler with cooldown and dedup to avoid spam.

## Scripts
- npm run server – start server only (recommended for Render)
- npm run bot – run legacy polling bot locally (optional)
- npm start – runs both server and bot locally via run-all.js
- npm run webhooks:register – register webhook with LiveChat
- npm run webhooks:list – list registered webhooks
- npm run webhooks:delete -- <id> – delete a webhook by id

## Environment
Copy .env.example to .env and fill these values:
- LIVECHAT_PAT – base64("<account_id>:<personal_access_token>")
- LIVECHAT_WEBHOOK_URL – your public URL + /livechat/webhook
- LIVECHAT_WEBHOOK_SECRET – a strong shared secret
- LIVECHAT_CLIENT_ID – any identifier for your app (owner_client_id)
- LIVECHAT_REPLY_COOLDOWN_MS – ms between replies per chat (default 5000)
- BOT_SECRET – optional secret required by admin endpoints
- USE_OPENAI=false unless you provide OPENAI_API_KEY

Note: OAuth client_credentials is not supported by LiveChat Agent APIs. If you use Bearer, it must come from authorization code flow. PAT via Basic is simpler and works reliably.

## Endpoints
- GET /livechat/webhook – health check (returns {status:'ok'})
- POST /livechat/webhook – LiveChat incoming_event webhook
- GET/POST /api/bot/chat – local chat to the GoodCasino bot (guarded by BOT_SECRET if set)
- GET /api/bot/health – bot health
- GET/PUT/POST /api/rtp – RTP link management
- Static UI: /test.html and /web-chat

## Deploy on Render
This repo includes render.yaml. In Render, import from GitHub and ensure:
- Start command: node server.js (do NOT use run-all.js)
- Env vars: set LIVECHAT_PAT, LIVECHAT_WEBHOOK_URL, LIVECHAT_WEBHOOK_SECRET, LIVECHAT_CLIENT_ID; optionally BOT_SECRET; set USE_OPENAI=false unless a key is provided.

Then register the webhook from your local machine, pointing to the Render URL:
1) Locally, set the same env (or edit .env):
	- LIVECHAT_PAT
	- LIVECHAT_WEBHOOK_URL=https://<your-service>.onrender.com/livechat/webhook
	- LIVECHAT_WEBHOOK_SECRET=<your-secret>
	- LIVECHAT_CLIENT_ID=<your-id>
2) Run: npm run webhooks:register
3) Verify with: npm run webhooks:list

If you previously registered other URLs, remove duplicates with: npm run webhooks:delete -- <id>

## Troubleshooting
- 401 Invalid access token on Render: ensure you’re using PAT via LIVECHAT_PAT (Basic), not an empty LIVECHAT_ACCESS_TOKEN. Also make sure server uses node server.js, not run-all.js.
- Crash about OpenAI key: set USE_OPENAI=false (default) or provide OPENAI_API_KEY.
- Webhook spam: cooldown is controlled by LIVECHAT_REPLY_COOLDOWN_MS, and dedup is enabled.

## GitHub quick start
```
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```