// Central query-key factory. Every fetch in the app derives its cache key from
// here so we can (a) grep for consumers of a given key and (b) invalidate
// slices with a single prefix — e.g. queryClient.invalidateQueries({
// queryKey: qk.books.all }) drops every books-related cache entry.
export const qk = {
  books: {
    all: ["books"],
    /** The paged shelf. Owned by an *infinite* query — see `forExit` below. */
    list: (communityId, filters) => ["books", "list", communityId, filters],
    detail: (id) => ["books", "detail", id],
    // Recently added books — the horizontal rail above the main list.
    recent: (communityId) => ["books", "recent", communityId],
    // Books physically with a user right now — the "Сізде қазір бар кітаптар"
    // list. Sits under `books` so a handoff invalidates it along with
    // everything else that names a holder.
    heldBy: (userId, communityId) => ["books", "heldBy", userId, communityId],
    // Everything the community-exit rules can turn on: the books a user holds
    // plus the books they own (utils/communityExit.js `loadExitBooks`).
    //
    // It gets a key of its own rather than borrowing `list`'s. The Books screen
    // reads `list` with useInfiniteQuery, whose cache entry is
    // `{ pages, pageParams }`; a plain useQuery on the same key stores a bare
    // array there, and whichever screen mounts second reads the other's shape.
    forExit: (userId, communityId) => ["books", "forExit", userId, communityId],
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
    /** Every viewer's answer for one book — the prefix an invalidate targets. */
    forBook: (bookId) => ["pickupRequest", bookId],
    /** "Does this reader have a pickup open anywhere?" — the one-at-a-time gate. */
    pendingForUser: (userId) => ["pickupRequest", "pendingForUser", userId],
  },
  returnRequest: {
    /** One owner's open return on one book — the code screen's own record. */
    byBookAndUser: (bookId, userId) => ["returnRequest", bookId, userId],
    /** "Is somebody already collecting this copy?" — the pickup screen's gate. */
    forBook: (bookId) => ["returnRequest", "forBook", bookId],
    /** Every return this member has open — one row per book on the leave screen. */
    pendingForUser: (userId) => ["returnRequest", "pendingForUser", userId],
  },
  profile: {
    stats: (userId, communityId) => ["profile", "stats", userId, communityId],
    // Everything the "other member" screen shows at once: their shelves plus
    // the lists behind each counter, fetched together because the counters and
    // the lists are the same data and must not be able to disagree.
    member: (userId, viewerCommunityId) => ["profile", "member", userId, viewerCommunityId],
  },
  reading: {
    // Standing inside a community by total reading minutes.
    rank: (communityId, userId) => ["reading", "rank", communityId, userId],
    // A reader's own recent timer sittings.
    sessions: (userId) => ["reading", "sessions", userId],
  },
};
