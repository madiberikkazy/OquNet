/**
 * Who physically has a book right now.
 *
 * Ownership never moves — `ownerId` is whoever the book belongs to and stays
 * put. The *holder* is whoever the copy is with today, and it only changes at a
 * handoff: finishing a read does not send the book back to its owner, it stays
 * with the reader until the next reader comes to collect it. So a user can hold
 * many books at once while reading only one.
 *
 * `holderId` is on every book, always. The schema derives it at creation (a new
 * book is with its owner) and the security rules refuse a create without it and
 * refuse a handoff that does not write it. There is nothing left to infer, so
 * these are field reads rather than a search.
 */

/** The person the book is with. */
export function holderIdOf(book) {
  return book?.holderId ?? null;
}

/**
 * The reader who has the book *on loan* right now, or null when it isn't out.
 * Narrower than the holder: someone who has finished a book still holds it, but
 * is no longer its reader — the book can be requested from them.
 */
export function readerHolderIdOf(book) {
  return book?.status === "unavailable" ? holderIdOf(book) : null;
}

/** True when `userId` is the person the book is currently with. */
export function isHeldBy(book, userId) {
  if (!userId) return false;
  return holderIdOf(book) === userId;
}
