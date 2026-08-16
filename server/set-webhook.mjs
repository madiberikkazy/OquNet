/**
 * Point Telegram at this server — with the secret header, which is the part
 * that is easy to leave out and impossible to notice afterwards.
 *
 * A `setWebhook` call without `secret_token` produces updates that arrive
 * without `x-telegram-bot-api-secret-token`, which the server refuses. Telegram
 * reports `{"ok":true}` either way, the bot answers nothing, and there is no
 * error anywhere except in this server's log. So this exists rather than a line
 * in the README that says "don't forget the secret".
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… PUBLIC_URL=https://…onrender.com \
 *     node set-webhook.mjs
 *
 * Run it again after changing either value; it is idempotent.
 */

const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL } = process.env;

const missing = Object.entries({ TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}`);
  console.error("Example: PUBLIC_URL=https://oqunet.onrender.com node set-webhook.mjs");
  process.exit(1);
}

const url = `${PUBLIC_URL.replace(/\/+$/, "")}/telegram/webhook`;

const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    // Everything else Telegram could send is noise this server ignores.
    allowed_updates: ["message"],
    // A webhook pointed somewhere else may have queued updates behind it.
    drop_pending_updates: true,
  }),
});

const body = await res.json();
console.log(JSON.stringify(body, null, 2));

if (!body.ok) process.exit(1);

// What Telegram thinks the arrangement is, which is the honest confirmation —
// `ok: true` above only means the call was accepted.
const info = await (await fetch(
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
)).json();

console.log("\ngetWebhookInfo:");
console.log(JSON.stringify(info.result, null, 2));
if (info.result?.last_error_message) {
  console.error(`\n⚠ Telegram's last delivery failed: ${info.result.last_error_message}`);
}
