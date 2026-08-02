/**
 * Who physically has a book right now.
 *
 * Ownership never moves — `ownerId` is whoever added the book and stays put.
 * The *holder* is whoever the copy is with today: the owner while the book sits
 * on their shelf, the reader once it has been handed over.
 */

/**
 * The reader a book was handed to, or null when it is not out on loan.
 *
 * The book document carries the answer (`holderId`, written at every handoff),
 * so screens can name the holder without waiting on a borrowings fetch.
 * `borrowerId` is the older field, kept as a fallback for books last handed
 * over before `holderId` existed; `activeBorrowing` is the last resort for
 * documents that predate both.
 */
export function readerHolderIdOf(book, activeBorrowing = null) {
  if (!book || book.status !== "unavailable") return null;
  return book.holderId || book.borrowerId || activeBorrowing?.borrowerId || null;
}

/** The person the book is with: its reader while on loan, otherwise its owner. */
export function holderIdOf(book, activeBorrowing = null) {
  return readerHolderIdOf(book, activeBorrowing) || book?.ownerId || null;
}

/** True when `userId` is the person the book is currently with. */
export function isHeldBy(book, userId, activeBorrowing = null) {
  if (!userId) return false;
  return holderIdOf(book, activeBorrowing) === userId;
}
