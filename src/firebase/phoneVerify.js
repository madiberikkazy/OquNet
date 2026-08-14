/**
 * Proving a phone number, by messaging a bot.
 *
 * The number on a profile is not a detail — it is how a stranger finds the
 * person holding their book, and two screens hand it to somebody about to
 * travel across a city (PickupBook, ReturnBook). So it has to be proven, and
 * the proof has to be something the person typing it cannot fake.
 *
 * ── What changed, and what it cost ───────────────────────────────────────────
 * This used to be Firebase Phone Auth: an SMS, and the proven number arriving
 * in the caller's own ID token, where the security rules could read it. That
 * was worth a lot — the check was on the server and needed no server of ours —
 * but every verification was a paid SMS with a daily ceiling.
 *
 * The replacement inverts where the proof lands. The reader messages our bot on
 * WhatsApp or Telegram; the *bot* learns which number the message came from,
 * because the platform tells it, and nothing the client says is believed. The
 * client's part is reduced to two things it cannot lie its way past:
 *
 *   1. it writes an attempt — "user U claims number P, via channel C" — under a
 *      random token, and
 *   2. it waits.
 *
 * The bot matches the token, compares the number the message actually came from
 * against the claim, and writes the profile with the Admin SDK. The rules refuse
 * `phone` and `phoneVerifiedAt` from any client, so that write is the only way a
 * number can become verified — see `phoneChangeAllowed` in firestore.rules and
 * the verification server in server/server.js.
 *
 * ── What this costs instead ──────────────────────────────────────────────────
 * A server, which SMS did not need. And a fair warning about the trade: a
 * WhatsApp or Telegram number is not always the number somebody answers their
 * door on — it is still *a* number they control, which is the property the
 * handover screens actually rely on.
 */

import {
  cancelPhoneVerification,
  createPhoneVerification,
  getPhoneVerification,
  updateUser,
  watchPhoneVerification,
} from "./firestore.js";
import { isFirebaseConfigured } from "./config.js";
import { getMockSession } from "./auth.js";
import { isE164, toE164 } from "../utils/validators.js";
import { safeGet, safeRemove, safeSet } from "../utils/safeStorage.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/** The two ways to prove a number. */
export const CHANNELS = Object.freeze({ WHATSAPP: "whatsapp", TELEGRAM: "telegram" });

/**
 * How long an attempt is worth waiting on. Long enough to switch apps, find the
 * chat and press send; short enough that an abandoned token does not sit around
 * being redeemable. The bot enforces the same window server-side — this copy is
 * only what the screen counts down against.
 */
export const VERIFY_TTL_MS = 15 * 60 * 1000;

/**
 * Where the bots live. An unset one means that channel is not offered at all,
 * which is the honest behaviour for a deploy that has only configured one.
 *
 * An object rather than two exported constants, for one reason: `import.meta.env`
 * exists under Vite and nowhere else, so a test running in plain Node reads
 * nothing here — and a module whose only configuration arrives at import time
 * is a module that cannot be tested without a bundler. The fields are writable
 * so a test can say which bots exist; nothing in the app writes them.
 */
export const botConfig = {
  whatsappPhone: (import.meta.env?.VITE_WHATSAPP_BOT_PHONE || "").trim(),
  telegramBot: (import.meta.env?.VITE_TELEGRAM_BOT || "").trim(),
};

/** Survives a reload mid-flow: the screen picks the attempt back up by token. */
const PENDING_KEY = "oqunet:phoneVerification";

/** True once this member has a number somebody proved they can be reached on. */
export function hasVerifiedPhone(user) {
  return Boolean(user?.phone) && Boolean(user?.phoneVerifiedAt);
}

/** Whether a channel can be offered — i.e. whether its bot is configured. */
export function channelAvailable(channel) {
  if (channel === CHANNELS.WHATSAPP) return Boolean(botConfig.whatsappPhone);
  if (channel === CHANNELS.TELEGRAM) return Boolean(botConfig.telegramBot);
  return false;
}

/**
 * The token that ties a message to an attempt.
 *
 * Random from the platform's CSPRNG, not from `Math.random`: it travels in a
 * link the reader can be shown by anyone, and it is the only thing that says
 * which attempt an incoming message belongs to. Uppercase and digits only —
 * it has to survive being read aloud, retyped, and pasted into a chat box that
 * may capitalise it.
 */
export function newVerificationToken(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
  const bytes = new Uint8Array(length);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** The exact text the bot expects to receive. One shape, both channels. */
export function verificationPayload(token) {
  return `VERIFY_${token}`;
}

/**
 * The link that opens the right app with the message already written.
 *
 * WhatsApp takes the text as a query parameter, so the reader only has to press
 * send. Telegram's `?start=` payload is delivered to the bot as the argument of
 * `/start`, which is what lets the bot know who it is talking to before asking
 * them for their contact card.
 */
export function verificationLink({ channel, token }) {
  const payload = verificationPayload(token);
  if (channel === CHANNELS.WHATSAPP) {
    if (!botConfig.whatsappPhone) return null;
    const to = botConfig.whatsappPhone.replace(/\D/g, "");
    return `https://wa.me/${to}?text=${encodeURIComponent(payload)}`;
  }
  if (channel === CHANNELS.TELEGRAM) {
    if (!botConfig.telegramBot) return null;
    const bot = botConfig.telegramBot.replace(/^@/, "");
    return `https://t.me/${bot}?start=${encodeURIComponent(payload)}`;
  }
  return null;
}

/** The attempt this device was in the middle of, if any. */
export function readPendingVerification() {
  try {
    const raw = safeGet(PENDING_KEY, null);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePendingVerification(value) {
  if (value) safeSet(PENDING_KEY, JSON.stringify(value));
  else safeRemove(PENDING_KEY);
}

export function forgetPendingVerification() {
  writePendingVerification(null);
}

/** True once an attempt has run out its window. */
export function isVerificationExpired(attempt, now = Date.now()) {
  if (!attempt) return false;
  if (attempt.status !== "pending") return false;
  const expires = Number(attempt.expiresAt) || 0;
  return expires > 0 && now > expires;
}

/**
 * Open an attempt: write it down, remember the token, hand back the link.
 *
 * Nothing about the profile changes here, and nothing can — this is a claim,
 * not a fact. `phone` is stored on the attempt only so the bot has something to
 * compare the sender against; if they differ, the bot resolves the attempt as a
 * mismatch and the profile is left exactly as it was.
 *
 * @returns `{ token, payload, link, attempt }`
 */
export async function startPhoneVerification({ userId, phone, channel } = {}) {
  const e164 = toE164(phone);
  if (!e164 || !isE164(e164)) throw new Error(t.phoneInvalidError);
  if (!userId) throw new Error(t.sessionExpired);
  if (!channelAvailable(channel)) throw new Error(t.phoneChannelUnavailable);

  const token = newVerificationToken();
  const now = Date.now();
  const attempt = {
    userId,
    phone: e164,
    channel,
    status: "pending",
    // Client clocks are not to be trusted for anything that matters, and this
    // one does not: the bot re-checks the window against its own.
    expiresAt: now + VERIFY_TTL_MS,
  };

  await createPhoneVerification(token, attempt);
  writePendingVerification({ token, phone: e164, channel, startedAt: now });

  return {
    token,
    payload: verificationPayload(token),
    link: verificationLink({ channel, token }),
    attempt: { id: token, ...attempt },
  };
}

/**
 * Watch an attempt until the bot resolves it, one way or the other.
 *
 * `onResolved` is handed the finished attempt — verified, mismatched or
 * expired. The screen decides what to say; this only decides when to stop.
 *
 * @returns an unsubscribe function.
 */
export function watchVerification(token, { onUpdate, onResolved } = {}) {
  if (!token) return () => {};
  let stop = () => {};
  stop = watchPhoneVerification(token, (attempt) => {
    if (!attempt) return;
    onUpdate?.(attempt);
    if (attempt.status === "pending" && !isVerificationExpired(attempt)) return;
    // Terminal. Unsubscribing here rather than leaving it to the caller means a
    // resolved attempt cannot fire twice while React is still unmounting.
    stop();
    onResolved?.(attempt);
  });
  return () => stop();
}

/** Give up on an attempt — the one write the client is allowed to make on it. */
export async function abandonVerification(token) {
  if (!token) return;
  try {
    await cancelPhoneVerification(token);
  } catch (err) {
    logger.warn("phoneVerify.abandon", err?.message, { code: err?.code });
  } finally {
    forgetPendingVerification();
  }
}

/**
 * Stand in for the bot, with no Firebase and therefore no bot to stand in for.
 *
 * Mock mode has no rules and no Admin SDK, so this does what the webhook would
 * do — including the comparison, so the development path exercises the same
 * decision the real one makes. It refuses to run against a real database: there
 * the profile write is the server's alone, and a client that could perform it
 * would be the whole hole this design exists to close.
 */
export async function simulateBotConfirmation(token, { fromPhone = null } = {}) {
  if (isFirebaseConfigured) {
    throw new Error("simulateBotConfirmation: refusing to fake a verification against a real project");
  }
  const attempt = await getPhoneVerification(token);
  if (!attempt) throw new Error(t.phoneVerifyExpired);

  const session = getMockSession();
  if (!session?.uid || session.uid !== attempt.userId) throw new Error(t.sessionExpired);

  // The comparison the webhook makes: the number the message came from, not the
  // number the form claimed. They are the same here unless a caller says
  // otherwise, which is how the mismatch path stays testable.
  const sender = toE164(fromPhone || attempt.phone);
  const matched = sender === attempt.phone;
  const resolved = {
    ...attempt,
    status: matched ? "verified" : "mismatch",
    verifiedPhone: sender,
  };

  if (matched) {
    await updateUser(attempt.userId, { phone: attempt.phone, phoneVerifiedAt: Date.now() });
  }
  await createPhoneVerification(token, resolved);
  return resolved;
}
