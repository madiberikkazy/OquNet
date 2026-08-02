import { queryClient } from "./queryClient.js";
import { qk } from "./queryKeys.js";
import { cacheService } from "../utils/cacheService.js";

/**
 * Drop every cache that names a book's holder, after the book changes hands.
 *
 * Queries default to `refetchOnMount: false`, so a screen that already has
 * stats in cache — the profile counters above all — would keep showing the
 * pre-handoff numbers until the tab regains focus. Anything derived from "who
 * has this book" has to be invalidated explicitly at the handoff itself.
 */
export function invalidateHolderCaches(bookId) {
  queryClient.invalidateQueries({ queryKey: qk.books.all });
  if (bookId) {
    queryClient.invalidateQueries({ queryKey: qk.borrowings.activeByBook(bookId) });
  }
  queryClient.invalidateQueries({ queryKey: ["borrowings", "forUser"] });
  queryClient.invalidateQueries({ queryKey: ["profile", "stats"] });
  cacheService.clearPattern("^ownedBooks:");
}
