import { queryClient } from "./queryClient.js";
import { qk } from "./queryKeys.js";
import { cacheService } from "../utils/cacheService.js";

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
export function invalidateHolderCaches(bookId) {
  const refetchType = "all";
  queryClient.invalidateQueries({ queryKey: qk.books.all, refetchType });
  queryClient.invalidateQueries({ queryKey: ["borrowings"], refetchType });
  queryClient.invalidateQueries({ queryKey: ["profile", "stats"], refetchType });
  if (bookId) {
    // The request that was just fulfilled — otherwise the book page keeps
    // offering "continue getting this book".
    queryClient.invalidateQueries({ queryKey: ["pickupRequest", bookId], refetchType });
  }
  cacheService.clearPattern("^ownedBooks:");
}
