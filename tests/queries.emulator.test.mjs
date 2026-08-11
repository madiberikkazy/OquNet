// Exercises the exact query shapes listBooks/listNewBooks now build, against a
// real Firestore. Run with:
//   firebase emulators:exec --only firestore --project demo-oqunet-idx \
//     'node --test <this file>'
//
// The point is the things reading the code cannot settle: whether Firestore
// accepts `array-contains` alongside `in` alongside an `orderBy`, and whether
// snapshot cursors page cleanly.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  Timestamp, collection, doc, getDocs, limit, orderBy, query, setDoc,
  startAfter, where, writeBatch, serverTimestamp,
} from "firebase/firestore";

import { searchPrefixes, searchTerm } from "../src/utils/search.js";

const PROJECT_ID = "demo-oqunet-idx";
const COMMUNITY = "c1";
const DAY = 86_400_000;
const NEW_BOOK_WINDOW_DAYS = 10;

const GENRES = ["fiction", "history", "science", "poetry"];
const TITLES = [
  "War and Peace", "Anna Karenina", "Abai Zholy", "Sapiens", "Wuthering Heights",
  "The Hobbit", "Dune", "Neuromancer", "Wolf Hall", "The Waves",
];
const AUTHORS = ["Tolstoy", "Auezov", "Harari", "Bronte", "Tolkien", "Herbert"];

let testEnv;
let db;
const seeded = []; // { id, createdAtMs, genre, status, name, author }

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      // Queries, not rules, are under test here.
      rules: "rules_version='2';service cloud.firestore{match /databases/{d}/documents{match /{p=**}{allow read,write:if true;}}}",
    },
  });
  await testEnv.clearFirestore();
  db = testEnv.unauthenticatedContext().firestore();

  // 35 books, distinct createdAt one hour apart so ordering is unambiguous.
  const now = Date.now();
  for (let i = 0; i < 35; i += 1) {
    const name = `${TITLES[i % TITLES.length]} ${i}`;
    const author = AUTHORS[i % AUTHORS.length];
    // Half inside the 10-day "new" window, half well outside it.
    const createdAtMs = now - (i < 12 ? i * 3600_000 : (20 + i) * DAY);
    const book = {
      communityId: COMMUNITY,
      name,
      author,
      genre: GENRES[i % GENRES.length],
      genres: [GENRES[i % GENRES.length]],
      status: i % 3 === 0 ? "unavailable" : "available",
      ownerId: `u${i % 4}`,
      holderId: `u${i % 4}`,
      searchPrefixes: searchPrefixes(name, author),
      createdAt: Timestamp.fromMillis(createdAtMs),
    };
    const id = `b${String(i).padStart(3, "0")}`;
    await setDoc(doc(db, "books", id), book);
    seeded.push({ id, createdAtMs, ...book });
  }
});

after(async () => { await testEnv?.cleanup(); });

/** The constraint list listBooks builds, for a given filter set. */
function bookConstraints({ status, genres, search }) {
  const cs = [where("communityId", "==", COMMUNITY)];
  if (status) cs.push(where("status", "==", status));
  if (genres?.length) cs.push(where("genre", "in", genres));
  const term = searchTerm(search);
  if (term) cs.push(where("searchPrefixes", "array-contains", term));
  cs.push(orderBy("createdAt", "desc"));
  return cs;
}

async function runPaged(filters, pageSize) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const cs = [...bookConstraints(filters)];
    if (cursor) cs.push(startAfter(cursor));
    cs.push(limit(pageSize));
    const snap = await getDocs(query(collection(db, "books"), ...cs));
    pages.push(snap.docs.map((d) => d.id));
    if (snap.docs.length < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return pages;
}

describe("listBooks query shapes", () => {
  it("pages through the whole shelf with no gaps and no duplicates", async () => {
    const pages = await runPaged({}, 10);
    const ids = pages.flat();
    assert.equal(ids.length, 35, `expected 35 ids, got ${ids.length}`);
    assert.equal(new Set(ids).size, 35, "duplicate ids across pages");

    const expected = [...seeded]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((b) => b.id);
    assert.deepEqual(ids, expected, "page order does not match createdAt desc");
  });

  it("the old cursor — a plain object, no orderBy — really does throw", async () => {
    await assert.rejects(
      async () => {
        const rows = await getDocs(query(
          collection(db, "books"),
          where("communityId", "==", COMMUNITY),
          limit(5)
        ));
        const plain = { id: rows.docs[0].id, ...rows.docs[0].data() };
        await getDocs(query(
          collection(db, "books"),
          where("communityId", "==", COMMUNITY),
          startAfter(plain),
          limit(5)
        ));
      },
      /Too many arguments provided to startAfter/
    );
  });

  it("filters by status server-side", async () => {
    const ids = (await runPaged({ status: "available" }, 10)).flat();
    const expected = seeded.filter((b) => b.status === "available").map((b) => b.id);
    assert.equal(ids.length, expected.length);
    assert.deepEqual(new Set(ids), new Set(expected));
  });

  it("filters by multiple genres with `in`", async () => {
    const genres = ["fiction", "poetry"];
    const ids = (await runPaged({ genres }, 10)).flat();
    const expected = seeded.filter((b) => genres.includes(b.genre)).map((b) => b.id);
    assert.equal(ids.length, expected.length);
    assert.deepEqual(new Set(ids), new Set(expected));
  });

  it("finds books by a title prefix", async () => {
    const ids = (await runPaged({ search: "wuth" }, 10)).flat();
    assert.ok(ids.length > 0, "prefix search returned nothing");
    for (const id of ids) {
      const b = seeded.find((x) => x.id === id);
      assert.match(b.name.toLowerCase(), /wuth/);
    }
  });

  it("finds books by an author prefix", async () => {
    const ids = (await runPaged({ search: "tolst" }, 10)).flat();
    const expected = seeded.filter((b) => b.author === "Tolstoy").map((b) => b.id);
    assert.deepEqual(new Set(ids), new Set(expected));
  });

  it("accepts array-contains + in + equality + orderBy in ONE query", async () => {
    // The combination the whole design rests on. If Firestore rejects it, the
    // eight composite indexes are pointless and search must be split out.
    const cs = bookConstraints({
      status: "available",
      genres: ["fiction", "history", "science"],
      search: "tolkien",
    });
    const snap = await getDocs(query(collection(db, "books"), ...cs, limit(10)));
    for (const d of snap.docs) {
      const b = d.data();
      assert.equal(b.status, "available");
      assert.ok(["fiction", "history", "science"].includes(b.genre));
      assert.ok(b.searchPrefixes.includes("tolkien"));
    }
    assert.ok(snap.docs.length > 0, "combined query matched nothing — check the fixture");
  });
});

describe("listNewBooks query shape", () => {
  it("returns only books inside the window, newest first, capped at 10", async () => {
    const cutoff = Date.now() - NEW_BOOK_WINDOW_DAYS * DAY;
    const snap = await getDocs(query(
      collection(db, "books"),
      where("communityId", "==", COMMUNITY),
      where("createdAt", ">=", Timestamp.fromMillis(cutoff)),
      orderBy("createdAt", "desc"),
      limit(10)
    ));

    assert.ok(snap.docs.length <= 10);
    const ms = snap.docs.map((d) => d.data().createdAt.toMillis());
    for (const t of ms) assert.ok(t >= cutoff, "a book older than the window came back");
    assert.deepEqual(ms, [...ms].sort((a, b) => b - a), "not newest-first");

    // The ten newest overall are all inside the window in this fixture, so the
    // query must return exactly them — this is what the old unordered
    // scan-and-sort could not guarantee.
    const expected = [...seeded]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, 10)
      .map((b) => b.id);
    assert.deepEqual(snap.docs.map((d) => d.id), expected);
  });
});

// The batched notification fan-out in `notifyCommunityMembers`.
//
// That function cannot be imported here: under Node the config module is
// stubbed with `isFirebaseConfigured = false`, so its Firestore branch is
// unreachable from a test process. What this suite pins instead are the two
// facts that branch is built on and that reading the code cannot settle —
// whether 500 is really the per-batch ceiling, and whether committing several
// batches in sequence lands every document.
describe("notification fan-out batching", () => {
  const FAN_OUT_BATCH_MAX = 500; // must match firestore.js

  /** Mirrors the commit loop in notifyCommunityMembers. */
  async function fanOut(recipientIds, coll) {
    for (let i = 0; i < recipientIds.length; i += FAN_OUT_BATCH_MAX) {
      const batch = writeBatch(db);
      for (const recipientId of recipientIds.slice(i, i + FAN_OUT_BATCH_MAX)) {
        batch.set(doc(collection(db, coll)), {
          recipientId, title: "New book", type: "new-book", read: false,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  it("commits a full 500-document batch", async () => {
    const batch = writeBatch(db);
    for (let i = 0; i < FAN_OUT_BATCH_MAX; i += 1) {
      batch.set(doc(collection(db, "fanout_ceiling")), { i });
    }
    await batch.commit();
    const snap = await getDocs(collection(db, "fanout_ceiling"));
    assert.equal(snap.size, FAN_OUT_BATCH_MAX, "500 is not accepted as a batch size");
  });

  // Recorded rather than asserted, because it surprised us: the emulator does
  // NOT refuse an oversized batch. 501 writes commit cleanly here.
  //
  // So the chunking in `notifyCommunityMembers` is defensive against the
  // *documented* production limit (500 operations per commit), not against
  // something this suite can demonstrate. Two consequences worth knowing:
  // an oversized batch would sail through local testing and only fail against
  // the real backend, and this test cannot be turned into a regression guard
  // for the chunking. Keep FAN_OUT_BATCH_MAX at 500 on the documentation's
  // authority — do not "verify" it by raising it until the emulator complains.
  it("does not enforce the 500 ceiling locally (emulator leniency, documented)", async () => {
    const batch = writeBatch(db);
    for (let i = 0; i < FAN_OUT_BATCH_MAX + 1; i += 1) {
      batch.set(doc(collection(db, "fanout_overflow")), { i });
    }
    await batch.commit();
    const snap = await getDocs(collection(db, "fanout_overflow"));
    assert.equal(
      snap.size, FAN_OUT_BATCH_MAX + 1,
      "emulator started enforcing the batch ceiling — update this comment"
    );
  });

  it("delivers every document across multiple batches", async () => {
    // 1,203 members: two full batches plus a partial one, so an off-by-one in
    // the slice would drop or duplicate documents.
    const recipients = Array.from({ length: 1203 }, (_, i) => `u${i}`);
    await fanOut(recipients, "fanout_many");

    const snap = await getDocs(collection(db, "fanout_many"));
    assert.equal(snap.size, 1203, "chunked fan-out lost or duplicated documents");
    const ids = snap.docs.map((d) => d.data().recipientId);
    assert.equal(new Set(ids).size, 1203, "a recipient was notified twice");
  });

  it("keeps each recipient's inbox queryable after a batched write", async () => {
    const snap = await getDocs(query(
      collection(db, "fanout_many"),
      where("recipientId", "==", "u742")
    ));
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].data().read, false);
  });
});

// The four-equality-clause shapes the return handshake queries with. Firestore
// serves these by merging the single-field indexes it maintains anyway — the
// point of asserting it here is that none of them needs an entry in
// firestore.indexes.json, which is the thing reading the code cannot settle.
describe("return request query shapes", () => {
  const OWNER = "owner-1";
  const BOOK = "book-r1";

  before(async () => {
    await setDoc(doc(db, "requests", "ret-1"), {
      type: "return", status: "pending", bookId: BOOK, communityId: COMMUNITY,
      requesterId: OWNER, holderId: "holder-1", returnCode: "1234",
      reservedBook: true, createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "requests", "ret-2"), {
      type: "return", status: "fulfilled", bookId: "book-r2", communityId: COMMUNITY,
      requesterId: OWNER, holderId: "holder-2", returnCode: "5678",
      reservedBook: false, createdAt: serverTimestamp(),
    });
  });

  it("finds one owner's open return on one book", async () => {
    const snap = await getDocs(query(
      collection(db, "requests"),
      where("requesterId", "==", OWNER),
      where("type", "==", "return"),
      where("status", "==", "pending"),
      where("bookId", "==", BOOK),
    ));
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].id, "ret-1");
  });

  it("answers 'is this copy going home?' scoped by community", async () => {
    const snap = await getDocs(query(
      collection(db, "requests"),
      where("communityId", "==", COMMUNITY),
      where("type", "==", "return"),
      where("status", "==", "pending"),
      where("bookId", "==", BOOK),
    ));
    assert.equal(snap.size, 1);
  });

  it("lists every return one member has open, and only the open ones", async () => {
    const snap = await getDocs(query(
      collection(db, "requests"),
      where("requesterId", "==", OWNER),
      where("type", "==", "return"),
      where("status", "==", "pending"),
    ));
    assert.deepEqual(snap.docs.map((d) => d.id), ["ret-1"]);
  });
});
