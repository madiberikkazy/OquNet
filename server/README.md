# OquNet verification server

One webhook, and the only thing in the system allowed to write a verified phone
number. The app's half is `src/firebase/phoneVerify.js`; the short version:

1. the app writes `phoneVerifications/{TOKEN}` — *user U claims number P* — and
   shows the reader `t.me/<bot>?start=VERIFY_<TOKEN>`;
2. the reader opens the bot, which asks for their contact card;
3. this server checks the card belongs to the sender, compares the number on it
   against the number the attempt claims, and only then writes `phone` and
   `phoneVerifiedAt` onto the profile with the Admin SDK.

The security rules refuse those two fields from every client, so step 3 is the
only path that exists. If this server is down nobody can be verified — and
nobody can be verified wrongly either.

## Run it locally

```bash
cd server
npm install
cp .env.example .env   # fill it in
npm run dev
```

`GET /health` reports whether the bot token and the webhook secret are both set.

Tests, against the Firestore emulator — the real Express app, driven over HTTP:

```bash
npm run test:emulator
```

## Deploy to Render (free, no card)

1. Push this repository to GitHub.
2. Render → **New → Web Service** → pick the repo.
3. Settings:
   - **Root directory**: `server`
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
4. **Environment** → add every variable from `.env.example`. For
   `FIREBASE_SERVICE_ACCOUNT`, paste the service-account JSON as a single line.
5. Deploy, then check `https://<name>.onrender.com/health` — it should report
   `"ready": true`. If it reports false, one of the two Telegram variables is
   missing and every update will be refused.

### Point Telegram at it

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
  PUBLIC_URL=https://<name>.onrender.com npm run set-webhook
```

**Do not call `setWebhook` by hand without `secret_token`.** Telegram answers
`{"ok":true}` either way, but updates then arrive without the secret header,
this server refuses them, and the bot goes quiet with no error anywhere except
its own log. That is what `npm run set-webhook` exists to prevent; it also
prints `getWebhookInfo`, including Telegram's last delivery error.

### The free tier sleeps

A free Render service stops after ~15 minutes idle and takes ~50 seconds to
wake — landing on somebody sitting in a chat waiting to be verified. Point a
free uptime pinger (cron-job.org, UptimeRobot) at

```
https://<name>.onrender.com/health
```

every 10 minutes. Telegram retries a failed delivery, so a cold start is
recoverable, just slow enough to look broken.

## The app's side

The web app needs to know which bot the link opens:

```
VITE_TELEGRAM_BOT=@oqunet_verify_bot
```

Vite bakes that in **at build time**, so on Vercel you set it in the project's
environment variables and then redeploy. Leave it unset and the verify screen
says verification is unavailable instead of offering a dead button.

## What this server deliberately does not do

- **Trust the client.** The claimed number is only ever compared against the
  contact card; a mismatch resolves the attempt as `mismatch` and touches
  nothing.
- **Trust the caller.** Updates must carry `x-telegram-bot-api-secret-token`.
  Without that check, the URL alone would be enough to forge a verification.
- **Trust a forwarded card.** Contact cards can belong to anybody, so the card's
  `user_id` is checked against the sender's.
- **Redeem a token twice.** Resolution happens in a transaction, so a retry or a
  double tap is a no-op rather than a second verification.

## If verification is not working

In order, because each rules out the one below:

1. `GET /health` → `telegram.ready` false? Set the missing variable.
2. `getWebhookInfo` (printed by `npm run set-webhook`) → `last_error_message`
   tells you what Telegram thinks. A 403 here means the secret is not matching:
   re-run `set-webhook`.
3. Render logs → `rejected an update with no secret header` means exactly that.
4. Render logs → nothing at all when you press the button? Telegram is not
   reaching you; check the URL in `getWebhookInfo`.
5. The app's console → the attempt document has to exist before the bot can find
   it. `VITE_TELEGRAM_BOT` unset means the link never had a token to carry.
