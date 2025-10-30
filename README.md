# Casino Chat Buddy

Start here: GETTING_STARTED.md

- What it is: A simple dashboard for Owners, Masters, and Agents to manage groups, live chat, promotions, and per‑group AI settings.
- Who should read the guide: Everyone. It explains roles, how to log in, switch groups (default is All Groups), manage teams, and use live chat.

Files of interest
- GETTING_STARTED.md — Beginner-friendly guide with step-by-step tasks per role.
- server2.js — Express API server (primary entrypoint).
- newtest4.html — Web dashboard UI.

Quick start (PAT-only, Windows PowerShell)
- Set env vars in your PowerShell session:
	- `$env:LIVECHAT_PAT = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("<ACCOUNT_ID>:<PAT_TOKEN>"))`
	- `$env:DISABLE_LIVECHAT_WEBHOOK = "true"`
- Run from the `finished` folder:
	- `cd finished; npm install; npm run server`
- Configure a group’s LiveChat License/Group/Widget in Admin > Group Config, then use the Live Chat tab.

Standalone webhook bot
- Purpose: Receive LiveChat webhooks and answer with the standalone AI brain without running the dashboard server.
- Requirements: Set `LIVECHAT_WEBHOOK_SECRET`, `LIVECHAT_CLIENT_ID`, and AI/OpenAI env vars (see `GETTING_STARTED.md`). Optional: `BOT_SECRET` to protect `/agent/send`.
- Run from the `finished` folder: `npm run livechat:webhook-bot`
- Exposes `POST /livechat/webhook` (processes `incoming_event` & `incoming_rich_message` only) and `POST /agent/send` (manual replies), plus `GET /health`.
- Webhook signatures are validated with `LIVECHAT_WEBHOOK_SECRET` and duplicate/looped events are ignored.
- Optional monitoring: hook into lifecycle events via `require('./monitoring-hooks')` to track inbound/outbound traffic and errors.

Need help?
Open GETTING_STARTED.md first. If something looks off in the UI, refresh your browser and make sure the server is running.

Monitoring hooks
- Module: `monitoring-hooks.js`
- Events exposed (`EVENTS`): `webhook.received`, `chat.opened`, `message.inbound`, `ai.response`, `livechat.send_success`, `livechat.send_failure`, `message.skipped`, `webhook.unauthorized`, `bot.error`.
- Usage example:
	```js
	const { EVENTS, registerHook } = require('./monitoring-hooks');

	registerHook(EVENTS.INBOUND_MESSAGE, ({ chatId, text }) => {
		console.log('[monitor] inbound', chatId, text);
	});
	```
- Hooks never crash the bot: handler errors are caught and logged.
