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

const {
  createBook, listBooks, listNewBooks, listBooksHeldBy, listBooksOwnedBy,
  updateBook, getBook, createNotification, listNotifications,
  createUserDoc, getUserById, notifyCommunityMembers,
  logReadingSession, listReadingSessions, getCommunityReadingRank,
  openPickupRequest, getPickupRequest, getPendingPickupForUser,
  cancelPickupRequest, fulfillPickupRequest, createBorrowing, PickupBlockedError,
  NEW_BOOK_WINDOW_DAYS,
} = await import("../src/firebase/firestore.js");

const {
  buildReadingWeek, dayKey, formatDuration, readerLevel,
} = await import("../src/utils/readingProgress.js");

const LS_KEY = "oqunet:db";
const DAY = 86_400_000;
const COMMUNITY = "c1";

/** Backdate a stored book — createOne owns createdAt, so reach past it. */
function backdate(id, ms) {
  const db = JSON.parse(store.get(LS_KEY));
  db.books.find((b) => b.id === id).createdAt = ms;
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
      maxDays: 14,
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
