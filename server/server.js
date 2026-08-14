/**
 * The half of phone verification that cannot live in the app.
 *
 * A reader proves a phone number by messaging our bot from it. The whole point
 * is that the *platform* — WhatsApp or Telegram — tells us which number the
 * message came from, and nothing the client says is believed. That means the
 * write has to happen out here: this server holds a Firebase Admin credential,
 * which bypasses the security rules, and the rules refuse `phone` and
 * `phoneVerifiedAt` from every client precisely so that this is the only way a
 * number can become verified. See `phoneChangeAllowed` in firestore.rules and
 * src/firebase/phoneVerify.js for the client's half.
 *
 * It is a plain Express process on purpose: Cloud Functions would put the whole
 * project on a paid plan for two webhooks, and nothing here needs to be inside
 * Firebase. Firestore is reachable with a service-account key from anywhere.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * The app writes `phoneVerifications/{TOKEN}`:
 *
 *   { userId, phone: "+7…", channel: "whatsapp" | "telegram",
 *     status: "pending", expiresAt: <ms> }
 *
 * and shows the reader a link that puts `VERIFY_<TOKEN>` into a message. When
 * that message arrives, this server:
 *
 *   1. finds the attempt by token, and refuses a missing, resolved or expired
 *      one — a token is good once;
 *   2. compares the number the message came from against the number the attempt
 *      claims. Not equal is not a verification: the attempt is resolved as
 *      `mismatch` and the profile is left exactly as it was. This is the check
 *      the whole design exists for — without it anyone could claim any number
 *      and message us from their own;
 *   3. writes `phone` and `phoneVerifiedAt` onto the profile, and stamps the
 *      attempt `verified`. The app is listening to that document and finishes
 *      by itself.
 *
 * See README.md in this folder for deploying it and pointing the two platforms
 * at it.
 */

import crypto from "node:crypto";
import express from "express";
import admin from "firebase-admin";

// ── Configuration ───────────────────────────────────────────────────────────

const {
  PORT = 8080,
  FIREBASE_SERVICE_ACCOUNT,
  TELEGRAM_BOT_TOKEN = "",
  TELEGRAM_WEBHOOK_SECRET = "",
  WHATSAPP_VERIFY_TOKEN = "",
  WHATSAPP_APP_SECRET = "",
  WHATSAPP_TOKEN = "",
} = process.env;

const COLLECTION = "phoneVerifications";
const TOKEN_RE = /VERIFY_([A-Z0-9]{6,32})/i;

/**
 * The Admin credential.
 *
 * A hosted process has nowhere to keep a file, so the whole key travels in one
 * environment variable — the JSON exactly as Firebase generated it. Failing
 * loudly at boot is deliberate: a server that starts without a credential is a
 * server that answers every webhook with a silent failure, and the reader on
 * the other end just sees "waiting" forever.
 */
function initFirebase() {
  if (FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
    });
    return;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return;
  }
  throw new Error(
    "No Firebase credential. Set FIREBASE_SERVICE_ACCOUNT to the contents of your " +
      "service-account JSON (Firebase Console → Project settings → Service accounts)."
  );
}

initFirebase();
const db = admin.firestore();

// ── Shared logic ────────────────────────────────────────────────────────────

/**
 * E.164 from whatever a platform hands us.
 *
 * WhatsApp reports a `wa_id` — digits, no plus. Telegram's contact numbers
 * sometimes carry one and sometimes do not. Both become the same string the app
 * stores, or the comparison below would fail on formatting alone.
 */
function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** The token inside a message body, or null. */
function extractToken(text) {
  const match = TOKEN_RE.exec(String(text || ""));
  return match ? match[1].toUpperCase() : null;
}

/**
 * Resolve one attempt against the number a message actually came from.
 *
 * A transaction, and not for tidiness: two messages carrying the same token can
 * arrive at once (a retry from the platform, a reader pressing send twice), and
 * a token is redeemable exactly once. Reading the status and writing it in the
 * same transaction is what makes the second one a no-op instead of a second
 * verification.
 *
 * @returns "verified" | "mismatch" | "expired" | "unknown" | "already"
 */
async function resolveAttempt(token, fromPhone, channel) {
  const sender = toE164(fromPhone);
  if (!token || !sender) return "unknown";

  const ref = db.collection(COLLECTION).doc(token);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "unknown";

    const attempt = snap.data();
    if (attempt.status !== "pending") return "already";
    if (attempt.channel !== channel) return "unknown";
    if (Number(attempt.expiresAt) && Date.now() > Number(attempt.expiresAt)) {
      tx.update(ref, { status: "expired", resolvedAt: Date.now() });
      return "expired";
    }

    // The comparison the whole design turns on.
    if (toE164(attempt.phone) !== sender) {
      tx.update(ref, { status: "mismatch", verifiedPhone: sender, resolvedAt: Date.now() });
      return "mismatch";
    }

    // Two writes, one atom: the profile the app reads and the attempt the app
    // is watching. A verified attempt whose profile write failed would tell the
    // reader they were done while leaving them unable to join anything.
    tx.update(db.collection("users").doc(attempt.userId), {
      phone: sender,
      phoneVerifiedAt: Date.now(),
    });
    tx.update(ref, { status: "verified", verifiedPhone: sender, resolvedAt: Date.now() });
    return "verified";
  });
}

/** What to say back, in the reader's own chat. */
function replyText(outcome) {
  switch (outcome) {
    case "verified": return "✅ Нөміріңіз расталды. OquNet-ке оралыңыз.";
    case "mismatch": return "❌ Хабарлама басқа нөмірден келді. Қосымшада көрсеткен нөмірден жіберіңіз.";
    case "expired":  return "⌛ Растау мерзімі бітті. Қосымшада қайта бастаңыз.";
    case "already":  return "ℹ️ Бұл сілтеме бұрын қолданылған. Қосымшада қайта бастаңыз.";
    default:         return "🤔 Растау коды табылмады. Қосымшадағы сілтемені қолданыңыз.";
  }
}

// ── The app ─────────────────────────────────────────────────────────────────

const app = express();

// The raw bytes are kept alongside the parsed body because WhatsApp signs the
// bytes: re-serialising the parsed object gives a different string and every
// signature check would fail.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

/**
 * Something for a free host to keep awake.
 *
 * A free instance sleeps after a quarter of an hour idle and takes most of a
 * minute to wake — which lands squarely on somebody standing in a chat window
 * waiting to be verified. Point an uptime pinger at this every ten minutes and
 * the problem goes away. See README.md.
 */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    channels: {
      telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_SECRET),
      whatsapp: Boolean(WHATSAPP_VERIFY_TOKEN && WHATSAPP_APP_SECRET),
    },
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────
//
// Two messages matter. `/start VERIFY_TOKEN` opens the conversation and tells
// us which attempt it is about — but it does *not* carry a phone number, so it
// is answered with a keyboard whose one button shares the reader's contact.
// The contact message is the one that proves anything.

app.post("/telegram/webhook", async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    res.status(503).send("telegram not configured");
    return;
  }
  if (req.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
    console.warn("telegram: rejected a request with a bad secret header");
    res.status(403).send("forbidden");
    return;
  }

  const message = req.body?.message;
  const chatId = message?.chat?.id;
  if (!chatId) { res.status(200).send("ok"); return; }

  try {
    const startToken = extractToken(message.text);
    if (startToken) {
      // Remember which attempt this chat is about: the contact arrives in a
      // separate message that carries no token of its own.
      await db.collection(COLLECTION).doc(startToken)
        .set({ telegramChatId: String(chatId) }, { merge: true });
      await tgSend(chatId, "Нөміріңізді растау үшін төмендегі түймені басыңыз 👇", {
        keyboard: [[{ text: "📱 Контакт жіберу", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      });
      res.status(200).send("ok");
      return;
    }

    const contact = message.contact;
    if (contact) {
      // A contact card can be forwarded — anyone's. Telegram stamps the card
      // with the user it belongs to, and only a card belonging to the sender
      // proves anything about the sender.
      if (String(contact.user_id) !== String(message.from?.id)) {
        await tgSend(chatId, "❌ Тек өз контактіңізді жіберіңіз.");
        res.status(200).send("ok");
        return;
      }

      const attempt = await findAttemptByChat(chatId);
      if (!attempt) {
        await tgSend(chatId, replyText("unknown"));
        res.status(200).send("ok");
        return;
      }

      const outcome = await resolveAttempt(attempt.id, contact.phone_number, "telegram");
      await tgSend(chatId, replyText(outcome), { remove_keyboard: true });
      res.status(200).send("ok");
      return;
    }

    await tgSend(chatId, replyText("unknown"));
    res.status(200).send("ok");
  } catch (err) {
    console.error("telegram webhook failed", err);
    // 200 regardless: Telegram retries a failure for hours, and a retry of a
    // message we have already acted on is not something to invite.
    res.status(200).send("ok");
  }
});

/** The pending attempt this chat opened, if it is still open. */
async function findAttemptByChat(chatId) {
  const snap = await db.collection(COLLECTION)
    .where("telegramChatId", "==", String(chatId))
    .where("status", "==", "pending")
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function tgSend(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("telegram sendMessage failed", err));
}

// ── WhatsApp (Cloud API) ────────────────────────────────────────────────────
//
// Simpler, because the message itself carries both halves: the token in the
// text the deep link pre-filled, and the sender's number in `from`.

/** Meta's one-time handshake when the callback URL is saved. */
app.get("/whatsapp/webhook", (req, res) => {
  const ok = WHATSAPP_VERIFY_TOKEN
    && req.query["hub.verify_token"] === WHATSAPP_VERIFY_TOKEN;
  res.status(ok ? 200 : 403).send(ok ? String(req.query["hub.challenge"] || "") : "forbidden");
});

app.post("/whatsapp/webhook", async (req, res) => {
  if (!WHATSAPP_APP_SECRET) {
    res.status(503).send("whatsapp not configured");
    return;
  }
  if (!validWhatsAppSignature(req)) {
    console.warn("whatsapp: rejected an unsigned payload");
    res.status(403).send("forbidden");
    return;
  }

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) { res.status(200).send("ok"); return; }

    const token = extractToken(message.text?.body);
    const outcome = token
      ? await resolveAttempt(token, message.from, "whatsapp")
      : "unknown";

    await waSend(value?.metadata?.phone_number_id, message.from, replyText(outcome));
    res.status(200).send("ok");
  } catch (err) {
    console.error("whatsapp webhook failed", err);
    res.status(200).send("ok");
  }
});

/**
 * Meta signs every payload with the app secret. Checking it is what stops
 * anyone who learns the URL from posting "a message from +7…" of their own —
 * which would be the entire verification, forged.
 */
function validWhatsAppSignature(req) {
  const header = req.get("x-hub-signature-256") || "";
  const raw = req.rawBody;                       // the bytes, before parsing
  if (!header.startsWith("sha256=") || !raw) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(raw)
    .digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function waSend(phoneNumberId, to, text) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) return;   // replying is optional
  await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "text", text: { body: text },
    }),
  }).catch((err) => console.error("whatsapp send failed", err));
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`oqunet verification server listening on :${PORT}`);
  if (!TELEGRAM_BOT_TOKEN) console.warn("TELEGRAM_BOT_TOKEN unset — Telegram is off");
  if (!WHATSAPP_APP_SECRET) console.warn("WHATSAPP_APP_SECRET unset — WhatsApp is off");
});

export { app, resolveAttempt, toE164, extractToken };
