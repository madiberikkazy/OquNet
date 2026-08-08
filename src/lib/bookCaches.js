import { queryClient } from "./queryClient.js";
import { qk } from "./queryKeys.js";

/**
 * Drop every cache that names a book's holder, after the book changes hands.
 *
 * `refetchType: "all"` is the important part. At the moment of a handoff the
 * affected screens are all unmounted — the user is on the pickup screen, not on
 * the book page or their profile — so their queries are inactive, and a plain
 * invalidate would only mark them stale. Queries default to
 * `refetchOnMount: false` and the cache is persisted to IndexedDB, so a stale
 * holder or count would then survive remounts *and* app restarts, until the tab
 * happened to regain focus. Forcing the refetch here is what makes the new
 * holder stick.
 */
/**
 * Drop every cached answer about pickup requests.
 *
 * Called whenever a request is opened, cancelled or fulfilled — not only when
 * one is fulfilled, which is what it used to be. The book page caches "has this
 * reader already asked for this book?" under the app-wide 60-second staleTime
 * with `refetchOnMount: false`, and the cache is persisted to IndexedDB, so
 * without this, returning to the book straight after asking for it showed the
 * "request it" button again rather than "continue" — for a full minute, and
 * across app restarts. That button is how a reader ends up asking twice.
 *
 * The whole `pickupRequest` prefix goes, rather than one book's entry: opening a
 * request also changes the answer to "does this reader have one open anywhere?",
 * which is the gate on every *other* book's page.
 */
export function invalidatePickupRequest() {
  queryClient.invalidateQueries({ queryKey: ["pickupRequest"], refetchType: "all" });
}

export function invalidateHolderCaches(bookId) {
  const refetchType = "all";
  queryClient.invalidateQueries({ queryKey: qk.books.all, refetchType });
  queryClient.invalidateQueries({ queryKey: ["borrowings"], refetchType });
  queryClient.invalidateQueries({ queryKey: ["profile", "stats"], refetchType });
  // The request that was just fulfilled — otherwise the book page keeps
  // offering "continue getting this book", and every other book keeps refusing
  // a new request because this reader looks like they still have one open.
  invalidatePickupRequest();
  // The "books you have now" list lives under `qk.books.heldBy`, so the
  // `qk.books.all` prefix above already covers it — both the list and the
  // profile counter that mirrors it refresh from this one call.
}
