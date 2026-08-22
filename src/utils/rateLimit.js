// Client-side rate limiting for the actions that create documents.
//
// ── What this is, and what it is not ────────────────────────────────────────
//
// It is not security. Anything enforced in the app can be bypassed by anybody
// willing to open a console, so this cannot be the only thing standing between
// a determined spammer and the `posts` collection — that job belongs to the
// security rules and, above them, to moderation.
//
// What it *is* is the thing that stops ordinary accidents from becoming data:
// a double-tapped send button, a comment field submitted three times because
// the first two looked like they did nothing on a slow connection, a like
// hammered twenty times, a script somebody wrote to "test" the app. Those are
// the overwhelming majority of duplicate writes in practice, they all come
// from the app itself, and the app is where they are cheapest to stop — before
// the request, rather than after Firestore has been billed for it.
//
// ── The window ──────────────────────────────────────────────────────────────
//
// A sliding window per action: the timestamps of the last N attempts, and an
// attempt is refused while N of them fall inside the period. Sliding rather
// than fixed buckets because a fixed bucket allows a burst of 2N across a
// boundary, which is exactly the shape of the double-tap it is meant to catch.
//
// State is persisted, because the interesting cases survive a reload. A limit
// held only in memory is one refresh away from being no limit at all, and a
// reload is precisely what somebody does when a button appears not to work.
//
// Note the asymmetry with the server: these windows are deliberately looser
// than what a human can actually do. The aim is to catch runaway repetition,
// not to make a fast typist wait.

import { safeGetJSON, safeSetJSON } from "./safeStorage.js";
import { logger } from "./logger.js";

const STORE_KEY = "oqunet:ratelimit";

/**
 * The limits, by action.
 *
 * `max` attempts per `windowMs`. `minGapMs` is the separate, shorter guard
 * against a double-tap: two sends 200 ms apart are one send, whatever the
 * window allows over a minute.
 */
export const LIMITS = {
  // Writing a post is a deliberate act on a screen of its own. Five in two
  // minutes is far more than anybody composes and far less than a loop does.
  "post.create":    { max: 5,  windowMs: 120_000, minGapMs: 3_000 },
  // Comments are conversational, so the window is wider — but a thread is
  // also the easiest place to flood.
  "comment.create": { max: 12, windowMs: 60_000,  minGapMs: 1_500 },
  // Chat is the most conversational thing here; the limit only has to be
  // below what a script does.
  "chat.send":      { max: 30, windowMs: 60_000,  minGapMs: 300   },
  // A like is one tap and it toggles, so the real risk is a stuck finger
  // writing the same document forty times.
  "post.like":      { max: 40, windowMs: 60_000,  minGapMs: 400   },
  // Handing a book over is a two-person handshake with a code. Repeating the
  // request does not make it arrive faster, and each one is a document.
  "pickup.request": { max: 6,  windowMs: 300_000, minGapMs: 4_000 },
  "return.request": { max: 6,  windowMs: 300_000, minGapMs: 4_000 },
  // Rating writes recompute the book's aggregate, so a rapid re-rate is
  // several writes rather than one.
  "rating.submit":  { max: 10, windowMs: 120_000, minGapMs: 2_000 },
  // The SMS/Telegram verification round trip costs real money per attempt.
  "phone.verify":   { max: 5,  windowMs: 600_000, minGapMs: 10_000 },
};

// action → array of attempt timestamps, newest last. Loaded once and written
// back after each accepted attempt; the whole thing is a few dozen numbers.
function loadStore() {
  const raw = safeGetJSON(STORE_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

let store = loadStore();

function saveStore() {
  safeSetJSON(STORE_KEY, store);
}

/**
 * Would this attempt be allowed right now? Does not consume it.
 *
 * Returns `{ allowed, retryAfterMs, reason }`. `retryAfterMs` is how long
 * until the attempt would succeed, which is what a caller shows the reader —
 * "wait 3 seconds" is an answer, "too many requests" is not.
 */
export function check(action) {
  const limit = LIMITS[action];
  // An unknown action is allowed. Adding a call site should never be able to
  // silently block a feature because somebody forgot to add a limit for it.
  if (!limit) return { allowed: true, retryAfterMs: 0, reason: null };

  const now = Date.now();
  // Drop everything older than the window on read, which is also how the
  // store stays small without a sweeper: an action nobody has taken for a
  // minute holds no timestamps.
  const recent = (store[action] || []).filter((ts) => now - ts < limit.windowMs);

  const last = recent[recent.length - 1];
  if (last !== undefined && now - last < limit.minGapMs) {
    return {
      allowed: false,
      retryAfterMs: limit.minGapMs - (now - last),
      reason: "too-fast",
    };
  }

  if (recent.length >= limit.max) {
    // The window frees up when the oldest attempt in it ages out.
    return {
      allowed: false,
      retryAfterMs: limit.windowMs - (now - recent[0]),
      reason: "too-many",
    };
  }

  return { allowed: true, retryAfterMs: 0, reason: null };
}

/**
 * Consume one attempt if the limit allows it.
 *
 * The one call sites should use: checking and recording separately invites the
 * bug where a caller checks, awaits something, and records after the window
 * has already let a second attempt through.
 */
export function attempt(action) {
  const verdict = check(action);
  if (!verdict.allowed) {
    logger.warn("rateLimit", `blocked ${action}`, {
      reason: verdict.reason,
      retryAfterMs: verdict.retryAfterMs,
    });
    return verdict;
  }

  const limit = LIMITS[action];
  if (limit) {
    const now = Date.now();
    const recent = (store[action] || []).filter((ts) => now - ts < limit.windowMs);
    recent.push(now);
    store[action] = recent;
    saveStore();
  }
  return verdict;
}

/**
 * Give an attempt back.
 *
 * For the case where the write was refused before it happened — a validation
 * error, a permission denial. The reader did not actually do the thing, so it
 * should not count against them.
 */
export function release(action) {
  const recent = store[action];
  if (!recent || recent.length === 0) return;
  recent.pop();
  saveStore();
}

/** Whole-number seconds, for a message. Always at least 1. */
export function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** Testing and account deletion — forget every window. */
export function resetLimits() {
  store = {};
  saveStore();
}
