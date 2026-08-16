/**
 * Proving a phone number, by starting our Telegram bot.
 *
 * The number on a profile is not a detail — it is how a stranger finds the
 * person holding their book, and two screens hand it to somebody about to
 * travel across a city (PickupBook, ReturnBook). So it has to be proven, and
 * the proof has to be something the person typing it cannot fake.
 *
 * ── Where the proof lands ────────────────────────────────────────────────────
 * Not here. The reader opens `t.me/<bot>?start=VERIFY_<TOKEN>` and shares their
 * contact card; Telegram tells the *bot* which account sent it and what number
 * is on it, and nothing the client says is believed. The client's part is
 * reduced to two things it cannot lie its way past:
 *
 *   1. it writes an attempt — "user U claims number P" — under a random token,
 *   2. it waits.
 *
 * The bot matches the token, compares the number on the shared contact against
 * the claim, and writes the profile with the Admin SDK. The security rules
 * refuse `phone` and `phoneVerifiedAt` from any client, so that write is the
 * only way a number can become verified — see `phoneChangeAllowed` in
 * firestore.rules and server/server.js.
 *
 * ── Why Telegram alone ───────────────────────────────────────────────────────
 * It was SMS first, which cost money per verification and had a daily ceiling.
 * Then WhatsApp as well, which needs a Meta business review, a signed webhook
 * and a paid message window. Telegram needs a bot token and a free web service,
 * and its contact-sharing button hands over a number the platform itself
 * vouches for. One channel that works beats two that half-do.
 *
 * The trade, stated plainly: a Telegram number is not always the number
 * somebody answers their door on — it is still *a* number they control, which
 * is the property the handover screens actually rely on.
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

/** The only channel. Stored on the attempt so a document says what it is. */
export const CHANNEL = "telegram";

/**
 * How long an attempt is worth waiting on. Long enough to switch apps, find the
 * chat and press the button; short enough that an abandoned token does not sit
 * around being redeemable. The bot enforces the same window server-side — this
 * copy is only what the screen tells the reader.
 */
export const VERIFY_TTL_MS = 15 * 60 * 1000;

/**
 * Which bot to open. Unset means verification cannot be offered at all, which
 * is worth saying out loud on the screen rather than silently disabling a
 * button — on Vercel this variable is baked in at build time, so a deploy that
 * forgot it looks exactly like a broken feature.
 *
 * An object rather than an exported constant, for one reason: `import.meta.env`
 * exists under Vite and nowhere else, so a test running in plain Node reads
 * nothing here. The field is writable so a test can say which bot exists;
 * nothing in the app writes it.
 */
export const botConfig = {
  telegramBot: (import.meta.env?.VITE_TELEGRAM_BOT || "").trim(),
};

/** Survives a reload mid-flow: the screen picks the attempt back up by token. */
const PENDING_KEY = "oqunet:phoneVerification";

/** True once this member has a number somebody proved they can be reached on. */
export function hasVerifiedPhone(user) {
  return Boolean(user?.phone) && Boolean(user?.phoneVerifiedAt);
}

/** Whether verification can be offered — i.e. whether the bot is configured. */
export function verificationAvailable() {
  return Boolean(botConfig.telegramBot);
}

/**
 * The token that ties a message to an attempt.
 *
 * Random from the platform's CSPRNG, not from `Math.random`: it is the only
 * thing that says which attempt an incoming message belongs to. Uppercase and
 * digits only — Telegram's `?start=` payload accepts a narrow alphabet, and the
 * token has to survive being read aloud and retyped.
 */
export function newVerificationToken(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
  const bytes = new Uint8Array(length);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** The exact payload the bot expects to receive. */
export function verificationPayload(token) {
  return `VERIFY_${token}`;
}

/**
 * The link that opens the bot with the payload attached.
 *
 * Telegram delivers `?start=X` to the bot as `/start X`, which is what lets it
 * know which attempt it is talking about before asking for the contact card.
 */
export function verificationLink(token) {
  if (!botConfig.telegramBot || !token) return null;
  const bot = botConfig.telegramBot.replace(/^@/, "").trim();
  return `https://t.me/${bot}?start=${verificationPayload(token)}`;
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
  if (!attempt || attempt.status !== "pending") return false;
  const expires = Number(attempt.expiresAt) || 0;
  return expires > 0 && now > expires;
}

/**
 * Open an attempt: write it down and remember the token.
 *
 * Nothing about the profile changes here, and nothing can — this is a claim,
 * not a fact. `phone` is stored on the attempt only so the bot has something to
 * compare the shared contact against; if they differ, the bot resolves the
 * attempt as a mismatch and the profile is left exactly as it was.
 *
 * The token is taken as an argument rather than minted here, because the screen
 * needs the link *before* the tap: a link built after an await is a link the
 * browser has stopped treating as user-initiated, and mobile Safari blocks it.
 */
export async function startPhoneVerification({ userId, phone, token } = {}) {
  const e164 = toE164(phone);
  if (!e164 || !isE164(e164)) throw new Error(t.phoneInvalidError);
  if (!userId) throw new Error(t.sessionExpired);
  if (!token) throw new Error(t.error);
  if (!verificationAvailable()) throw new Error(t.phoneChannelUnavailable);

  const now = Date.now();
  const attempt = {
    userId,
    phone: e164,
    channel: CHANNEL,
    status: "pending",
    // Client clocks are not to be trusted for anything that matters, and this
    // one does not: the bot re-checks the window against its own.
    expiresAt: now + VERIFY_TTL_MS,
  };

  await createPhoneVerification(token, attempt);
  writePendingVerification({ token, phone: e164, startedAt: now });

  return { token, payload: verificationPayload(token), link: verificationLink(token),
    attempt: { id: token, ...attempt } };
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
 * — including the comparison, so the development path exercises the same
 * decision the real one makes. It refuses to run against a real project: there
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

  // The comparison the webhook makes: the number the contact card carries, not
  // the number the form claimed. Equal unless a caller says otherwise, which is
  // how the mismatch path stays testable.
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
