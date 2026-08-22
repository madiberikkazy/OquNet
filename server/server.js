/**
 * The half of phone verification that cannot live in the app.
 *
 * A reader proves a phone number by sharing their Telegram contact card with
 * our bot. The whole point is that *Telegram* tells us which account sent it
 * and what number is on it, and nothing the client says is believed. That means
 * the write has to happen out here: this server holds a Firebase Admin
 * credential, which bypasses the security rules, and the rules refuse `phone`
 * and `phoneVerifiedAt` from every client precisely so that this is the only
 * way a number can become verified. See `phoneChangeAllowed` in firestore.rules
 * and src/firebase/phoneVerify.js for the client's half.
 *
 * It is a plain Express process on purpose: Cloud Functions would put the whole
 * Firebase project on a paid plan for one webhook, and nothing here needs to be
 * inside Firebase. Firestore is reachable with a service-account key anywhere.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * The app writes `phoneVerifications/{TOKEN}`:
 *
 *   { userId, phone: "+7…", channel: "telegram", status: "pending",
 *     expiresAt: <ms> }
 *
 * and shows the reader `t.me/<bot>?start=VERIFY_<TOKEN>`. Telegram delivers
 * that payload as `/start VERIFY_<TOKEN>`, which is how this server learns
 * which attempt a chat is about — a `/start` carries no phone number, so the
 * bot answers it with a keyboard whose one button shares the reader's contact.
 * When the contact arrives, the server:
 *
 *   1. finds the attempt, and refuses a missing, resolved or expired one — a
 *      token is good once;
 *   2. checks the card belongs to the sender. Contact cards can be forwarded,
 *      and anybody's card can be forwarded by anybody;
 *   3. compares the number on the card against the number the attempt claims.
 *      Not equal is not a verification: the attempt is resolved as `mismatch`
 *      and the profile is left exactly as it was. This is the check the whole
 *      design exists for — without it anyone could claim any number and share
 *      their own card;
 *   4. writes `phone` and `phoneVerifiedAt` onto the profile and stamps the
 *      attempt `verified`. The app is listening to that document and finishes
 *      by itself.
 *
 * See README.md for deploying it and pointing Telegram at it.
 */

import express from "express";
import admin from "firebase-admin";
import { mountPushRoutes, watchNotifications, pushReady } from "./push.js";

// ── Configuration ───────────────────────────────────────────────────────────

const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN = "",
  TELEGRAM_WEBHOOK_SECRET = "",
} = process.env;
// The service-account variables are deliberately not destructured here — see
// `loadServiceAccount`.

const COLLECTION = "phoneVerifications";
const TOKEN_RE = /VERIFY_([A-Z0-9]{6,32})/i;

/**
 * The Admin credential, from an environment variable, defensively.
 *
 * A hosted process has nowhere to keep a file, so the whole key travels in one
 * variable — and every way of pasting a multi-line JSON blob into a dashboard
 * text box mangles it differently. Three of those are handled here rather than
 * left to crash the process at boot with a bare `SyntaxError`:
 *
 *   - the JSON as generated, on one line. The ordinary case;
 *   - the same thing base64-encoded, which is what to reach for when a host
 *     strips or re-wraps quotes;
 *   - a `private_key` whose newlines have become the two characters `\` and
 *     `n`, which is what happens when JSON is pasted through a shell or a form
 *     that escapes it a second time. Left alone, this one starts cleanly and
 *     then fails on the first write with an opaque signature error.
 */
function loadServiceAccount() {
  // Read from the environment at call time rather than from the constants
  // captured at import: this is the one function worth exercising directly, and
  // a helper that can only be tested by restarting the process is a helper
  // whose failure modes get tested in production instead.
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = b64
    ? Buffer.from(b64, "base64").toString("utf8")
    : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT is not valid JSON (" + err.message + "). Paste the " +
      "service-account file's contents exactly, on one line — or set " +
      "FIREBASE_SERVICE_ACCOUNT_BASE64 to a base64 copy of it instead."
    );
  }
  if (!parsed?.project_id || !parsed?.private_key || !parsed?.client_email) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT parsed, but is missing project_id, private_key or " +
      "client_email — that is not a service-account key."
    );
  }
  if (parsed.private_key.includes("\\n")) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

function initFirebase() {
  const serviceAccount = loadServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log(`firebase: authenticated as ${serviceAccount.client_email}`);
    return;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp();
    console.log("firebase: using application-default credentials");
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
 * E.164 from whatever Telegram hands us.
 *
 * Contact numbers come back sometimes with a `+` and sometimes without,
 * occasionally with spaces. Both ends of the comparison below go through here,
 * or a verification would fail on formatting alone.
 */
function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** The token inside `/start VERIFY_XXXX`, or null. */
function extractToken(text) {
  const match = TOKEN_RE.exec(String(text || ""));
  return match ? match[1].toUpperCase() : null;
}

/**
 * Resolve one attempt against the number on the shared contact card.
 *
 * A transaction, and not for tidiness: two updates carrying the same token can
 * arrive at once (a Telegram retry, a reader tapping twice), and a token is
 * redeemable exactly once. Reading the status and writing it in the same
 * transaction is what makes the second one a no-op instead of a second
 * verification.
 *
 * @returns "verified" | "mismatch" | "expired" | "unknown" | "already"
 */
async function resolveAttempt(token, fromPhone) {
  const sender = toE164(fromPhone);
  if (!token || !sender) return "unknown";

  const ref = db.collection(COLLECTION).doc(token);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "unknown";

    const attempt = snap.data();
    if (attempt.status !== "pending") return "already";
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
    case "mismatch": return "❌ Контакт басқа нөмірді көрсетті. Қосымшада жазған нөміріңізбен жіберіңіз.";
    case "expired":  return "⌛ Растау мерзімі бітті. Қосымшада қайта бастаңыз.";
    case "already":  return "ℹ️ Бұл сілтеме бұрын қолданылған. Қосымшада қайта бастаңыз.";
    default:         return "🤔 Растау сілтемесі табылмады. Қосымшадағы сілтемені қолданыңыз.";
  }
}

// ── The app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// The Telegram webhook is called by Telegram, server to server, and needs no
// CORS. The push routes are called by the app in a browser, from whatever
// origin it is deployed on — so they do, and only they do.
//
// APP_ORIGIN is a single origin rather than `*` on purpose: these routes take
// a Firebase ID token, and a wildcard invites any page anywhere to relay one.
// Unset means the routes are same-origin only, which is the safe default and
// what a local `npm run dev` against a proxied app wants.
const APP_ORIGIN = process.env.APP_ORIGIN || "";
app.use("/push", (req, res, next) => {
  if (APP_ORIGIN) {
    res.set("Access-Control-Allow-Origin", APP_ORIGIN);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

mountPushRoutes(app, { db, admin });

const telegramReady = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_SECRET);

/**
 * Something for a free host to keep awake, and the first thing to look at when
 * verification "just doesn't work".
 *
 * A free instance sleeps after a quarter of an hour idle and takes most of a
 * minute to wake — which lands squarely on somebody sitting in a chat window
 * waiting to be verified. Point an uptime pinger at this every ten minutes.
 */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    telegram: {
      botToken: Boolean(TELEGRAM_BOT_TOKEN),
      webhookSecret: Boolean(TELEGRAM_WEBHOOK_SECRET),
      ready: telegramReady,
    },
    push: { ready: pushReady },
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────

app.post("/telegram/webhook", async (req, res) => {
  if (!telegramReady) {
    console.error(
      "telegram: dropped an update — " +
      (TELEGRAM_BOT_TOKEN ? "TELEGRAM_WEBHOOK_SECRET" : "TELEGRAM_BOT_TOKEN") + " is not set"
    );
    res.status(503).send("telegram not configured");
    return;
  }

  // Telegram echoes the secret from setWebhook on every request. Without this
  // check, anybody who learns the URL can post "a contact from +7…" and forge a
  // verification outright — so a missing header is not a thing to wave through.
  //
  // It is also the likeliest reason a freshly deployed bot does nothing at all:
  // a setWebhook call without `&secret_token=` produces updates that land here
  // and are refused, silently, forever. Hence the log.
  const presented = req.get("x-telegram-bot-api-secret-token");
  if (presented !== TELEGRAM_WEBHOOK_SECRET) {
    console.warn(
      "telegram: rejected an update with " +
      (presented ? "a wrong secret header" : "no secret header") +
      " — re-run setWebhook with &secret_token=<TELEGRAM_WEBHOOK_SECRET> (see README)"
    );
    res.status(403).send("forbidden: bad or missing secret token");
    return;
  }

  // Telegram delivers a chat message under `message`, and the same thing under
  // `edited_message` when somebody edits it. Anything else is not for us.
  const message = req.body?.message || req.body?.edited_message;
  const chatId = message?.chat?.id;
  if (!chatId) { res.status(200).send("ok"); return; }

  try {
    // `/start VERIFY_XXXX` — the deep link. It names the attempt but carries no
    // number, so the answer is the button that shares one.
    const startToken = extractToken(message.text);
    if (startToken) {
      const ref = db.collection(COLLECTION).doc(startToken);
      const snap = await ref.get();
      if (!snap.exists) {
        await tgSend(chatId, replyText("unknown"));
        res.status(200).send("ok");
        return;
      }
      // Remember which attempt this chat is about: the contact arrives in a
      // separate message that carries no token of its own.
      await ref.set({ telegramChatId: String(chatId) }, { merge: true });
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
      // with the user it describes, and only a card describing the sender
      // proves anything about the sender.
      if (String(contact.user_id || "") !== String(message.from?.id || "")) {
        await tgSend(chatId, "❌ Тек өз контактіңізді жіберіңіз.", { remove_keyboard: true });
        res.status(200).send("ok");
        return;
      }

      const attempt = await findAttemptByChat(chatId);
      if (!attempt) {
        await tgSend(chatId, replyText("unknown"), { remove_keyboard: true });
        res.status(200).send("ok");
        return;
      }

      const outcome = await resolveAttempt(attempt.id, contact.phone_number);
      console.log(`telegram: attempt ${attempt.id} → ${outcome}`);
      await tgSend(chatId, replyText(outcome), { remove_keyboard: true });
      res.status(200).send("ok");
      return;
    }

    await tgSend(chatId, replyText("unknown"));
    res.status(200).send("ok");
  } catch (err) {
    console.error("telegram webhook failed", err);
    // 200 regardless: Telegram retries a failure for hours, and a retry of an
    // update we have already acted on is not something to invite.
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
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.error("telegram sendMessage failed", err);
    return null;
  });
  // A 401 here means the bot token is wrong or revoked, and it is worth saying
  // so loudly: everything else looks like it is working.
  if (res && !res.ok) {
    console.error(`telegram sendMessage rejected: ${res.status} ${await res.text()}`);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`oqunet verification server listening on :${PORT}`);
  if (!TELEGRAM_BOT_TOKEN) console.error("TELEGRAM_BOT_TOKEN is not set — every update will be refused");
  if (!TELEGRAM_WEBHOOK_SECRET) console.error("TELEGRAM_WEBHOOK_SECRET is not set — every update will be refused");

  // Started here rather than at import time so that importing this module —
  // which webhooks.test.mjs does, to drive `app` over HTTP — does not open a
  // Firestore listener the test never closes.
  //
  // The cursor defaults to now, which is what stops a restart from re-pushing
  // every unread notification in the database. See watchNotifications.
  watchNotifications(db, admin);
});

export { app, resolveAttempt, toE164, extractToken, loadServiceAccount };
