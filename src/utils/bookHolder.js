/**
 * Who physically has a book right now.
 *
 * Ownership never moves — `ownerId` is whoever added the book and stays put.
 * The *holder* is whoever the copy is with today, and it only changes at a
 * handoff: finishing a read does not send the book back to its owner, it stays
 * with the reader until the next reader comes to collect it. So a user can hold
 * many books at once while reading only one.
 */

/**
 * The person the book is with. `holderId` is written at every handoff and
 * outlives the loan; `borrowerId` is the older field, kept as a fallback for
 * books last handed over before `holderId` existed, and `activeBorrowing` is
 * the last resort for documents that predate both. A book that has never left
 * the shelf is with its owner.
 */
export function holderIdOf(book, activeBorrowing = null) {
  if (!book) return null;
  return (
    book.holderId || readerHolderIdOf(book, activeBorrowing) || book.ownerId || null
  );
}

/**
 * The reader who has the book *on loan* right now, or null when it isn't out.
 * Narrower than the holder: someone who has finished a book still holds it, but
 * is no longer its reader — the book can be requested from them.
 */
export function readerHolderIdOf(book, activeBorrowing = null) {
  if (!book || book.status !== "unavailable") return null;
  return book.holderId || book.borrowerId || activeBorrowing?.borrowerId || null;
}

/** True when `userId` is the person the book is currently with. */
export function isHeldBy(book, userId, activeBorrowing = null) {
  if (!userId) return false;
  return holderIdOf(book, activeBorrowing) === userId;
}
