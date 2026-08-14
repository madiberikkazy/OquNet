# OquNet verification server

Two webhooks, and the only thing in the system allowed to write a verified phone
number. Everything else about the flow is in `src/firebase/phoneVerify.js`; the
short version:

1. the app writes `phoneVerifications/{TOKEN}` — *user U claims number P* — and
   shows the reader a link that puts `VERIFY_<TOKEN>` into a WhatsApp or
   Telegram message;
2. the reader sends it;
3. this server compares the number the message **actually came from** against
   the number the attempt claims, and only then writes `phone` and
   `phoneVerifiedAt` onto the profile with the Admin SDK.

The security rules refuse those two fields from every client, so step 3 is the
only path that exists. If this server is down, nobody can be verified — and
nobody can be verified wrongly either.

## Run it locally

```bash
cd server
npm install
cp .env.example .env   # fill it in
npm run dev
```

`GET /health` reports which channels are configured.

## Deploy to Render (free, no card)

1. Push this repository to GitHub.
2. Render dashboard → **New → Web Service** → pick the repo.
3. Settings:
   - **Root directory**: `server`
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
4. **Environment** → add every variable from `.env.example`. For
   `FIREBASE_SERVICE_ACCOUNT`, paste the service-account JSON as a single line.
5. Deploy, then note the URL — `https://<name>.onrender.com`.

### The free tier sleeps

A free Render service stops after about 15 minutes idle and takes ~50 seconds to
wake. That lands on somebody standing in a chat window waiting to be verified,
so keep it awake: point a free uptime pinger (cron-job.org, UptimeRobot) at

```
https://<name>.onrender.com/health
```

every 10 minutes. Both platforms retry a failed delivery, so a cold start is
recoverable rather than fatal — it is just slow enough to look broken.

## Point the platforms at it

**Telegram** — once, from a terminal:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<name>.onrender.com/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**WhatsApp** — Meta app → WhatsApp → Configuration:

- Callback URL: `https://<name>.onrender.com/whatsapp/webhook`
- Verify token: the `WHATSAPP_VERIFY_TOKEN` you set
- Subscribe to the **messages** field

## The app's side

`.env` of the web app needs the two bots the links point at:

```
VITE_WHATSAPP_BOT_PHONE=+7...      # the business number readers message
VITE_TELEGRAM_BOT=@your_bot
```

Leave one blank and the app simply does not offer that channel.

## What this server deliberately does not do

- **Trust the client.** The claimed number is only ever compared against the
  sender; a mismatch resolves the attempt as `mismatch` and touches nothing.
- **Trust the caller.** Telegram requests must carry the secret header; WhatsApp
  payloads must carry a valid `x-hub-signature-256`. Without those two checks,
  the URL itself would be enough to forge a verification.
- **Trust a forwarded contact.** Telegram contact cards can belong to anybody,
  so the server checks the card's `user_id` against the sender's.
- **Redeem a token twice.** Resolution happens inside a transaction, so a retry
  or a double-send is a no-op rather than a second verification.
