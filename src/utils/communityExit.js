/**
 * The exit rules for a community, in one place.
 *
 * Leaving is not a preference, it is a settlement: a member walks away only once
 * the community's books are back where they belong. Two conditions, checked in
 * this order, and neither can be waived:
 *
 *   1. no active read  — you finish the book you are reading before you go;
 *   2. nothing on loan — every copy belonging to someone else is back with its
 *                        owner (see `returnBookToOwner`).
 *
 * A book the member *owns* and *holds* is not a blocker: those two roles start
 * out as the same person (see `createBook`), so blocking on them would make the
 * very first book someone contributes a permanent anchor.
 *
 * There is one rule module rather than one check per screen because there is
 * more than one door out — the leave screen, the leave *request* in settings,
 * and the admin approving that request days later — and a member who slips
 * through any of them strands a book and, worse, keeps an active borrowing that
 * then blocks them from joining anywhere else.
 */

import {
  getActiveBorrowingForUser,
  listBooksHeldBy,
  listBooksOwnedBy,
} from "../firebase/firestore.js";
import { holderIdOf, readerHolderIdOf } from "./bookHolder.js";
import { t } from "./i18n.js";

/** Which rule stopped the exit, in the order they are evaluated. */
export const EXIT_BLOCK = {
  READING: "reading",
  HELD: "held",
  /** Not one of the two mandatory rules — see `evaluateExit`. */
  OWNED_AWAY: "ownedAway",
};

const asItems = (result) =>
  Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];

/** True while this book is the user's active read. */
export function isReadingByUser(book, userId) {
  if (!userId) return false;
  return readerHolderIdOf(book) === userId;
}

/**
 * Books physically with the user that belong to somebody else — the ones that
 * must go home before they can leave. Their own copies are excluded: there is
 * nobody to return those to.
 */
export function booksHeldFromOthers(books, userId) {
  if (!userId) return [];
  return asItems(books).filter(
    (b) => holderIdOf(b) === userId && b.ownerId !== userId
  );
}

/** The user's own books that are currently with somebody else. */
export function ownedBooksAwayFromUser(books, userId) {
  if (!userId) return [];
  return asItems(books).filter(
    (b) => b.ownerId === userId && holderIdOf(b) !== userId
  );
}

/**
 * The gate. Evaluates the rules against already-loaded data.
 *
 * `ownedAway` is reported last and separately: it is not one of the two
 * mandatory conditions, but leaving deletes the member's books from the
 * community, so letting them go while a copy is still out would delete it from
 * under whoever is reading it.
 *
 * The two filters below run in JavaScript, and stay there deliberately: they
 * partition a set already scoped by query to this one user (see
 * `loadExitBooks`), so they run over the handful of books someone holds or
 * owns, not over a community's shelf. Splitting them into two more queries
 * would need an inequality on `ownerId`, which cannot be combined with the
 * equality on `holderId` in one index.
 *
 * @param activeBorrowing  the user's active loan, or null
 * @param books            the books this user holds or owns — see `loadExitBooks`
 * @returns {{ canLeave: boolean, blockedBy: string|null, heldFromOthers: Array, ownedAway: Array }}
 */
export function evaluateExit({ activeBorrowing, books, userId }) {
  const heldFromOthers = booksHeldFromOthers(books, userId);
  const ownedAway = ownedBooksAwayFromUser(books, userId);

  // Order matters and is fixed: reading first, then held books.
  let blockedBy = null;
  if (activeBorrowing) blockedBy = EXIT_BLOCK.READING;
  else if (heldFromOthers.length > 0) blockedBy = EXIT_BLOCK.HELD;
  else if (ownedAway.length > 0) blockedBy = EXIT_BLOCK.OWNED_AWAY;

  return { canLeave: blockedBy === null, blockedBy, heldFromOthers, ownedAway };
}

/**
 * Every book this decision could turn on: the ones with the user, and the ones
 * belonging to them. Two indexed queries against a fixed pair of ids, rather
 * than the first two hundred books in the community — which was both far more
 * reading than the answer needed and wrong past the two hundredth book, because
 * a copy outside that slice was a copy the exit rules could not see.
 *
 * The two sets overlap (a book someone owns and holds is in both) and are
 * de-duplicated by id, since `evaluateExit` counts books, not rows.
 */
export async function loadExitBooks({ userId, communityId }) {
  if (!userId || !communityId) return [];
  const [held, owned] = await Promise.all([
    listBooksHeldBy({ communityId, userId }),
    listBooksOwnedBy({ communityId, userId }),
  ]);
  return [...new Map([...held, ...owned].map((b) => [b.id, b])).values()];
}

/**
 * The same verdict, read fresh from the server. Used at the points where the
 * decision is final — sending a leave request, and an admin approving one —
 * because cached lists can be minutes old and the answer has to be true *now*.
 */
export async function checkCommunityExit({ userId, communityId }) {
  const [activeBorrowing, books] = await Promise.all([
    getActiveBorrowingForUser(userId),
    loadExitBooks({ userId, communityId }),
  ]);
  return evaluateExit({ activeBorrowing, books, userId });
}

/** The message shown for a blocked exit. */
export function exitBlockMessage(blockedBy) {
  switch (blockedBy) {
    case EXIT_BLOCK.READING:    return t.exitBlockedReading;
    case EXIT_BLOCK.HELD:       return t.exitBlockedHeld;
    case EXIT_BLOCK.OWNED_AWAY: return t.waitingReturnsBody;
    default:                    return "";
  }
}
