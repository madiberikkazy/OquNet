// The localStorage branch of the data layer, driven through its real public API.
// This is the half the emulator cannot reach, and the half whose paging was
// rewritten from scratch — getCollection used to ignore `cursor` outright, so
// every "load more" re-served page one forever.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

// Minimal localStorage, installed before firestore.js is imported.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
// utils/safeStorage.js reaches through `window`, not the bare global — it is
// written to survive a browser that refuses storage, and a missing `window` is
// indistinguishable from that. Without this the modules that keep a little
// state across a reload (the auth session, a pending verification) read nothing
// under Node and every test of them passes for the wrong reason.
globalThis.window = { localStorage: globalThis.localStorage };

const {
  createBook, listBooks, listNewBooks, listBooksHeldBy, listBooksOwnedBy,
  updateBook, getBook, createNotification, listNotifications,
  createUserDoc, getUserById, updateUser, searchUsers, notifyCommunityMembers,
  followUser, unfollowUser, isFollowing, listFollowers, listFollowing,
  sendMessage, markChatRead, markChatDelivered, messageStatus, MESSAGE_STATUS,
  needsReadReceipt, needsDeliveryReceipt, isOnline, lastSeenAt, touchPresence,
  watchChatsForUser, chatIdFor,
  listBorrowingsForBook, getUsersByIds, BOOK_JOURNEY_MAX,
  createPost, getPost, listPublicPosts, listPostsByCommunity, togglePostLike,
  listPostsByAuthor, createComment, listComments, deleteComment,
  logReadingSession, listReadingSessions, getCommunityReadingRank,
  createJoinRequest, getRequestById, getPhoneVerification,
  openPickupRequest, getPickupRequest, getPendingPickupForUser,
  holdBookForPickup, releasePickupHold,
  cancelPickupRequest, fulfillPickupRequest, createBorrowing, PickupBlockedError,
  openReturnRequest, offerReturnToOwner, getReturnRequest, getPendingReturnForBook,
  listPendingReturnsForUser, listPendingReturnsForHolder,
  cancelReturnRequest, expireReturnRequest,
  completeReturnToOwner, transferBookHolder, getActiveBorrowingByBook,
  NEW_BOOK_WINDOW_DAYS,
} = await import("../src/firebase/firestore.js");

const {
  buildReadingWeek, dayKey, formatDuration, readerLevel,
} = await import("../src/utils/readingProgress.js");

const {
  PAGE_BANDS, loanDaysForPages, pagesForBook,
} = await import("../src/utils/bookPages.js");

const { requestBook } = await import("../src/firebase/schema.js");

const { withCompleteLists } = await import("../src/utils/useMemberProfile.js");

const { newFeedSeed, orderFeed, shuffleStable } = await import("../src/utils/feedOrder.js");

const { toE164, isE164 } = await import("../src/utils/validators.js");

const {
  botConfig, verificationAvailable, hasVerifiedPhone, isVerificationExpired,
  newVerificationToken, startPhoneVerification, simulateBotConfirmation,
  abandonVerification, readPendingVerification, verificationLink,
  verificationPayload,
} = await import("../src/firebase/phoneVerify.js");

const LS_KEY = "oqunet:db";
const DAY = 86_400_000;
const COMMUNITY = "c1";

/** Backdate a stored book — createOne owns createdAt, so reach past it. */
function backdate(id, ms) {
  const db = JSON.parse(store.get(LS_KEY));
  db.books.find((b) => b.id === id).createdAt = ms;
  store.set(LS_KEY, JSON.stringify(db));
}

/** The same reach-past, for the feed queries that sort posts by their stamp. */
function backdatePost(id, ms) {
  const db = JSON.parse(store.get(LS_KEY));
  db.posts.find((p) => p.id === id).createdAt = ms;
  store.set(LS_KEY, JSON.stringify(db));
}

async function seedBooks(n) {
  const ids = [];
  const now = Date.now();
  for (let i = 0; i < n; i += 1) {
    const { id } = await createBook({
      name: `Book ${String(i).padStart(2, "0")}`,
      author: i % 2 ? "Tolstoy" : "Auezov",
      communityId: COMMUNITY,
      ownerId: `u${i % 3}`,
      genres: [i % 2 ? "fiction" : "history"],
      // A page band, not a loan length: `maxDays` is derived from this now.
      pages: 700,
    });
    // One hour apart, descending with i, so ordering is unambiguous.
    backdate(id, now - i * 3600_000);
    ids.push(id);
  }
  return ids; // index 0 is newest
}

beforeEach(() => store.clear());

describe("localStorage paging", () => {
  it("pages a 35-book shelf with no gaps and no duplicates", async () => {
    const ids = await seedBooks(35);

    const pages = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listBooks({ communityId: COMMUNITY, pageSize: 10, cursor });
      pages.push(page.items.map((b) => b.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      assert.ok(cursor, "hasMore was true but nextCursor was null");
    }

    const seen = pages.flat();
    assert.equal(seen.length, 35, `expected 35 books across pages, got ${seen.length}`);
    assert.equal(new Set(seen).size, 35, "the same book appeared on two pages");
    assert.deepEqual(seen, ids, "pages are not in createdAt-descending order");
    assert.deepEqual(pages.map((p) => p.length), [10, 10, 10, 5]);
  });

  it("reports hasMore=false on the last page", async () => {
    await seedBooks(12);
    const first = await listBooks({ communityId: COMMUNITY, pageSize: 10 });
    assert.equal(first.hasMore, true);
    const second = await listBooks({ communityId: COMMUNITY, pageSize: 10, cursor: first.nextCursor });
    assert.equal(second.items.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
  });

  it("searches across every page, not just the first", async () => {
    const ids = await seedBooks(35);
    // "Book 33" is on page four; the old client-side filter could never see it.
    const hit = await listBooks({ communityId: COMMUNITY, search: "33", pageSize: 10 });
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0].id, ids[33]);
  });

  it("matches on author as well as title", async () => {
    await seedBooks(10);
    const { items } = await listBooks({ communityId: COMMUNITY, search: "tolst", pageSize: 30 });
    assert.equal(items.length, 5);
    for (const b of items) assert.equal(b.author, "Tolstoy");
  });

  it("filters by multiple genres", async () => {
    await seedBooks(10);
    const only = await listBooks({ communityId: COMMUNITY, genres: ["history"], pageSize: 30 });
    assert.equal(only.items.length, 5);
    const both = await listBooks({ communityId: COMMUNITY, genres: ["history", "fiction"], pageSize: 30 });
    assert.equal(both.items.length, 10);
  });

  it("combines search and genre", async () => {
    await seedBooks(20);
    const { items } = await listBooks({
      communityId: COMMUNITY, search: "tolstoy", genres: ["fiction"], pageSize: 30,
    });
    assert.equal(items.length, 10);
    for (const b of items) {
      assert.equal(b.author, "Tolstoy");
      assert.equal(b.genre, "fiction");
    }
  });
});

describe("listNewBooks", () => {
  it("returns only books inside the window, newest first, capped", async () => {
    const ids = await seedBooks(6);
    // Push the last three well outside the 10-day window.
    const old = Date.now() - (NEW_BOOK_WINDOW_DAYS + 5) * DAY;
    for (let i = 3; i < 6; i += 1) backdate(ids[i], old - i * 1000);

    const fresh = await listNewBooks({ communityId: COMMUNITY });
    assert.deepEqual(fresh.map((b) => b.id), ids.slice(0, 3));
  });

  it("caps at the requested limit", async () => {
    await seedBooks(25);
    assert.equal((await listNewBooks({ communityId: COMMUNITY })).length, 10);
  });
});

describe("holder and owner queries", () => {
  it("returns only this user's books", async () => {
    await seedBooks(12); // ownerId cycles u0,u1,u2
    const held = await listBooksHeldBy({ communityId: COMMUNITY, userId: "u1" });
    const owned = await listBooksOwnedBy({ communityId: COMMUNITY, userId: "u1" });
    assert.equal(held.length, 4);
    assert.equal(owned.length, 4);
    for (const b of held) assert.equal(b.holderId, "u1");
    for (const b of owned) assert.equal(b.ownerId, "u1");
  });
});

// The loan period is no longer a number anybody types. It is one day per fifty
// pages of the book, derived on the way in, so the two can never disagree —
// which is the whole reason `maxDays` is still stored rather than computed at
// every read.
describe("loan period follows the page band", () => {
  const book = (pages) => ({
    name: "Abai Zholy", author: "Auezov", communityId: COMMUNITY,
    ownerId: "u1", genres: ["fiction"], pages,
  });

  it("gives one day per fifty pages, from one band to twenty", async () => {
    assert.equal(PAGE_BANDS.length, 20);
    for (const band of [PAGE_BANDS[0], PAGE_BANDS[4], PAGE_BANDS.at(-1)]) {
      const { id } = await createBook(book(band.pages));
      const stored = await getBook(id);
      assert.equal(stored.pages, band.pages);
      assert.equal(stored.maxDays, band.days, `${band.pages} pages`);
    }
    assert.equal(loanDaysForPages(50), 1);
    assert.equal(loanDaysForPages(1000), 20);
  });

  it("moves the allowance in the same write as the band", async () => {
    const { id } = await createBook(book(100));
    assert.equal((await getBook(id)).maxDays, 2);

    await updateBook(id, { pages: 500 });

    const after = await getBook(id);
    assert.equal(after.pages, 500);
    assert.equal(after.maxDays, 10, "maxDays did not follow the new band");
  });

  it("refuses a book with no band, and one that is not a band", async () => {
    await assert.rejects(() => createBook(book(undefined)), { errorKey: "addBookErrPages" });
    await assert.rejects(() => createBook(book(137)), { errorKey: "addBookErrPages" });
  });

  it("reads a band back off a book that predates the rule", () => {
    // Priced by hand under the old form: 14 days, no page count. It keeps the
    // allowance it was given, and the edit form opens on the matching band.
    assert.equal(pagesForBook({ maxDays: 14 }), 700);
    assert.equal(pagesForBook({ pages: 300, maxDays: 6 }), 300);
  });
});

// Joining costs a book, and the request is where that book now lives in full.
// The point of these: what the admin approves is already a valid book, so
// approval is a create and not a second round of data entry.
describe("join requests carry the whole book", () => {
  const application = (book) => ({
    userId: "u9", userNickname: "aigul", userName: "Aigul Serik",
    communityId: COMMUNITY, book,
  });
  const fullBook = {
    name: "Qahar", author: "Esenberlin", description: "A novel.",
    genres: ["history"], pages: 450, year: 1969,
  };

  it("stores the book validated, with the loan period already derived", async () => {
    const req = await createJoinRequest(application(fullBook));
    const stored = await getRequestById(req.id);

    assert.equal(stored.type, "join");
    assert.equal(stored.status, "pending");
    assert.equal(stored.book.name, "Qahar");
    assert.equal(stored.book.pages, 450);
    assert.equal(stored.book.maxDays, 9, "the band's loan period did not travel");
    assert.deepEqual(stored.book.genres, ["history"]);
    // Whose book it is, is who is applying — never a field of its own.
    assert.equal(stored.book.ownerId, undefined);
    assert.equal(stored.userId, "u9");
  });

  it("refuses an application whose book would not be a book", async () => {
    await assert.rejects(
      () => createJoinRequest(application({ ...fullBook, name: "" })),
      { errorKey: "addBookErrName" },
    );
    await assert.rejects(
      () => createJoinRequest(application({ ...fullBook, genres: [] })),
      { errorKey: "addBookErrGenre" },
    );
    await assert.rejects(
      () => createJoinRequest(application({ ...fullBook, pages: undefined })),
      { errorKey: "addBookErrPages" },
    );
  });

  it("reads a request written before the book travelled with it", () => {
    // Still pending in an admin's inbox: a title, an author, and blanks the
    // review form now asks them to fill in.
    const legacy = requestBook({ bookName: "Old", bookAuthor: "Author" });
    assert.equal(legacy.name, "Old");
    assert.equal(legacy.author, "Author");
    assert.deepEqual(legacy.genres, []);
    assert.equal(legacy.pages, "");
  });
});

describe("search index maintenance", () => {
  it("rewrites searchPrefixes when the title changes", async () => {
    const [id] = await seedBooks(1);
    assert.equal((await listBooks({ communityId: COMMUNITY, search: "book" })).items.length, 1);

    await updateBook(id, { name: "Neuromancer" });

    const stale = await listBooks({ communityId: COMMUNITY, search: "book" });
    assert.equal(stale.items.length, 0, "book is still findable under its old title");
    const fresh = await listBooks({ communityId: COMMUNITY, search: "neuro" });
    assert.equal(fresh.items.length, 1, "book is not findable under its new title");
  });

  it("keeps the author searchable when only the title is patched", async () => {
    const [id] = await seedBooks(1); // author "Auezov"
    await updateBook(id, { name: "Abai Zholy" });
    const { items } = await listBooks({ communityId: COMMUNITY, search: "auez" });
    assert.equal(items.length, 1, "author prefix was dropped by a title-only patch");
    assert.equal((await getBook(id)).author, "Auezov");
  });
});

// Finding a person used to mean knowing their @handle: search was a prefix scan
// over `nickname`, so the name printed on every screen in the app was the one
// thing it could not match. These cover the denormalised array that replaced it
// — including the half that rots silently, which is a profile that gets renamed.
describe("people search", () => {
  async function person(over = {}) {
    const base = {
      id: over.id ?? "u-" + Math.random().toString(36).slice(2, 8),
      email: (over.nickname ?? "x") + "@example.com",
      nickname: "madi", firstName: "Madi", lastName: "Berikkazy",
    };
    return createUserDoc({ ...base, ...over });
  }

  it("finds somebody by their first name, whatever the case", async () => {
    await person();
    assert.equal((await searchUsers("Madi")).length, 1);
    assert.equal((await searchUsers("madi")).length, 1);
    assert.equal((await searchUsers("MAD")).length, 1, "prefix of a name did not match");
  });

  it("finds somebody by their last name", async () => {
    await person();
    // The half that was impossible before: nothing about "Berikkazy" appears in
    // the handle, so the old nickname scan could never reach it.
    assert.equal((await searchUsers("berik")).length, 1);
  });

  it("still finds somebody by their handle", async () => {
    await person({ nickname: "vanya", firstName: "Ivan", lastName: "Petrov" });
    assert.equal((await searchUsers("vany")).length, 1);
  });

  it("takes the most selective word of a multi-word query", async () => {
    await person();
    await person({ id: "u-other", nickname: "madi2", firstName: "Madi", lastName: "Nurlan" });
    // "madi" matches both; "berikkazy" is the longer word and narrows to one.
    assert.equal((await searchUsers("Madi Berikkazy")).length, 1);
    assert.equal((await searchUsers("Madi")).length, 2);
  });

  it("returns nothing for an empty or unmatched query", async () => {
    await person();
    assert.deepEqual(await searchUsers(""), []);
    assert.deepEqual(await searchUsers("   "), []);
    assert.deepEqual(await searchUsers("zzzz"), []);
  });

  it("follows a rename instead of answering to the old name", async () => {
    const { id } = await person();
    await updateUser(id, { lastName: "Nurlanuly" });

    assert.equal((await searchUsers("berik")).length, 0, "still findable under the old surname");
    assert.equal((await searchUsers("nurlan")).length, 1, "not findable under the new surname");
    // The fields the patch did not name have to survive it — this is the bug
    // that a patch-built array would introduce.
    assert.equal((await searchUsers("madi")).length, 1, "first name dropped by a surname-only patch");
  });

  it("leaves the array alone for a patch that touches no name", async () => {
    const { id } = await person();
    await updateUser(id, { savedBookIds: ["b1"] });
    assert.equal((await searchUsers("berik")).length, 1);
    assert.deepEqual((await getUserById(id)).savedBookIds, ["b1"]);
  });

  it("stops answering to a name a scrubbed account no longer carries", async () => {
    const { id } = await person();
    await updateUser(id, { firstName: "", lastName: "", nickname: "deleted_abc123" });
    assert.equal((await searchUsers("madi")).length, 0);
    assert.equal((await searchUsers("berik")).length, 0);
    assert.equal((await searchUsers("deleted")).length, 1);
  });
});

// The order a feed comes in. The property that matters is not "random" — it is
// that the same seed gives the same order, because a list that re-shuffles on
// every render moves rows out from under the reader's thumb.
describe("feed order", () => {
  const posts = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, authorId: `a${i % 4}` }));

  it("keeps every item, exactly once", () => {
    const out = shuffleStable(posts, 42);
    assert.equal(out.length, posts.length);
    assert.deepEqual(new Set(out.map((p) => p.id)).size, posts.length);
  });

  it("gives the same order for the same seed, and a different one otherwise", () => {
    const a = shuffleStable(posts, 42).map((p) => p.id);
    const b = shuffleStable(posts, 42).map((p) => p.id);
    assert.deepEqual(a, b, "the order moved without the seed moving");

    const c = shuffleStable(posts, 43).map((p) => p.id);
    assert.notDeepEqual(a, c, "the seed made no difference");
  });

  it("does not simply hand back the order it was given", () => {
    const before = posts.map((p) => p.id);
    const after = shuffleStable(posts, newFeedSeed()).map((p) => p.id);
    assert.equal(after.length, before.length);
    assert.notDeepEqual(after, before);
  });

  it("puts the people you follow first, and keeps the rest", () => {
    const followedIds = new Set(["a1"]);
    const out = orderFeed(posts, { followedIds, seed: 7 });

    const firstFive = out.slice(0, 5);
    assert.ok(firstFive.every((p) => p.authorId === "a1"), "a followed author was not at the front");
    assert.equal(out.length, posts.length);
    assert.equal(out.filter((p) => p.authorId === "a1").length, 5);
  });

  it("is a plain shuffle when you follow nobody", () => {
    const out = orderFeed(posts, { followedIds: new Set(), seed: 7 });
    assert.deepEqual(
      out.map((p) => p.id),
      shuffleStable(posts, 7).map((p) => p.id)
    );
  });

  it("survives an empty feed and a missing follow set", () => {
    assert.deepEqual(orderFeed([], { seed: 1 }), []);
    assert.deepEqual(orderFeed(null, { seed: 1 }), []);
    assert.equal(orderFeed(posts, { seed: 1 }).length, posts.length);
  });
});

// The hold a pickup puts on a copy: on when the errand starts, off when it is
// cancelled or lapses, and gone the moment the book actually changes hands.
describe("holding a book for a pickup", () => {
  const OWNER = "u-owner";
  const READER = "u-reader";
  const OTHER = "u-other";
  const COMMUNITY = "com-1";
  let bookId;

  beforeEach(async () => {
    const book = await createBook({
      name: "Abai", author: "Auezov", genre: "novel", genres: ["novel"], pages: 100,
      communityId: COMMUNITY, ownerId: OWNER, holderId: OWNER,
    });
    bookId = book.id;
  });

  it("takes the copy off the shelf, in the reader's name", async () => {
    await holdBookForPickup({ bookId, userId: READER });

    const held = await getBook(bookId);
    assert.equal(held.status, "unavailable");
    assert.equal(held.borrowerId, null, "a hold is not a loan");
    assert.equal(held.reservedBy, READER);
    assert.equal(held.holderId, OWNER, "the book did not move");
  });

  it("puts it back when the reader gives up", async () => {
    await holdBookForPickup({ bookId, userId: READER });
    await releasePickupHold({ bookId, userId: READER });

    const free = await getBook(bookId);
    assert.equal(free.status, "available");
    assert.equal(free.reservedBy, null);
  });

  it("is not something a bystander can drop", async () => {
    await holdBookForPickup({ bookId, userId: READER });
    await releasePickupHold({ bookId, userId: OTHER });

    assert.equal((await getBook(bookId)).reservedBy, READER);
  });

  it("is the owner's to clear — a forgotten hold is their book", async () => {
    await holdBookForPickup({ bookId, userId: READER });
    await releasePickupHold({ bookId, userId: OWNER });

    assert.equal((await getBook(bookId)).status, "available");
  });

  it("does not take a copy somebody else is already collecting", async () => {
    await holdBookForPickup({ bookId, userId: READER });
    await holdBookForPickup({ bookId, userId: OTHER });

    assert.equal((await getBook(bookId)).reservedBy, READER, "a second hold overwrote the first");
  });

  it("never puts a book somebody is reading back on the shelf", async () => {
    await transferBookHolder({
      bookId, toUserId: READER,
      borrowing: { bookName: "Abai", communityId: COMMUNITY, startDate: Date.now() },
    });
    await releasePickupHold({ bookId, userId: OWNER });

    const still = await getBook(bookId);
    assert.equal(still.status, "unavailable");
    assert.equal(still.borrowerId, READER);
  });

  it("is cleared by the handover it was holding the book for", async () => {
    await holdBookForPickup({ bookId, userId: READER });
    await transferBookHolder({
      bookId, toUserId: READER,
      borrowing: { bookName: "Abai", communityId: COMMUNITY, startDate: Date.now() },
    });

    const taken = await getBook(bookId);
    assert.equal(taken.reservedBy, null, "the hold outlived the pickup it belonged to");
    assert.equal(taken.borrowerId, READER);
    assert.equal(taken.holderId, READER);
  });

  it("refuses a new pickup on a copy held for somebody else", async () => {
    await holdBookForPickup({ bookId, userId: READER });

    await assert.rejects(
      () => openPickupRequest({ bookId, requesterId: OTHER, requesterName: "O", communityId: COMMUNITY }),
      (err) => err instanceof PickupBlockedError && err.reason === "held"
    );
  });

  it("still lets the reader who holds it open their own request", async () => {
    await holdBookForPickup({ bookId, userId: READER });

    const { created } = await openPickupRequest({
      bookId, requesterId: READER, requesterName: "R", communityId: COMMUNITY,
    });
    assert.equal(created, true);
  });
});

// A profile read back out of yesterday's cache. The query cache is persisted to
// IndexedDB for a day, so a screen reads what the *previous* build wrote as well
// as what this one does — and this entry has changed shape twice.
describe("member profile, read from an older cache", () => {
  it("fills in a list the stored entry never had", () => {
    // Exactly what a build before the posts section wrote: `owned` present,
    // `posts` absent. Reading `lists.posts.length` off this threw, and took the
    // whole profile screen down with it.
    const stale = {
      user: { id: "u1" },
      community: null,
      sameCommunity: true,
      lists: { held: [{ id: "b1" }], owned: [{ id: "b2" }], reading: [], completed: [], saved: [] },
    };

    const fixed = withCompleteLists(stale);

    assert.deepEqual(fixed.lists.posts, [], "posts was left undefined");
    assert.equal(fixed.lists.held.length, 1, "a list that was there did not survive");
    assert.equal(fixed.user.id, "u1");
  });

  it("leaves a current entry exactly as it is, and passes null through", () => {
    const fresh = {
      user: { id: "u1" }, sameCommunity: true,
      lists: { held: [], reading: [], completed: [], saved: [], posts: [{ id: "p1" }] },
    };
    assert.deepEqual(withCompleteLists(fresh).lists.posts, [{ id: "p1" }]);
    assert.equal(withCompleteLists(null), null);
  });
});

// The like path, driven the way a screen drives it — because the bug this
// covers was not in the data layer at all, it was in a screen telling the data
// layer what to do from a copy of the answer that had gone stale.
describe("liking, tap after tap", () => {
  const READER = "u-reader";
  let postId;

  beforeEach(async () => {
    await createUserDoc({ id: READER, email: "r@example.com", nickname: "reader", firstName: "R" });
    const post = await createPost({
      communityId: "com-1", authorId: "u-author", isPublic: true, body: "text",
    });
    postId = post.id;
  });

  /** One tap, done the way the screen does it: state in, new state out. */
  async function tap(likedPostIds) {
    const result = await togglePostLike({
      postId, userId: READER, likedPostIds, liked: !likedPostIds.includes(postId),
    });
    return result.likedPostIds;
  }

  it("counts an even number of taps as no like at all", async () => {
    let liked = [];
    liked = await tap(liked);
    liked = await tap(liked);

    assert.deepEqual(liked, []);
    assert.equal((await getPost(postId)).likeCount, 0);
  });

  it("counts three taps as one", async () => {
    let liked = [];
    for (let i = 0; i < 3; i += 1) liked = await tap(liked);

    assert.deepEqual(liked, [postId]);
    assert.equal((await getPost(postId)).likeCount, 1);
  });

  // The regression. A screen that answered "am I liking this?" from its own
  // optimistic state while handing the data layer a `likedPostIds` that had not
  // caught up got two likes out of two taps: the unlike was compared against an
  // array that still said "not liked", changed nothing, and the next like was
  // therefore a second one.
  it("a stale list makes the unlike a no-op — which is why it must not be used", async () => {
    const stale = [];
    await tap(stale);                       // like: stored as [postId]
    const second = await togglePostLike({   // the screen says "unlike"…
      postId, userId: READER, likedPostIds: stale, liked: false,
    });

    assert.equal(second.changed, false, "the write happened against a stale list");
    assert.equal((await getPost(postId)).likeCount, 1);

    // Handed what was actually stored, the same tap does what it says.
    const undone = await togglePostLike({
      postId, userId: READER, likedPostIds: [postId], liked: false,
    });
    assert.deepEqual(undone.likedPostIds, []);
    assert.equal((await getPost(postId)).likeCount, 0);
  });
});

// Replies under a post. The comment is the fact and the counter on the post is
// a summary of it, so every test here checks both — the pair going out of step
// is the whole failure mode this arrangement has.
describe("comments", () => {
  const POST_COMMUNITY = "com-1";
  let postId;

  async function seedPost(over = {}) {
    const p = await createPost({
      communityId: POST_COMMUNITY, authorId: "u-author", authorName: "A",
      isPublic: true, body: "text", ...over,
    });
    return p.id;
  }

  async function reply(over = {}) {
    return createComment({
      postId, communityId: POST_COMMUNITY, isPublic: true,
      authorId: "u-reader", authorName: "R", body: "nice", ...over,
    });
  }

  it("writes the reply and counts it on the post", async () => {
    postId = await seedPost();
    await reply();

    assert.equal((await listComments({ postId, communityId: POST_COMMUNITY })).length, 1);
    assert.equal((await getPost(postId)).commentCount, 1);
  });

  it("reads a thread oldest first", async () => {
    postId = await seedPost();
    await reply({ body: "first" });
    await reply({ body: "second" });
    await reply({ body: "third" });

    assert.deepEqual(
      (await listComments({ postId, communityId: POST_COMMUNITY })).map((c) => c.body),
      ["first", "second", "third"]
    );
  });

  it("keeps another post's replies out of it", async () => {
    postId = await seedPost();
    await reply({ body: "mine" });
    const other = await seedPost();
    await createComment({
      postId: other, communityId: POST_COMMUNITY, isPublic: true,
      authorId: "u-reader", body: "theirs",
    });

    const thread = await listComments({ postId, communityId: POST_COMMUNITY });
    assert.deepEqual(thread.map((c) => c.body), ["mine"]);
    assert.equal((await getPost(postId)).commentCount, 1);
    assert.equal((await getPost(other)).commentCount, 1);
  });

  it("only answers a query that names an audience it may read", async () => {
    postId = await seedPost();
    await reply();
    // Without a community, the public flag is the ground the query stands on —
    // the same two shapes the security rules accept, and the reason a reply
    // carries a copy of the post's audience at all.
    assert.equal((await listComments({ postId })).length, 1);

    const closed = await seedPost({ isPublic: false });
    await createComment({
      postId: closed, communityId: POST_COMMUNITY, isPublic: false,
      authorId: "u-reader", body: "members only",
    });
    assert.equal((await listComments({ postId: closed })).length, 0, "a members-only reply was public");
    assert.equal((await listComments({ postId: closed, communityId: POST_COMMUNITY })).length, 1);
  });

  it("takes the counter back down when a reply is removed", async () => {
    postId = await seedPost();
    const c = await reply();
    await deleteComment({ id: c.id, postId });

    assert.equal((await listComments({ postId, communityId: POST_COMMUNITY })).length, 0);
    assert.equal((await getPost(postId)).commentCount, 0);
  });

  it("never takes the counter below zero", async () => {
    postId = await seedPost();
    const c = await reply();
    await deleteComment({ id: c.id, postId });
    // A second delete of the same reply — the row is gone, and there is nothing
    // left to subtract from a counter already at zero.
    await deleteComment({ id: c.id, postId });
    assert.equal((await getPost(postId)).commentCount, 0);
  });

  it("refuses a reply with no text and one with no post", async () => {
    postId = await seedPost();
    await assert.rejects(() => reply({ body: "   " }));
    await assert.rejects(() => reply({ postId: "" }));
    assert.equal((await getPost(postId)).commentCount, 0);
  });
});

// The number under a name on a profile. The second filter in this query is not
// a refinement — it is what makes the query legal against the posts rules — so
// these cover both shapes of it.
describe("posts by one author", () => {
  const A = "u-author";
  const OTHER = "u-other";
  const C1 = "com-1";
  const C2 = "com-2";

  async function post(over) {
    return createPost({
      communityId: C1, authorId: A, authorName: "A", isPublic: true, body: "text", ...over,
    });
  }

  it("counts what this author wrote in one community, and nobody else's", async () => {
    await post({});
    await post({});
    await post({ authorId: OTHER });
    await post({ communityId: C2 });

    const mine = await listPostsByAuthor({ authorId: A, communityId: C1 });
    assert.equal(mine.length, 2);
    assert.ok(mine.every((p) => p.authorId === A && p.communityId === C1));
  });

  it("falls back to the public ones when there is no community to ask about", async () => {
    await post({ isPublic: true });
    await post({ isPublic: false });

    const seen = await listPostsByAuthor({ authorId: A });
    assert.equal(seen.length, 1, "a private post was counted from outside");
    assert.equal(seen[0].isPublic, true);
  });

  it("says nothing without an author", async () => {
    await post({});
    assert.deepEqual(await listPostsByAuthor({}), []);
  });
});

// The follow graph. The edge is the fact and the two counters are a summary of
// it, so every test here checks both — a follow that moved one and not the
// other is exactly the state the whole arrangement exists to prevent.
describe("following", () => {
  const A = "u-a";
  const B = "u-b";

  async function people() {
    await createUserDoc({ id: A, email: "a@example.com", nickname: "aaa", firstName: "Aida" });
    await createUserDoc({ id: B, email: "b@example.com", nickname: "bbb", firstName: "Bek" });
  }

  it("writes the edge and moves both counters", async () => {
    await people();
    const result = await followUser({ followerId: A, followingId: B });

    assert.deepEqual(result, { following: true, changed: true });
    assert.equal(await isFollowing(A, B), true);
    assert.equal((await getUserById(B)).followersCount, 1);
    assert.equal((await getUserById(A)).followingCount, 1);
  });

  it("is one-directional — following back is a second edge", async () => {
    await people();
    await followUser({ followerId: A, followingId: B });

    assert.equal(await isFollowing(B, A), false, "the edge answered in both directions");

    await followUser({ followerId: B, followingId: A });
    assert.equal((await getUserById(A)).followersCount, 1);
    assert.equal((await getUserById(A)).followingCount, 1);
  });

  it("counts a second tap once", async () => {
    await people();
    await followUser({ followerId: A, followingId: B });
    const again = await followUser({ followerId: A, followingId: B });

    assert.deepEqual(again, { following: true, changed: false });
    assert.equal((await getUserById(B)).followersCount, 1, "a double tap inflated the counter");
    assert.equal((await listFollowers(B)).length, 1, "a double tap wrote a second edge");
  });

  it("takes the edge and both counters back down", async () => {
    await people();
    await followUser({ followerId: A, followingId: B });
    const result = await unfollowUser({ followerId: A, followingId: B });

    assert.deepEqual(result, { following: false, changed: true });
    assert.equal(await isFollowing(A, B), false);
    assert.equal((await getUserById(B)).followersCount, 0);
    assert.equal((await getUserById(A)).followingCount, 0);
  });

  it("unfollowing somebody you do not follow changes nothing", async () => {
    await people();
    const result = await unfollowUser({ followerId: A, followingId: B });

    assert.deepEqual(result, { following: false, changed: false });
    assert.equal((await getUserById(B)).followersCount, 0, "a counter went negative");
  });

  it("leaves a profile that predates the counters at zero, not below it", async () => {
    await people();
    // An account written before follows existed carries neither field. The
    // guard in unfollowUser is what keeps this from trying to subtract from
    // nothing — against the real rules that is a denied write, not a −1.
    await updateUser(B, { followersCount: undefined });
    await followUser({ followerId: A, followingId: B });
    await unfollowUser({ followerId: A, followingId: B });

    assert.ok(((await getUserById(B)).followersCount ?? 0) >= 0);
  });

  it("lists both ends of the graph, newest first", async () => {
    await people();
    await createUserDoc({ id: "u-c", email: "c@example.com", nickname: "ccc", firstName: "Cholpon" });

    await followUser({ followerId: A, followingId: B });
    await followUser({ followerId: "u-c", followingId: B });
    await followUser({ followerId: A, followingId: "u-c" });

    assert.deepEqual(
      (await listFollowers(B)).map((edge) => edge.followerId).sort(),
      [A, "u-c"]
    );
    assert.deepEqual(
      (await listFollowing(A)).map((edge) => edge.followingId).sort(),
      [B, "u-c"]
    );
    assert.deepEqual(await listFollowers(A), [], "A has no followers");
  });

  it("refuses to let anybody follow themselves", async () => {
    await people();
    await assert.rejects(() => followUser({ followerId: A, followingId: A }), /themselves/);
    assert.equal(await isFollowing(A, A), false);
  });
});

// Two ticks and a blue tick, without a write per message: each member keeps a
// watermark, and a message is delivered or read if it is older than the other
// person's mark. These cover the arithmetic of that and the two questions that
// decide whether a write happens at all.
describe("read and delivery receipts", () => {
  const A = "u-alice";
  const B = "u-bob";
  const CHAT = chatIdFor(A, B);

  const reload = () => JSON.parse(store.get(LS_KEY)).chats.find((c) => c.id === CHAT);

  /**
   * One chat with one message from A to B.
   *
   * The *stored* message, not what `sendMessage` returns: the data layer
   * deliberately hands back no `createdAt`, because the server stamp does not
   * exist yet at that moment and inventing one is the lie createOne documents
   * at length. The screen reads messages from `watchMessages`, which is this.
   */
  async function conversation(text = "сәлем") {
    await sendMessage({ senderId: A, recipientId: B, text });
    return { message: storedMessages().at(-1), chat: reload() };
  }

  const storedMessages = () =>
    JSON.parse(store.get(LS_KEY))[`chats/${CHAT}/messages`] ?? [];

  it("starts a message as sent — on the server, nowhere else", async () => {
    const { message, chat } = await conversation();
    assert.equal(messageStatus(message, chat, B), MESSAGE_STATUS.sent);
  });

  it("calls a message with no stamp yet pending, not sent", async () => {
    const { chat } = await conversation();
    // A local write whose serverTimestamp has not resolved. Claiming "sent"
    // here would show a tick for something that may still fail.
    assert.equal(messageStatus({ createdAt: null }, chat, B), MESSAGE_STATUS.pending);
  });

  it("turns two ticks grey once the other device has it", async () => {
    const { message } = await conversation();
    await markChatDelivered({ chatId: CHAT, userId: B });
    assert.equal(messageStatus(message, reload(), B), MESSAGE_STATUS.delivered);
  });

  it("turns them blue once they open the thread", async () => {
    const { message } = await conversation();
    await markChatDelivered({ chatId: CHAT, userId: B });
    await markChatRead({ chatId: CHAT, userId: B });
    assert.equal(messageStatus(message, reload(), B), MESSAGE_STATUS.read);
  });

  it("does not mark a newer message with an older receipt", async () => {
    await conversation();
    await markChatRead({ chatId: CHAT, userId: B });
    // B read the thread, then A says something else. The new message is not
    // covered by the old watermark — this is the case a per-chat boolean would
    // get wrong.
    await sendMessage({ senderId: A, recipientId: B, text: "тағы бір" });
    const second = storedMessages().at(-1);
    assert.equal(messageStatus(second, reload(), B), MESSAGE_STATUS.sent);
  });

  it("keeps each member's marks to themselves", async () => {
    await conversation();
    await markChatRead({ chatId: CHAT, userId: B });
    const chat = reload();
    assert.ok(chat.readAt?.[B] > 0);
    assert.equal(chat.readAt?.[A], undefined, "reading marked the other member too");
    // A's own unread was already zeroed by sending; B's is now cleared.
    assert.equal(chat.unread[B], 0);
  });

  it("asks for a read receipt when there is one owed, and not otherwise", async () => {
    const { chat } = await conversation();
    assert.equal(needsReadReceipt(chat, B), true, "unread message owes a receipt");
    await markChatRead({ chatId: CHAT, userId: B });
    assert.equal(needsReadReceipt(reload(), B), false, "receipt asked for twice");
  });

  it("owes a read receipt for a message that arrived while the thread was open", async () => {
    await conversation();
    await markChatRead({ chatId: CHAT, userId: B });
    // A millisecond of daylight between the read and what follows it. Both
    // stamps come from `Date.now()`, and `needsReadReceipt` asks whether the
    // message is *later* than the watermark — so a run fast enough to put them
    // in the same millisecond answered "no" and failed a test about something
    // else entirely. The wait is the test saying "afterwards", which is what it
    // meant all along.
    await new Promise((resolve) => { setTimeout(resolve, 2); });
    // B is sitting in the thread, so the counter never rises — but the sender
    // still has to see this one turn blue. The counter alone would miss it.
    await sendMessage({ senderId: A, recipientId: B, text: "көріп тұрсың ба?" });
    const chat = reload();
    chat.unread[B] = 0;                       // as the open screen leaves it
    assert.equal(needsReadReceipt(chat, B), true);
  });

  it("never owes a delivery receipt for your own message", async () => {
    const { chat } = await conversation();
    assert.equal(needsDeliveryReceipt(chat, A), false, "sender acknowledged themselves");
    assert.equal(needsDeliveryReceipt(chat, B), true);
    await markChatDelivered({ chatId: CHAT, userId: B });
    assert.equal(needsDeliveryReceipt(reload(), B), false);
  });
});

// "Online" is a heartbeat and a window, not a connection — see the presence
// note in firestore.js. What matters is that the window is honest at both ends.
describe("presence", () => {
  it("counts a fresh heartbeat as online", async () => {
    await createUserDoc({ id: "p1", email: "p1@e.com", nickname: "p1" });
    await touchPresence("p1");
    const user = await getUserById("p1");
    assert.equal(isOnline(user), true);
    assert.ok(lastSeenAt(user) > 0);
  });

  it("counts a stale one as offline, and says when they were here", async () => {
    const stamp = Date.now() - 10 * 60_000;
    const user = { lastActiveAt: stamp };
    assert.equal(isOnline(user), false);
    assert.equal(lastSeenAt(user), stamp);
  });

  it("survives one missed beat", async () => {
    // The window is wider than the interval on purpose: a phone in a tunnel
    // for thirty seconds has not left.
    assert.equal(isOnline({ lastActiveAt: Date.now() - 40_000 }), true);
  });

  it("says nothing about a profile that never reported", async () => {
    assert.equal(isOnline({}), false);
    assert.equal(lastSeenAt({}), 0);
    assert.equal(isOnline(null), false);
  });
});

// A book's history was already in the database — one `borrowings` row per read,
// never deleted — and nothing looked at it. These cover the query the Book
// Journey screen reads it with, whose one unusual property is its direction.
describe("book journey", () => {
  const BOOK = "b-journey";

  async function loan(borrowerId, { status = "completed", at = null } = {}) {
    const row = await createBorrowing({
      bookId: BOOK, borrowerId, ownerId: "u-owner", status: "active", pickupCode: "1234",
    });
    if (at !== null || status !== "active") {
      const db = JSON.parse(store.get(LS_KEY));
      const stored = db.borrowings.find((b) => b.id === row.id);
      if (at !== null) stored.createdAt = at;
      stored.status = status;
      store.set(LS_KEY, JSON.stringify(db));
    }
    return row;
  }

  it("reads oldest first — a journey, not a feed", async () => {
    await loan("u-third", { at: 3000 });
    await loan("u-first", { at: 1000 });
    await loan("u-second", { at: 2000 });

    const rows = await listBorrowingsForBook(BOOK);
    assert.deepEqual(rows.map((r) => r.borrowerId), ["u-first", "u-second", "u-third"]);
  });

  it("keeps other books' loans out of it", async () => {
    await loan("u-first", { at: 1000 });
    await createBorrowing({
      bookId: "b-other", borrowerId: "u-elsewhere", ownerId: "u-owner",
      status: "active", pickupCode: "9999",
    });

    const rows = await listBorrowingsForBook(BOOK);
    assert.deepEqual(rows.map((r) => r.borrowerId), ["u-first"]);
  });

  it("ends on the loan still open, when there is one", async () => {
    await loan("u-first", { at: 1000 });
    await loan("u-current", { at: 2000, status: "active" });

    const rows = await listBorrowingsForBook(BOOK);
    assert.equal(rows.at(-1).borrowerId, "u-current");
    assert.equal(rows.at(-1).status, "active");
  });

  it("caps a very well-travelled book", async () => {
    for (let i = 0; i < 5; i += 1) await loan("u-" + i, { at: 1000 + i });
    assert.equal((await listBorrowingsForBook(BOOK, { pageSize: 3 })).length, 3);
    assert.ok(BOOK_JOURNEY_MAX > 0);
  });

  it("says nothing about a book with no id", async () => {
    assert.deepEqual(await listBorrowingsForBook(null), []);
  });

  it("resolves the cast once each, and survives a deleted reader", async () => {
    await createUserDoc({ id: "u-a", email: "a@e.com", nickname: "reader_a" });
    await createUserDoc({ id: "u-b", email: "b@e.com", nickname: "reader_b" });

    // Duplicates collapse; a missing account resolves to null rather than
    // failing the batch, so its stop still renders.
    const people = await getUsersByIds(["u-a", "u-b", "u-a", "u-gone", null]);
    assert.deepEqual(Object.keys(people).sort(), ["u-a", "u-b", "u-gone"]);
    assert.equal(people["u-a"].nickname, "reader_a");
    assert.equal(people["u-gone"], null);
  });

  it("hands back a plain object, not a Map", async () => {
    // It is cached by React Query and persisted through a JSON serializer,
    // which turns a Map into `{}` — the bug that took the chat list down.
    await createUserDoc({ id: "u-a", email: "a@e.com", nickname: "reader_a" });
    const people = await getUsersByIds(["u-a"]);
    assert.equal(people instanceof Map, false);
    assert.deepEqual(JSON.parse(JSON.stringify(people)), people);
    assert.deepEqual(await getUsersByIds([]), {});
  });
});

describe("notifications", () => {
  it("comes back newest first and capped", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createNotification({ recipientId: "u1", title: `n${i}`, type: "test" });
      const db = JSON.parse(store.get(LS_KEY));
      db.notifications[i].createdAt = 1000 + i;
      store.set(LS_KEY, JSON.stringify(db));
    }
    const rows = await listNotifications("u1");
    assert.deepEqual(rows.map((n) => n.title), ["n4", "n3", "n2", "n1", "n0"]);
    assert.equal((await listNotifications("u1", 2)).length, 2);
  });
});

// The Home feed reads two things off a post that nothing used to guarantee were
// there: `isPublic`, which decides whether anybody outside the community can see
// it at all, and `likeCount`, which is the total every reader is shown. Both are
// now part of what a post is.
describe("posts", () => {
  const ADMIN = "admin-1";

  function newPost(over = {}) {
    return {
      communityId: COMMUNITY, authorId: ADMIN, authorName: "F L",
      isPublic: true, body: "Кітап оқимыз", ...over,
    };
  }

  it("is born with a visibility and a like total", async () => {
    const { id } = await createPost(newPost());
    const post = await getPost(id);
    assert.equal(post.isPublic, true);
    assert.equal(post.likeCount, 0, "a post nobody has liked has zero likes, not none");
  });

  it("refuses a post that does not say who may see it", async () => {
    // The create rule wants `isPublic` as a bool. Refusing it here names the
    // field; letting it through would mean a post that is silently invisible to
    // everyone outside the community, or a write the server rejects.
    await assert.rejects(() => createPost(newPost({ isPublic: undefined })), /isPublic/);
    await assert.rejects(() => createPost(newPost({ isPublic: "yes" })), /isPublic/);
    await assert.rejects(() => createPost(newPost({ body: "" })), /body/);
  });

  it("discovery returns every public post, newest first, and no private one", async () => {
    const open = await createPost(newPost({ body: "Ашық" }));
    const shut = await createPost(newPost({ communityId: "c2", isPublic: false, body: "Жабық" }));
    const later = await createPost(newPost({ communityId: "c3", body: "Кейінірек" }));
    backdatePost(open.id, 1000);
    backdatePost(shut.id, 2000);
    backdatePost(later.id, 3000);

    const rows = await listPublicPosts();
    assert.deepEqual(rows.map((p) => p.id), [later.id, open.id]);
  });

  it("a community's own board carries its private posts too", async () => {
    const shown = await createPost(newPost({ isPublic: false }));
    await createPost(newPost({ communityId: "c2" }));
    const rows = await listPostsByCommunity(COMMUNITY);
    assert.deepEqual(rows.map((p) => p.id), [shown.id]);
  });
});

describe("post likes", () => {
  const READER = "u-reader";
  let postId;

  beforeEach(async () => {
    await createUserDoc({ id: READER, email: "r@example.com", nickname: "reader" });
    const post = await createPost({
      communityId: COMMUNITY, authorId: "admin-1", authorName: "F L",
      isPublic: true, body: "Кітап оқимыз",
    });
    postId = post.id;
  });

  it("moves the profile and the shared total together", async () => {
    const { likedPostIds, likeDelta } = await togglePostLike({
      postId, userId: READER, likedPostIds: [], liked: true,
    });

    assert.deepEqual(likedPostIds, [postId]);
    assert.equal(likeDelta, 1);
    // The total is on the post, which is what makes it everybody's total rather
    // than the liker's — a second reader loading the feed sees this number.
    assert.equal((await getPost(postId)).likeCount, 1);
    assert.deepEqual((await getUserById(READER)).likedPostIds, [postId]);
  });

  it("counts every reader, not the last one", async () => {
    // Two people liking the same post is the case the old read-add-write lost:
    // both read 0, both wrote 1, and one like vanished with no error anywhere.
    await createUserDoc({ id: "u-other", email: "o@example.com", nickname: "other" });
    await togglePostLike({ postId, userId: READER, likedPostIds: [], liked: true });
    await togglePostLike({ postId, userId: "u-other", likedPostIds: [], liked: true });
    assert.equal((await getPost(postId)).likeCount, 2);
  });

  it("gives the like back on unlike", async () => {
    await togglePostLike({ postId, userId: READER, likedPostIds: [], liked: true });
    const { likedPostIds, likeDelta } = await togglePostLike({
      postId, userId: READER, likedPostIds: [postId], liked: false,
    });

    assert.deepEqual(likedPostIds, []);
    assert.equal(likeDelta, -1);
    assert.equal((await getPost(postId)).likeCount, 0);
    assert.deepEqual((await getUserById(READER)).likedPostIds, []);
  });

  it("never takes the total below zero", async () => {
    // A profile can claim a like the counter never recorded — a post from before
    // likes existed, or one whose total was lost to the race above. The rules
    // refuse a counter below zero, so there is nothing to subtract and the
    // reported delta says so.
    const { likeDelta } = await togglePostLike({
      postId, userId: READER, likedPostIds: [postId], liked: false,
    });
    assert.equal(likeDelta, 0);
    assert.equal((await getPost(postId)).likeCount, 0);
  });

  it("puts a repeat tap through as nothing at all", async () => {
    await togglePostLike({ postId, userId: READER, likedPostIds: [], liked: true });
    const again = await togglePostLike({
      postId, userId: READER, likedPostIds: [postId], liked: true,
    });
    assert.equal(again.changed, false);
    assert.equal((await getPost(postId)).likeCount, 1);
  });

  it("leaves the profile alone when the counter write is refused", async () => {
    // The two writes are one action. Leaving the like on the profile after the
    // total was refused is what used to make a like real to exactly one person.
    await assert.rejects(() => togglePostLike({
      postId: "no-such-post", userId: READER, likedPostIds: [], liked: true,
    }));
    assert.deepEqual((await getUserById(READER)).likedPostIds, []);
  });
});

// The fan-out that used to be N client writes from the Add-Book screen. What
// matters here is that every member gets exactly one copy, the sender is
// skipped, and the whole delivery is a single storage write rather than one
// per recipient.
describe("community fan-out", () => {
  async function seedMembers(n, communityId = COMMUNITY) {
    for (let i = 0; i < n; i += 1) {
      await createUserDoc({
        id: `m${i}`,
        firstName: `Member${i}`,
        lastName: "Test",
        nickname: `member${i}`,
        email: `m${i}@example.com`,
      });
      // Membership is a separate write from creation by design, so reach past
      // the normalizer the same way `backdate` does.
      const db = JSON.parse(store.get(LS_KEY));
      db.users.find((u) => u.id === `m${i}`).communityId = communityId;
      store.set(LS_KEY, JSON.stringify(db));
    }
  }

  it("delivers one notification per member and skips the sender", async () => {
    await seedMembers(4);

    const sent = await notifyCommunityMembers({
      communityId: COMMUNITY,
      excludeUserId: "m0",
      notification: { title: "New book", body: "War and Peace", type: "new-book", bookId: "b1" },
    });

    assert.equal(sent, 3, "sender should be excluded from the fan-out");
    assert.equal((await listNotifications("m0")).length, 0);
    for (const id of ["m1", "m2", "m3"]) {
      const rows = await listNotifications(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, "New book");
      assert.equal(rows[0].bookId, "b1", "extra fields survive normalization");
      assert.equal(rows[0].read, false, "a new notification is always unread");
    }
  });

  it("does not touch members of other communities", async () => {
    await seedMembers(2);
    await createUserDoc({
      id: "outsider", firstName: "Out", lastName: "Sider",
      nickname: "outsider", email: "out@example.com",
    });
    const db = JSON.parse(store.get(LS_KEY));
    db.users.find((u) => u.id === "outsider").communityId = "other-community";
    store.set(LS_KEY, JSON.stringify(db));

    await notifyCommunityMembers({
      communityId: COMMUNITY,
      notification: { title: "Scoped", type: "new-book" },
    });

    assert.equal((await listNotifications("outsider")).length, 0);
    assert.equal((await listNotifications("m0")).length, 1);
  });

  it("is a no-op for an empty community rather than an error", async () => {
    assert.equal(
      await notifyCommunityMembers({
        communityId: "ghost-town",
        notification: { title: "Nobody home", type: "new-book" },
      }),
      0
    );
  });

  it("writes the whole fan-out in one storage pass", async () => {
    await seedMembers(6);
    let writes = 0;
    const realSetItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (k, v) => { writes += 1; return realSetItem(k, v); };
    try {
      await notifyCommunityMembers({
        communityId: COMMUNITY,
        notification: { title: "Batched", type: "new-book" },
      });
    } finally {
      globalThis.localStorage.setItem = realSetItem;
    }
    assert.equal(writes, 1, "one write for six recipients, not one per recipient");
  });
});

// ── Reading sessions ─────────────────────────────────────────────────────────
// The one write in the data layer that lands in two places at once: an
// immutable row in `readingSessions`, and a folded aggregate on the reader's own
// profile. These cover the fold, because it is the half a screen actually reads
// and the half a bug in would be invisible until the weekly chart came out wrong.

describe("reading sessions", () => {
  async function seedReader(id = "r1") {
    await createUserDoc({ id, email: `${id}@e.com`, nickname: id });
    const db = JSON.parse(store.get(LS_KEY));
    db.users.find((u) => u.id === id).communityId = COMMUNITY;
    store.set(LS_KEY, JSON.stringify(db));
    return id;
  }

  it("writes a row and folds it into the reader's profile", async () => {
    const userId = await seedReader();
    const endedAt = Date.now();

    const { session, patch } = await logReadingSession({
      userId, communityId: COMMUNITY, seconds: 2_705, endedAt, readingDays: {},
    });

    // Seconds survive intact — the profile reports HH:MM:SS, so rounding to
    // whole minutes here would make that readout decorative.
    assert.equal(session.seconds, 2_705);
    assert.equal(session.dayKey, dayKey(new Date(endedAt)));
    // A session with no explicit start is stamped from its own length, never
    // after its end.
    assert.ok(session.startedAt <= session.endedAt);

    assert.equal(patch.readingSeconds, 2_705);
    assert.equal(patch.readingDays[session.dayKey], 2_705);

    const rows = await listReadingSessions({ userId });
    assert.equal(rows.length, 1);
    assert.equal((await getUserById(userId)).readingSeconds, 2_705);
  });

  it("accumulates two sittings on the same day", async () => {
    const userId = await seedReader();
    const first = await logReadingSession({ userId, seconds: 1_200, readingDays: {} });
    const second = await logReadingSession({
      userId, seconds: 1_505, readingDays: first.patch.readingDays,
    });

    assert.equal(second.patch.readingDays[second.session.dayKey], 2_705);
    assert.equal(second.patch.readingSeconds, 2_705);
    assert.equal((await listReadingSessions({ userId })).length, 2);
  });

  it("drops day entries that have aged out of the window", async () => {
    const userId = await seedReader();
    const stale = dayKey(new Date(Date.now() - 500 * 86_400_000));

    const { patch } = await logReadingSession({
      userId, seconds: 600, readingDays: { [stale]: 5_400 },
    });

    assert.equal(patch.readingDays[stale], undefined);
    assert.equal(patch.readingSeconds, 600, "the total follows the map it is summed from");
  });

  it("refuses a sitting too short to be reading", async () => {
    const userId = await seedReader();
    await assert.rejects(() => logReadingSession({ userId, seconds: 0 }));
    await assert.rejects(() => logReadingSession({ userId, seconds: 29 }));
    assert.equal((await listReadingSessions({ userId })).length, 0);
  });

  it("ranks a community by the trailing week, not by all-time reading", async () => {
    const today = dayKey();
    const ancient = dayKey(new Date(Date.now() - 30 * 86_400_000));

    // `d` has read far more in total than anybody, but none of it this week.
    const fixtures = [
      ["a", { [today]: 3_600 }],
      ["b", { [today]: 3_600 }],
      ["c", { [today]: 1_200 }],
      ["d", { [ancient]: 100_000 }],
    ];
    for (const [id, readingDays] of fixtures) {
      await seedReader(id);
      const db = JSON.parse(store.get(LS_KEY));
      db.users.find((u) => u.id === id).readingDays = readingDays;
      store.set(LS_KEY, JSON.stringify(db));
    }

    const rank = (id) => getCommunityReadingRank({ communityId: COMMUNITY, userId: id });
    assert.equal((await rank("a")).place, 1);
    assert.equal((await rank("b")).place, 1, "a tie shares the place");
    assert.equal((await rank("c")).place, 3, "and consumes the one after it");
    assert.equal((await rank("d")).place, 4, "an old total earns nothing this week");
    assert.equal((await rank("d")).total, 4);
    assert.equal(await rank("nobody"), null);
  });
});

// ── The week the profile reports on ──────────────────────────────────────────

describe("reading week", () => {
  const at = (daysAgo) => dayKey(new Date(Date.now() - daysAgo * 86_400_000));

  it("is seven days ending today, oldest first", () => {
    const week = buildReadingWeek({});
    assert.equal(week.days.length, 7);
    assert.equal(week.days[6].key, at(0));
    assert.equal(week.days[0].key, at(6));
    assert.equal(week.days[6].isToday, true);
  });

  it("counts only days inside the window", () => {
    const week = buildReadingWeek({ [at(0)]: 3_600, [at(6)]: 1_800, [at(7)]: 9_000 });
    assert.equal(week.totalSeconds, 5_400, "the eighth day back is outside the week");
    assert.equal(week.activeDays, 2);
  });

  it("scores a day against one hour, capped at 100%", () => {
    const week = buildReadingWeek({ [at(0)]: 7_200, [at(1)]: 1_800, [at(2)]: 900 });
    const byKey = Object.fromEntries(week.days.map((d) => [d.key, d.percent]));
    assert.equal(byKey[at(0)], 100, "two hours is still a full day, not 200%");
    assert.equal(byKey[at(1)], 50);
    assert.equal(byKey[at(2)], 25);
    assert.equal(byKey[at(3)], 0);
  });

  it("puts a week on the reader ladder", () => {
    const level = (hours) => readerLevel(hours * 3600);
    assert.equal(level(0).index, -1, "a week under three hours has not made the first rung");
    assert.equal(level(0).next.key, "levelBeginner");
    assert.equal(level(3).level.key, "levelBeginner");
    assert.equal(level(4.9).level.key, "levelBeginner");
    assert.equal(level(5).level.key, "levelCasual");
    assert.equal(level(7).level.key, "levelSteady");
    assert.equal(level(10).level.key, "levelActive");
    assert.equal(level(15).level.key, "levelAdvanced");
    assert.equal(level(40).level.key, "levelAdvanced", "the top rung is the top");
  });

  it("measures progress between the rung held and the next one", () => {
    // Halfway from Белсенді (10h) to Жоғары деңгейлі (15h).
    const mid = readerLevel(12.5 * 3600);
    assert.equal(mid.progress, 0.5);
    assert.equal(mid.targetSeconds, 15 * 3600);

    // Below the ladder, progress is measured from zero.
    assert.equal(readerLevel(1.5 * 3600).progress, 0.5);

    // At the top there is nothing left to fill toward.
    assert.equal(readerLevel(20 * 3600).progress, 1);
    assert.equal(readerLevel(20 * 3600).next, null);
  });

  it("formats the readout as HH:MM:SS", () => {
    assert.equal(formatDuration(11 * 3600 + 5 * 60 + 56), "11:05:56");
    assert.equal(formatDuration(0), "00:00:00");
    assert.equal(formatDuration(-5), "00:00:00");
  });
});

// ── Pickup requests ──────────────────────────────────────────────────────────
// Two invariants, and they are here rather than in a screen because a screen can
// be re-entered, double-tapped, or restored from a stale cache. The handoff code
// is announced only when a request is *created*, so "created at most once" is
// what makes "the code is sent at most once" true.

describe("pickup requests", () => {
  const READER = "reader-1";
  const base = (bookId) => ({
    bookId,
    bookName: `Book ${bookId}`,
    requesterId: READER,
    requesterName: "R Eader",
    loanDays: 7,
  });

  it("creates a request once and reuses it afterwards", async () => {
    const first = await openPickupRequest(base("b1"));
    assert.equal(first.created, true, "the first call opens the request");

    const second = await openPickupRequest(base("b1"));
    assert.equal(second.created, false, "reopening must not create a second one");
    assert.equal(second.request.id, first.request.id);

    // The whole point: one row, so one notification was ever justified.
    const all = await getCollection_requests();
    assert.equal(all.length, 1, "a duplicate pending request was written");
  });

  it("keeps the code that was already handed out", async () => {
    const first = await openPickupRequest({ ...base("b1"), pickupCode: "1234" });
    const second = await openPickupRequest({ ...base("b1"), pickupCode: "9999" });

    assert.equal(second.created, false);
    assert.equal(second.request.pickupCode, "1234",
      "reopening must not rotate the code the holder was already told");
    assert.equal(first.request.pickupCode, "1234");
  });

  it("refuses a second pickup while one is open on another book", async () => {
    await openPickupRequest(base("b1"));

    await assert.rejects(
      () => openPickupRequest(base("b2")),
      (err) => {
        assert.ok(err instanceof PickupBlockedError);
        assert.equal(err.reason, "other-pickup");
        assert.equal(err.bookId, "b1", "the blocker names the book in the way");
        return true;
      }
    );
    assert.equal((await getPickupRequest("b2", READER)), null, "nothing was written for b2");
  });

  it("frees the reader once the blocking request is closed", async () => {
    const { request } = await openPickupRequest(base("b1"));
    await assert.rejects(() => openPickupRequest(base("b2")));

    await cancelPickupRequest(request.id);
    assert.equal(await getPendingPickupForUser(READER), null);

    const next = await openPickupRequest(base("b2"));
    assert.equal(next.created, true);
  });

  it("frees the reader once the blocking request is fulfilled", async () => {
    const { request } = await openPickupRequest(base("b1"));
    await fulfillPickupRequest(request.id);
    assert.equal((await openPickupRequest(base("b2"))).created, true);
  });

  it("refuses a pickup while a different book is still on loan", async () => {
    await createBorrowing({ bookId: "b9", borrowerId: READER, ownerId: "someone" });

    await assert.rejects(
      () => openPickupRequest(base("b1")),
      (err) => {
        assert.equal(err.reason, "other-loan");
        assert.equal(err.bookId, "b9");
        return true;
      }
    );
  });

  it("still lets the reader collect the very book they have on loan", async () => {
    // Renewing the loan on a book already in hand is not a second errand.
    await createBorrowing({ bookId: "b1", borrowerId: READER, ownerId: "someone" });
    assert.equal((await openPickupRequest(base("b1"))).created, true);
  });

  it("scopes both rules to the requester", async () => {
    await openPickupRequest(base("b1"));
    const other = await openPickupRequest({ ...base("b1"), requesterId: "reader-2" });
    assert.equal(other.created, true, "another reader may ask for the same book");
    assert.equal((await getPendingPickupForUser("reader-3")), null);
  });
});

/** Every request row in the fallback store — the duplicate detector. */
async function getCollection_requests() {
  const db = JSON.parse(store.get(LS_KEY));
  return (db.requests || []).filter((r) => r.type === "pickup" && r.status === "pending");
}

// ─────────────────────────────────────────────────────────────────────────────
// Getting a book back — the handshake a member runs for every copy of theirs
// that is out before they can leave the community.
// ─────────────────────────────────────────────────────────────────────────────
describe("return requests", () => {
  const OWNER = "owner-1";
  const HOLDER = "holder-1";

  /** A book of OWNER's, sitting free on HOLDER's shelf. */
  async function bookWithHolder({ onLoan = false } = {}) {
    const { id } = await createBook({
      name: "Wild Apple", author: "Muratbekov", communityId: COMMUNITY,
      ownerId: OWNER, genres: ["fiction"], pages: 300,
    });
    await transferBookHolder({
      bookId: id, toUserId: HOLDER,
      borrowing: onLoan ? { bookName: "Wild Apple", communityId: COMMUNITY } : null,
    });
    if (!onLoan) {
      // Finished reading: still on their shelf, free for the next reader.
      await updateBook(id, { status: "available", borrowerId: null, holderId: HOLDER });
    }
    return id;
  }

  const open = (bookId) =>
    openReturnRequest({
      bookId, requesterId: OWNER, communityId: COMMUNITY, requesterName: "O Wner",
    });

  it("opens once, and reopening reuses the code already handed out", async () => {
    const bookId = await bookWithHolder();

    const first = await open(bookId);
    assert.equal(first.created, true);
    assert.equal(first.request.holderId, HOLDER, "the request names who to collect from");
    assert.match(first.request.returnCode, /^\d{4}$/);

    const second = await open(bookId);
    assert.equal(second.created, false, "a second call must not open a second request");
    assert.equal(second.request.returnCode, first.request.returnCode,
      "rotating the code here would strand the digits the holder was already told");
  });

  it("takes a free copy off the shelf, and puts it back when cancelled", async () => {
    const bookId = await bookWithHolder();

    const { request } = await open(bookId);
    assert.equal(request.reservedBook, true);
    const reserved = await getBook(bookId);
    assert.equal(reserved.status, "unavailable", "nobody else may start collecting it");
    assert.equal(reserved.borrowerId, null, "reserved is not the same as being read");
    assert.equal(reserved.holderId, HOLDER, "it has not moved — they still have it");

    await cancelReturnRequest(request.id);
    const freed = await getBook(bookId);
    assert.equal(freed.status, "available");
    assert.equal(freed.holderId, HOLDER);
    assert.equal(await getReturnRequest(bookId, OWNER), null);
  });

  it("does not pretend a book on loan is free when the request lapses", async () => {
    const bookId = await bookWithHolder({ onLoan: true });

    const { request } = await open(bookId);
    assert.equal(request.reservedBook, false, "an active loan was already occupied");

    await expireReturnRequest(request.id);
    const after = await getBook(bookId);
    assert.equal(after.status, "unavailable", "the reader still has it — it is not on the shelf");
    assert.equal(after.borrowerId, HOLDER);
  });

  it("brings the book home and closes any live loan", async () => {
    const bookId = await bookWithHolder({ onLoan: true });
    const { request } = await open(bookId);

    const result = await completeReturnToOwner({
      bookId, ownerId: OWNER, requestId: request.id,
    });
    assert.equal(result.alreadyHome, false);
    assert.ok(result.closedBorrowing, "the reader's loan cannot outlive the copy");
    assert.equal(await getActiveBorrowingByBook(bookId), null);

    const home = await getBook(bookId);
    assert.equal(home.holderId, OWNER);
    assert.equal(home.status, "available");
    assert.equal(home.borrowerId, null);
    assert.equal(await getReturnRequest(bookId, OWNER), null, "the request is spent");
  });

  it("closes the paperwork when the holder handed the book back themselves", async () => {
    const bookId = await bookWithHolder();
    const { request } = await open(bookId);

    // The holder returns it from their own shelf, with no code involved.
    await updateBook(bookId, { status: "available", borrowerId: null, holderId: OWNER });

    const result = await completeReturnToOwner({
      bookId, ownerId: OWNER, requestId: request.id,
    });
    assert.equal(result.alreadyHome, true);
    assert.equal(await getReturnRequest(bookId, OWNER), null);
  });

  it("refuses to open or complete a return for somebody else's book", async () => {
    const bookId = await bookWithHolder();

    await assert.rejects(
      () => openReturnRequest({ bookId, requesterId: "stranger", communityId: COMMUNITY }),
      /only the owner/
    );
    await assert.rejects(
      () => completeReturnToOwner({ bookId, ownerId: "stranger" }),
      /only the owner/
    );
  });

  it("has nothing to open for a book already with its owner", async () => {
    const { id } = await createBook({
      name: "At Home", author: "Auezov", communityId: COMMUNITY,
      ownerId: OWNER, genres: ["fiction"], pages: 300,
    });
    const result = await open(id);
    assert.equal(result.created, false);
    assert.equal(result.request, null, "a request against nobody is not an errand");
  });

  it("blocks a reader from collecting a copy that is going home", async () => {
    const bookId = await bookWithHolder();
    await open(bookId);

    await assert.rejects(
      () => openPickupRequest({
        bookId, bookName: "Wild Apple", requesterId: "reader-9", requesterName: "R", loanDays: 7,
      }),
      (err) => {
        assert.ok(err instanceof PickupBlockedError);
        assert.equal(err.reason, "returning");
        return true;
      }
    );
  });

  it("lets a member ask for several of their books back at once", async () => {
    // Unlike a pickup: leaving means collecting every copy, and serialising
    // that would mean three days per book.
    const first = await bookWithHolder();
    const second = await bookWithHolder();

    assert.equal((await open(first)).created, true);
    assert.equal((await open(second)).created, true);
    assert.equal((await listPendingReturnsForUser(OWNER)).length, 2);
    assert.ok(await getPendingReturnForBook({ bookId: second, communityId: COMMUNITY }));
  });

  // The same handover, offered from the other end. Handing a book home used to
  // be a single write with nobody on the other side of it; it is now the same
  // coded request an owner opens, which is what these tests are really about —
  // that the document is the same document.
  describe("offered by the holder", () => {
    const offer = (bookId) => offerReturnToOwner({ bookId, holderId: HOLDER });

    it("opens a return the owner's own screens can read", async () => {
      const bookId = await bookWithHolder();
      const { request, created } = await offer(bookId);

      assert.equal(created, true);
      assert.equal(request.type, "return");
      assert.equal(request.status, "pending");
      // `requesterId` is whoever collects — the owner, either way round. This
      // is what lets the owner's code screen find it by its usual query.
      assert.equal(request.requesterId, OWNER);
      assert.equal(request.holderId, HOLDER);
      assert.equal(request.openedBy, "holder");
      assert.match(request.returnCode, /^\d{4}$/);

      assert.ok(await getReturnRequest(bookId, OWNER), "the owner must be able to find it");
    });

    it("blocks a pickup on the copy, exactly as the owner's own request does", async () => {
      const bookId = await bookWithHolder();
      await offer(bookId);
      assert.ok(await getPendingReturnForBook({ bookId, communityId: COMMUNITY }));
    });

    it("is idempotent, and never mints a second code for one handover", async () => {
      const bookId = await bookWithHolder();
      const first = await offer(bookId);
      const second = await offer(bookId);

      assert.equal(second.created, false);
      assert.equal(second.request.id, first.request.id);
      assert.equal(second.request.returnCode, first.request.returnCode);
    });

    it("defers to a return the owner already opened", async () => {
      // Two codes for one handover is one code that does not work.
      const bookId = await bookWithHolder();
      const owners = await open(bookId);
      const offered = await offer(bookId);

      assert.equal(offered.created, false);
      assert.equal(offered.request.id, owners.request.id);
      assert.equal(offered.request.returnCode, owners.request.returnCode);
    });

    it("is a no-op on a book already with its owner", async () => {
      const { id } = await createBook({
        name: "At Home", author: "Nobody", communityId: COMMUNITY,
        ownerId: OWNER, genres: ["fiction"], pages: 300,
      });
      const result = await offerReturnToOwner({ bookId: id, holderId: OWNER });
      assert.equal(result.alreadyHome, true);
      assert.equal(result.request, null);
    });

    it("refuses somebody who is not holding the book", async () => {
      const bookId = await bookWithHolder();
      await assert.rejects(
        () => offerReturnToOwner({ bookId, holderId: "someone-else" }),
        /holder/
      );
    });

    it("is listed to the holder, who cannot find it by requesterId", async () => {
      // The leave screen's second list. A return names its collector in
      // `requesterId`, so the query the leave screen already had was blind to
      // exactly the errands its own rules block on.
      const bookId = await bookWithHolder();
      await offer(bookId);

      assert.deepEqual(
        (await listPendingReturnsForUser(HOLDER)).map((r) => r.bookId),
        [],
        "the holder is not the collector, so this query must not find it"
      );
      assert.deepEqual(
        (await listPendingReturnsForHolder({ holderId: HOLDER, communityId: COMMUNITY }))
          .map((r) => r.bookId),
        [bookId]
      );
      // And the owner still finds it as the collector — one document, two views.
      assert.deepEqual(
        (await listPendingReturnsForUser(OWNER)).map((r) => r.bookId),
        [bookId]
      );
    });

    it("completes through the same call the owner's own return does", async () => {
      const bookId = await bookWithHolder({ onLoan: true });
      const { request } = await offer(bookId);

      const { book, closedBorrowing } = await completeReturnToOwner({
        bookId, ownerId: OWNER, requestId: request.id,
      });

      assert.equal(book.holderId, OWNER);
      assert.equal(book.status, "available");
      assert.equal(book.borrowerId, null);
      assert.ok(closedBorrowing, "the live loan is closed by the handover");
      assert.equal(await getPendingReturnForBook({ bookId, communityId: COMMUNITY }), null);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E.164 — the one format an SMS gateway accepts, and the format the ID token
// hands back for the security rules to compare against.
// ─────────────────────────────────────────────────────────────────────────────
describe("phone numbers in E.164", () => {
  it("keeps an international number as it was typed", () => {
    assert.equal(toE164("+7 (777) 123-45-67"), "+77771234567");
    assert.equal(toE164("+44 20 7123 4567"), "+442071234567");
  });

  it("drops the trunk prefix people dial locally", () => {
    assert.equal(toE164("8 777 123 45 67"), "+77771234567");
  });

  it("adds the default country code to a bare national number", () => {
    assert.equal(toE164("777 123 45 67"), "+77771234567");
  });

  it("refuses what cannot be a number", () => {
    for (const bad of ["", "   ", "12345", "abc", "+", "1".repeat(16)]) {
      assert.equal(toE164(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("never guesses a country code for a number that named one", () => {
    // A member abroad types their own code; inventing one would send the code
    // to a stranger's phone.
    assert.equal(toE164("+1 202 555 0142"), "+12025550142");
  });

  it("agrees with isE164 about what it produces", () => {
    for (const raw of ["+7 777 123 45 67", "87771234567", "7771234567"]) {
      assert.equal(isE164(toE164(raw)), true, raw);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proving a phone number over Telegram.
//
// The client's whole part is an attempt document and a link; the profile write
// belongs to the webhook. `simulateBotConfirmation` is what stands in for that
// webhook where there is no Firebase — and it makes the same comparison, so
// these exercise the decision the real one makes.
// ─────────────────────────────────────────────────────────────────────────────
describe("phone verification over Telegram", () => {
  const USER = "u-verify";
  const CLAIM = "+77771234567";

  beforeEach(async () => {
    botConfig.telegramBot = "@oqunet_bot";
    store.set("oqunet:auth", JSON.stringify({ uid: USER }));
    await createUserDoc({
      id: USER, email: "v@example.com", nickname: "verifier",
      firstName: "V", lastName: "R",
    });
  });

  it("mints an unguessable token and the exact text the bot expects", () => {
    const a = newVerificationToken();
    const b = newVerificationToken();
    assert.match(a, /^[A-Z2-9]{12}$/);
    assert.notEqual(a, b, "two tokens in a row must not collide");
    assert.equal(verificationPayload(a), `VERIFY_${a}`);
  });

  it("builds the deep link, and none when nobody configured a bot", () => {
    // The `@` is optional in the environment variable and must not survive
    // into the URL — `t.me/@bot` is a 404.
    assert.equal(
      verificationLink("ABC123"),
      "https://t.me/oqunet_bot?start=VERIFY_ABC123"
    );
    assert.equal(verificationAvailable(), true);

    botConfig.telegramBot = "";
    assert.equal(verificationLink("ABC123"), null);
    assert.equal(verificationAvailable(), false);
  });

  it("opens an attempt that claims a number and proves nothing", async () => {
    const started = await startPhoneVerification({
      userId: USER, phone: "8 777 123 45 67", token: newVerificationToken(),
    });
    assert.equal(started.attempt.phone, CLAIM, "stored in E.164, whatever was typed");
    assert.equal(started.attempt.status, "pending");
    assert.ok(started.attempt.expiresAt > Date.now());

    const user = await getUserById(USER);
    assert.equal(user.phone, "", "a claim is not a verification");
    assert.equal(user.phoneVerifiedAt, null);
  });

  it("refuses a number that cannot be dialled, and a deploy with no bot", async () => {
    await assert.rejects(() => startPhoneVerification({
      userId: USER, phone: "12345", token: newVerificationToken(),
    }));
    botConfig.telegramBot = "";
    await assert.rejects(() => startPhoneVerification({
      userId: USER, phone: CLAIM, token: newVerificationToken(),
    }));
  });

  it("verifies when the message comes from the number that was claimed", async () => {
    const { token } = await startPhoneVerification({
      userId: USER, phone: CLAIM, token: newVerificationToken(),
    });
    const resolved = await simulateBotConfirmation(token, { fromPhone: CLAIM });
    assert.equal(resolved.status, "verified");

    const user = await getUserById(USER);
    assert.equal(user.phone, CLAIM);
    assert.ok(user.phoneVerifiedAt > 0);
    assert.equal(hasVerifiedPhone(user), true);
  });

  it("refuses when the message comes from a different number", async () => {
    // The check the whole design exists for: otherwise anyone could claim any
    // number and message us from their own.
    const { token } = await startPhoneVerification({
      userId: USER, phone: CLAIM, token: newVerificationToken(),
    });
    const resolved = await simulateBotConfirmation(token, { fromPhone: "+77019999999" });
    assert.equal(resolved.status, "mismatch");

    const user = await getUserById(USER);
    assert.equal(user.phone, "", "a mismatch must leave the profile untouched");
    assert.equal(user.phoneVerifiedAt, null);
  });

  it("knows when an attempt has run out its window", async () => {
    const attempt = { status: "pending", expiresAt: Date.now() - 1 };
    assert.equal(isVerificationExpired(attempt), true);
    assert.equal(isVerificationExpired({ ...attempt, expiresAt: Date.now() + 60000 }), false);
    assert.equal(isVerificationExpired({ status: "verified", expiresAt: 1 }), false);
  });

  it("lets the member abandon their own attempt", async () => {
    const { token } = await startPhoneVerification({
      userId: USER, phone: CLAIM, token: newVerificationToken(),
    });
    await abandonVerification(token);
    const attempt = await getPhoneVerification(token);
    assert.equal(attempt.status, "cancelled");
    assert.equal(readPendingVerification(), null);
  });
});
