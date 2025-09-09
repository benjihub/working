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
# GoodCasino LiveChat Bot (Node/Express)

Production-ready Node.js + Express server integrated with LiveChat webhooks. Includes:
- Webhook handler with secret validation, duplicate suppression, customer-only filter, and per-chat cooldown
- Helper to send replies via LiveChat Agent Chat API (PAT Basic auth)
- CLI tools to register/list/delete webhooks
- Test page `test.html` with server status checks and LiveChat widget

## Quick start (local)
1) Install deps
```
npm install
```
2) Copy env
```
cp .env.example .env
```
3) Edit `.env` (set LIVECHAT_PAT as base64 account_id:PAT, set LIVECHAT_WEBHOOK_SECRET)
4) Run
```
npm run server
```
5) Open http://localhost:3002/test.html

## Webhooks
- Register: `npm run webhooks:register`
- List: `npm run webhooks:list`
- Delete: `npm run webhooks:delete -- <webhook_id>`

## Deploy to Render (recommended)
This repo includes a `render.yaml` for one-click deploy.

### Steps
1) Push to GitHub (see below)
2) On Render, create a new Web Service from your repo
	- Build Command: `npm install`
	- Start Command: `node server.js`
	- Port: Render supplies `PORT` automatically (render.yaml sets 10000 as default; Render overrides it)
3) Set environment variables in Render Dashboard:
	- LIVECHAT_CLIENT_ID
	- LIVECHAT_PAT (base64 account_id:PAT)
	- LIVECHAT_WEBHOOK_URL = https://<your-render-url>/livechat/webhook
	- LIVECHAT_WEBHOOK_SECRET = strong_random_string
	- LIVECHAT_REPLY_COOLDOWN_MS = 5000
	- BOT_SECRET (optional)
	- USE_OPENAI / OPENAI_API_KEY (optional)
4) Deploy
5) Register the webhook from the Render shell or locally:
```
npm run webhooks:register
```
6) Remove duplicates:
```
npm run webhooks:list
npm run webhooks:delete -- <id>
```

## Push to GitHub
```
git init
git add .
git commit -m "deploy: render setup"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo>.git
git push -u origin main
```

## Endpoints
- GET `/livechat/webhook` – health
- POST `/livechat/webhook` – LiveChat webhook (expects secret)
- GET `/api/bot/health` – bot health
- POST `/api/livechat/send/:chatId` – send message (requires BOT_SECRET if set)

## Security
- Never commit `.env` or real secrets. Use `.env.example` only as a template.
- Use a strong `LIVECHAT_WEBHOOK_SECRET` and rotate if exposed.# working
