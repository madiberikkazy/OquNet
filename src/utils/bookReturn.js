/**
 * Getting an owner's copy back — the errand that stands between a member and
 * the way out of a community.
 *
 * `communityExit.js` says *whether* someone may leave. This module says how the
 * one blocker they can actually act on gets cleared: every book they own that
 * is with somebody else has to come home first, and each one comes home through
 * the same two-step handshake a pickup uses, run in the opposite direction.
 *
 *   step 1  the owner sees who has the copy and how to reach them, and sends a
 *           four-digit code to that person. Opening the request also takes the
 *           book off the shelf, so nobody starts collecting it in the meantime;
 *   step 2  they meet, the holder reads the code out, the owner types it in.
 *           That is what moves the book — not the request, and not the promise.
 *
 * Nothing here writes: the states below are derived from a book and its open
 * request, so the leave screen, the code screen and the exit gate all read the
 * same verdict from the same two documents rather than each deciding for
 * themselves what "waiting" means.
 *
 * ── Why a code at all ────────────────────────────────────────────────────────
 * The owner could simply be trusted to press a button. They are not, for the
 * same reason a pickup is not: the button is a claim about the physical world
 * ("I have the book in my hands"), and the code is the only part of it the
 * other person has to agree with. It is a handshake, not a secret — see the
 * note at the top of firestore.rules.
 */

import { holderIdOf } from "./bookHolder.js";
import { toMillis } from "./time.js";
import { t } from "./i18n.js";

/**
 * How long an unanswered return stays open. The same three days a pickup gets,
 * and for the same reason: it holds a book out of circulation, so it cannot be
 * allowed to hold it forever. After that the request lapses, the book goes back
 * on the shelf and the owner may start again.
 */
export const RETURN_EXPIRY_DAYS = 3;
export const RETURN_EXPIRY_MS = RETURN_EXPIRY_DAYS * 86400000;

/** Where one of the owner's books is in the process of coming back. */
export const RETURN_STATE = Object.freeze({
  /** Already with its owner. Nothing to do, and no request to open. */
  HOME: "home",
  /** Out, and nobody has asked for it back yet. The "send code" state. */
  IDLE: "idle",
  /** A code is out with the holder, waiting to be exchanged for the book. */
  PENDING: "pending",
  /** Nothing happened for three days; the request is spent and clears itself. */
  EXPIRED: "expired",
  /**
   * A request whose holder is no longer the person holding the book. The copy
   * moved on between the request opening and now, so the code that was sent is
   * a code the current holder never received.
   */
  STALE: "stale",
});

/**
 * True once a pending request has run out its three days.
 *
 * A request whose `createdAt` has not resolved yet is brand new, not ancient:
 * `serverTimestamp()` reads back as null on the client until the write lands,
 * and treating that as "long ago" would expire every request the instant it
 * was opened.
 */
export function isReturnExpired(request, now = Date.now()) {
  if (!request || request.status !== "pending") return false;
  const created = toMillis(request.createdAt, null);
  if (created == null) return false;
  return now - created > RETURN_EXPIRY_MS;
}

/** Milliseconds left before a pending request lapses, or null when it has. */
export function returnExpiresIn(request, now = Date.now()) {
  const created = toMillis(request?.createdAt, null);
  if (created == null) return RETURN_EXPIRY_MS;
  const left = created + RETURN_EXPIRY_MS - now;
  return left > 0 ? left : null;
}

/**
 * A book is on loan when somebody is actually reading it — which is narrower
 * than "unavailable", because a book reserved for its owner to collect is
 * unavailable too. `borrowerId` is the field that tells the two apart, and it
 * is what the reservation deliberately leaves alone.
 */
export function isOnLoan(book) {
  return book?.status === "unavailable" && !!book?.borrowerId;
}

/**
 * The other half of the same distinction: off the shelf, with nobody reading
 * it. That pair of values is only ever written by `reserveBookForReturn`, so it
 * is enough to badge a copy as going home without reading the request behind
 * it — which the holder, who is the person that badge is for, cannot do anyway.
 *
 * `borrowerId === null` and not merely falsy: books written before the field
 * existed have no key at all, and those are ordinary loans.
 */
export function isReservedForReturn(book) {
  return book?.status === "unavailable" && book?.borrowerId === null;
}

/**
 * Everything a screen needs to know about one of the owner's books, from the
 * book and its open request (null when there is none).
 *
 * `holderId` is read off the book rather than off the request: the request
 * records who had it when the code was sent, the book knows who has it now, and
 * the gap between the two is exactly what `STALE` means.
 */
export function returnStateFor({ book, request = null, userId = null } = {}) {
  const holderId = holderIdOf(book);
  const ownerId = book?.ownerId ?? null;
  const owner = userId ? ownerId === userId : true;

  if (!book || !holderId || holderId === ownerId) {
    return { state: RETURN_STATE.HOME, holderId: ownerId, request: null, onLoan: false, owner };
  }

  const onLoan = isOnLoan(book);
  const base = { holderId, request, onLoan, owner };

  if (!request || request.status !== "pending") {
    return { ...base, state: RETURN_STATE.IDLE, request: null };
  }
  if (isReturnExpired(request)) return { ...base, state: RETURN_STATE.EXPIRED };
  if (request.holderId && request.holderId !== holderId) {
    return { ...base, state: RETURN_STATE.STALE };
  }
  return { ...base, state: RETURN_STATE.PENDING };
}

/**
 * The two states that are really "no live request" once the stale one has been
 * cleared away. Both need the same tidy-up write before a new code can be sent,
 * which is why they are named together rather than checked apart.
 */
export function needsSweep(state) {
  return state === RETURN_STATE.EXPIRED || state === RETURN_STATE.STALE;
}

/** The line under a book's row on the leave screen. */
export function returnStateMessage(state, { onLoan = false } = {}) {
  switch (state) {
    case RETURN_STATE.HOME:    return t.bookWithYou;
    case RETURN_STATE.PENDING: return onLoan ? t.returnPendingOnLoan : t.returnPendingHint;
    case RETURN_STATE.EXPIRED: return t.returnExpiredNote;
    case RETURN_STATE.STALE:   return t.returnStaleNote;
    default:                   return onLoan ? t.returnOnLoanHint : t.bookOutOnLoan;
  }
}
