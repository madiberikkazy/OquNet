// Central query-key factory. Every fetch in the app derives its cache key from
// here so we can (a) grep for consumers of a given key and (b) invalidate
// slices with a single prefix — e.g. queryClient.invalidateQueries({
// queryKey: qk.books.all }) drops every books-related cache entry.
export const qk = {
  books: {
    all: ["books"],
    list: (communityId, filters) => ["books", "list", communityId, filters],
    detail: (id) => ["books", "detail", id],
    ratings: (ids) => ["books", "ratings", [...ids].sort().join(",")],
    // Recently added books — the horizontal rail above the main list.
    recent: (communityId) => ["books", "recent", communityId],
    // Books physically with a user right now — the "Сізде қазір бар кітаптар"
    // list. Sits under `books` so a handoff invalidates it along with
    // everything else that names a holder.
    heldBy: (userId, communityId) => ["books", "heldBy", userId, communityId],
  },
  users: {
    byId: (id) => ["users", id],
  },
  borrowings: {
    activeByBook: (bookId) => ["borrowings", "activeByBook", bookId],
    lastCompletedByBook: (bookId) => ["borrowings", "lastCompletedByBook", bookId],
    forUser: (userId, status) => ["borrowings", "forUser", userId, status],
    // "has this user finished this book?" — the gate for rating it
    userCompletedBook: (bookId, userId) => ["borrowings", "userCompleted", bookId, userId],
  },
  notifications: {
    forUser: (userId) => ["notifications", userId],
  },
  ratings: {
    forBook: (bookId) => ["ratings", bookId],
    byUser: (bookId, userId) => ["ratings", bookId, "byUser", userId],
  },
  pickupRequest: {
    byBookAndUser: (bookId, userId) => ["pickupRequest", bookId, userId],
  },
  profile: {
    stats: (userId, communityId) => ["profile", "stats", userId, communityId],
  },
};
