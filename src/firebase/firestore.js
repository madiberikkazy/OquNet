// Firestore data layer with a transparent localStorage fallback.
// Collections: users, communities, books, posts, notifications, requests, borrowings, ratings, reviews

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, serverTimestamp, Timestamp, writeBatch,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "./config.js";
import { logger } from "../utils/logger.js";
import { aggregateFromRatings } from "../utils/rating.js";
import { holderIdOf } from "../utils/bookHolder.js";
import { searchTerm } from "../utils/search.js";
import {
  bookSearchFields,
  normalizeNewBook, normalizeBookPatch, normalizeBookOwner, normalizeNewBorrowing,
  normalizeNewCommunity, normalizeCommunityPatch, normalizePostPatch,
  normalizeJoinRequest, normalizeReturnRequest, newPickupCode,
  normalizeNewNotification, normalizeNewUser, normalizeRating,
  normalizeNewReadingSession, normalizeReadingProgress,
  stripServerOwned,
} from "./schema.js";
import { rankByWeeklyReading } from "../utils/readingProgress.js";

// Document shape is schema.js's job, and every write below goes through it.
// `toMillis` is re-exported so a screen reading a stored timestamp reaches for
// the same helper the data layer wrote it with, without a second import.
export { toMillis } from "../utils/time.js";
export { SchemaError } from "./schema.js";

// Wraps a Firestore operation. Re-throws so callers can decide what to do,
// but always logs the failure first so it doesn't get swallowed silently.
async function runFs(scope, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`firestore.${scope}`, err?.message || "unknown error", {
      code: err?.code,
    });
    throw err;
  }
}

// ---------- localStorage fallback ----------
const LS_KEY = "oqunet:db";
function emptyDb() {
  return {
    users: [], usernames: [], communities: [], books: [], posts: [],
    notifications: [], requests: [], borrowings: [], ratings: [], reviews: [],
    readingSessions: [],
  };
}
function readLS() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    return raw ? (JSON.parse(raw) || emptyDb()) : emptyDb();
  } catch (err) {
    logger.warn("firestore.readLS", err?.message);
    return emptyDb();
  }
}
function writeLS(data) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }
  } catch (err) {
    // Quota-exceeded is the most common cause; rethrow so the caller's
    // try/catch can surface a user-visible error instead of silently dropping.
    logger.error("firestore.writeLS", err?.message);
    throw err;
  }
}
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---------- Generic helpers ----------
//
// ── Paging, and why the cursor is opaque ─────────────────────────────────────
// Firestore continues a query from a `DocumentQuerySnapshot`, not from a value
// the caller invented: `startAfter()` reads the ordered field values back out
// of that snapshot. Handing it a plain object instead throws outright — the SDK
// compares the argument count against `explicitOrderBy`, so a cursor on a query
// with no `orderBy` is rejected before it ever reaches the server. Two rules
// fall out of that, and both are enforced below rather than left to callers:
//
//   1. A cursor is only meaningful alongside an `orderBy`. Asking for one
//      without is a programming error, not a query that returns page one.
//   2. The cursor a caller holds is whatever `getPage` handed back and nothing
//      else. It is a snapshot in Firestore mode and a `{ value, id }` pair in
//      localStorage mode; no caller may look inside it or construct one.

/** Milliseconds as a `createdAt` bound of whichever type the current mode stores. */
function atMillis(ms) {
  return isFirebaseConfigured ? Timestamp.fromMillis(ms) : ms;
}

/** `[">=", "<="]` clauses matching every value of `field` starting with `term`. */
const PREFIX_CEILING = "\uf8ff";
function prefixRange(field, term) {
  // U+F8FF is the last code point of the Private Use Area, so it sorts after
  // any character a title or nickname will contain — the standard way to bound
  // a prefix scan in Firestore, since there is no "starts-with" operator.
  return [[field, ">=", term], [field, "<=", term + PREFIX_CEILING]];
}

/** Ordering for the localStorage branch: numbers, strings and missing values. */
function compareValues(a, b) {
  const av = a === undefined ? null : a;
  const bv = b === undefined ? null : b;
  if (av === bv) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  return av < bv ? -1 : 1;
}

/**
 * One page of a collection, plus the cursor that continues it.
 *
 * The return shape is `{ rows, cursor }` rather than a bare array because the
 * cursor cannot be reconstructed from `rows`: it is the underlying document
 * snapshot, which `rows` has already been flattened out of. `getCollection`
 * below is the unpaged shorthand and shares this implementation exactly, so the
 * two can never drift.
 *
 * `cursor` is null when the page is empty or the query is unordered — in both
 * cases there is nothing a caller could legitimately do with one.
 */
async function getPage(name, { where: wheres = [], orderByField, descending = false, pageSize, cursor } = {}) {
  if (cursor && !orderByField) {
    throw new Error(`getPage(${name}): a cursor requires an orderBy to page along`);
  }

  if (isFirebaseConfigured) {
    const constraints = wheres.map(([f, op, v]) => where(f, op, v));
    if (orderByField) constraints.push(orderBy(orderByField, descending ? "desc" : "asc"));
    if (cursor) constraints.push(startAfter(cursor));
    if (pageSize) constraints.push(limit(pageSize));
    const snap = await getDocs(query(collection(db, name), ...constraints));
    const last = snap.docs[snap.docs.length - 1];
    return {
      rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      cursor: orderByField && last ? last : null,
    };
  }

  const data = readLS();
  let rows = data[name] || [];
  wheres.forEach(([f, op, v]) => {
    rows = rows.filter((r) => {
      if (op === "==") return r[f] === v;
      if (op === "!=") return r[f] !== v;
      if (op === ">=") return r[f] >= v;
      if (op === "<=") return r[f] <= v;
      if (op === "in") return v.includes(r[f]);
      if (op === "array-contains") return Array.isArray(r[f]) && r[f].includes(v);
      return true;
    });
  });

  if (!orderByField) {
    return { rows: pageSize ? rows.slice(0, pageSize) : rows, cursor: null };
  }

  // Firestore breaks ties on the document id, in the same direction as the last
  // explicit orderBy. Mirroring that is what makes a page boundary here land
  // where it would land against the real thing.
  const dir = descending ? -1 : 1;
  const compareRows = (a, b) =>
    dir * (compareValues(a[orderByField], b[orderByField]) || compareValues(a.id, b.id));

  rows = [...rows].sort(compareRows);

  if (cursor) {
    // Positional by value rather than by id, so a document deleted mid-paging
    // does not reset the caller to page one — same as `startAfter(snapshot)`.
    const start = rows.findIndex(
      (r) => compareRows(r, { [orderByField]: cursor.value, id: cursor.id }) > 0
    );
    rows = start === -1 ? [] : rows.slice(start);
  }
  if (pageSize) rows = rows.slice(0, pageSize);

  const last = rows[rows.length - 1];
  return {
    rows,
    cursor: last ? { value: last[orderByField] ?? null, id: last.id } : null,
  };
}

/** A whole (or capped) result set, for the queries that do not page. */
async function getCollection(name, options) {
  return (await getPage(name, options)).rows;
}

async function getOne(name, id) {
  if (!id) return null;
  return runFs(`getOne.${name}`, async () => {
    if (isFirebaseConfigured) {
      const snap = await getDoc(doc(db, name, id));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
    const data = readLS();
    return (data[name] || []).find((r) => r.id === id) || null;
  });
}

/**
 * Create a document. The data layer owns `createdAt` outright: a caller may not
 * pass one, and one that slips through is stripped rather than merged.
 *
 * It has to work this way. The security rules require `createdAt == request.time`
 * on the collections that constrain it at all, so the stored value can only ever
 * be the server's — and the old arrangement, where the caller's `Date.now()` was
 * overwritten in Firestore but won in the localStorage fallback, meant the two
 * modes disagreed about what a document said the moment it was born.
 *
 * The returned object carries no `createdAt` for the same reason. There is no
 * honest value to put there: the server resolves `serverTimestamp()` after this
 * call returns, and reporting the client clock instead is precisely the lie this
 * change removes. Re-read the document when you need the stamp.
 */
async function createOne(name, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("createOne: payload must be an object");
  }
  const fields = stripServerOwned(name, payload);
  return runFs(`createOne.${name}`, async () => {
    if (isFirebaseConfigured) {
      if (fields.id) {
        await setDoc(doc(db, name, fields.id), { ...fields, createdAt: serverTimestamp() });
        return { ...fields };
      }
      const ref = await addDoc(collection(db, name), { ...fields, createdAt: serverTimestamp() });
      return { id: ref.id, ...fields };
    }
    const data = readLS();
    const record = { ...fields, id: fields.id || uid(), createdAt: Date.now() };
    data[name] = data[name] || [];
    data[name].push(record);
    writeLS(data);
    // Same shape the Firestore branch returns: the stamp stays in storage.
    const { createdAt, ...stored } = record;
    return stored;
  });
}

// Upsert at a known id. Unlike createOne this is idempotent — calling it twice
// with the same id updates instead of duplicating, which is what any
// "one row per (entity, user)" record needs.
async function setOne(name, id, payload) {
  if (!id) throw new Error("setOne: missing id");
  if (!payload || typeof payload !== "object") throw new Error("setOne: payload must be an object");
  return runFs(`setOne.${name}`, async () => {
    if (isFirebaseConfigured) {
      await setDoc(doc(db, name, id), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
      return { id, ...payload };
    }
    const data = readLS();
    data[name] = data[name] || [];
    const idx = data[name].findIndex((r) => r.id === id);
    const record = { ...(idx >= 0 ? data[name][idx] : { id, createdAt: Date.now() }), ...payload, id, updatedAt: Date.now() };
    if (idx >= 0) data[name][idx] = record;
    else data[name].push(record);
    writeLS(data);
    return record;
  });
}

async function updateOne(name, id, patch) {
  if (!id) throw new Error("updateOne: missing id");
  if (!patch || typeof patch !== "object") throw new Error("updateOne: patch must be an object");
  return runFs(`updateOne.${name}`, async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, name, id), patch);
      return { id, ...patch };
    }
    const data = readLS();
    const idx = (data[name] || []).findIndex((r) => r.id === id);
    if (idx >= 0) {
      data[name][idx] = { ...data[name][idx], ...patch };
      writeLS(data);
      return data[name][idx];
    }
    return null;
  });
}

async function deleteOne(name, id) {
  if (!id) throw new Error("deleteOne: missing id");
  return runFs(`deleteOne.${name}`, async () => {
    if (isFirebaseConfigured) { await deleteDoc(doc(db, name, id)); return; }
    const data = readLS();
    data[name] = (data[name] || []).filter((r) => r.id !== id);
    writeLS(data);
  });
}

// ---------- Users ----------
export async function createUserDoc(profile) {
  return createOne("users", normalizeNewUser(profile));
}
export async function getUserById(id) { return getOne("users", id); }
export async function getUserByNickname(nickname) {
  const rows = await getCollection("users", { where: [["nickname", "==", nickname]] });
  return rows[0] || null;
}
export async function getUserByEmail(email) {
  const rows = await getCollection("users", { where: [["email", "==", email.toLowerCase()]] });
  return rows[0] || null;
}
export async function updateUser(id, patch) { return updateOne("users", id, patch); }
/**
 * Hard-delete a user document. Only reachable in mock mode: the security rules
 * deny `delete` on `users` outright, because other people's books, borrowings
 * and notifications still point at the document. The real deletion path in
 * auth.js scrubs the profile instead — see `deleteAccount()`.
 */
export async function deleteUserDoc(id) { return deleteOne("users", id); }
export async function listUsersByCommunity(communityId) {
  return getCollection("users", { where: [["communityId", "==", communityId]] });
}
// ---------- Username index ----------
//
// `usernames/{nickname}` -> { uid, email }. A tiny public index that exists for
// one reason: two lookups have to work *before* the caller is authenticated.
// Signing in with a nickname has to resolve an email before Firebase Auth can
// be called at all, and the registration form has to say whether a nickname is
// free. Doing either against `users` would mean leaving profiles world-readable
// — phone numbers and home addresses included — so the lookup lives here
// instead and the profile itself stays behind auth.
//
// Security rules make this collection publicly *gettable* but not listable, so
// it answers a nickname you already know and refuses to be enumerated. Keep it
// to `uid` and `email`: every field added here becomes public, and the rules
// reject any write that carries a third.

/** Nicknames are case-insensitive; the document id is the canonical form. */
function usernameKey(nickname) {
  return typeof nickname === "string" ? nickname.trim().toLowerCase() : "";
}

/** `{ uid, email }` for a nickname, or null when it is free. Works signed out. */
export async function getUsernameEntry(nickname) {
  const key = usernameKey(nickname);
  if (!key) return null;
  return getOne("usernames", key);
}

/** True when this nickname is taken by somebody other than `exceptUid`. */
export async function isNicknameTaken(nickname, exceptUid = null) {
  const entry = await getUsernameEntry(nickname);
  return Boolean(entry) && entry.uid !== exceptUid;
}

/**
 * Point a nickname at an account. Written with a fixed document id rather than
 * through createOne so the stored document is exactly { uid, email, createdAt }
 * — the rules reject anything wider, including the `id` field createOne adds.
 *
 * A claim that is already ours is a no-op rather than a rewrite: the rules
 * allow create and delete on this collection but never update, so re-claiming
 * a nickname we already hold would fail and wedge a retried rename.
 */
export async function claimUsername(nickname, { uid: ownerUid, email }) {
  const key = usernameKey(nickname);
  if (!key) throw new Error("claimUsername: missing nickname");
  if (!ownerUid) throw new Error("claimUsername: missing uid");
  const existing = await getOne("usernames", key);
  if (existing) {
    if (existing.uid !== ownerUid) throw new Error("claimUsername: nickname taken");
    return existing;
  }
  return runFs("claimUsername", async () => {
    const payload = { uid: ownerUid, email: (email || "").toLowerCase() };
    if (isFirebaseConfigured) {
      await setDoc(doc(db, "usernames", key), { ...payload, createdAt: serverTimestamp() });
      return { id: key, ...payload };
    }
    const data = readLS();
    data.usernames = data.usernames || [];
    const record = { id: key, ...payload, createdAt: Date.now() };
    const idx = data.usernames.findIndex((r) => r.id === key);
    if (idx >= 0) data.usernames[idx] = record; else data.usernames.push(record);
    writeLS(data);
    return record;
  });
}

/** Give a nickname back — the first half of a rename. */
export async function releaseUsername(nickname) {
  const key = usernameKey(nickname);
  if (!key) return;
  return deleteOne("usernames", key);
}

/** How many rows a people/community search returns. Not paged; there is no UI for it. */
export const SEARCH_RESULT_MAX = 20;

/**
 * Find people by the start of their @nickname.
 *
 * This used to download the entire `users` collection on every keystroke and
 * substring-match it in the browser — every profile in the database, for every
 * search, in every session. It is now an indexed prefix scan bounded to
 * SEARCH_RESULT_MAX rows, served by the automatic single-field index on
 * `nickname`; no composite index is involved.
 *
 * The cost is real: first and last names are no longer searchable, and the
 * match is prefix-only, so "ivan" finds @ivanov but "ivanov" does not find
 * @vanya. Name search needs the same denormalised prefix array books carry —
 * which means a normalizer for user *patches*, since a profile edit would have
 * to maintain it and `updateUser` currently writes whatever it is handed. That
 * is the next step here, and the step after it is a real search service.
 */
export async function searchUsers(qStr, { pageSize = SEARCH_RESULT_MAX } = {}) {
  const term = String(qStr ?? "").trim().toLowerCase();
  if (!term) return [];
  return getCollection("users", {
    where: prefixRange("nickname", term),
    orderByField: "nickname",
    pageSize,
  });
}

// ---------- Communities ----------
export async function getCommunityByNickname(nickname) {
  const rows = await getCollection("communities", { where: [["nickname", "==", nickname]] });
  return rows[0] || null;
}
export async function createCommunity(payload) {
  return createOne("communities", normalizeNewCommunity(payload));
}
export async function getCommunity(id) { return getOne("communities", id); }
/**
 * Edit a community. Only its owner can, and only the fields the schema allows —
 * `ownerId` and `createdAt` are frozen by the security rules, so a patch that
 * carried them would be a write the server refuses rather than a helpful no-op.
 */
export async function updateCommunity(id, patch) {
  return updateOne("communities", id, normalizeCommunityPatch(patch));
}
/**
 * Find communities by the start of their @nickname — an indexed prefix scan,
 * for the same reasons and with the same limits as `searchUsers`.
 *
 * Display names are not searchable. `nickname` is lowercased at creation and so
 * is directly range-scannable; `name` is stored as typed, and a case-sensitive
 * prefix scan over it would be a worse lie than not offering it. Making it work
 * means a denormalised `nameLower`, maintained by a community patch normalizer.
 */
export async function searchCommunities(qStr, { pageSize = SEARCH_RESULT_MAX } = {}) {
  const term = String(qStr ?? "").trim().toLowerCase();
  if (!term) return [];
  return getCollection("communities", {
    where: prefixRange("nickname", term),
    orderByField: "nickname",
    pageSize,
  });
}

/**
 * The community directory — the browse screen behind "join a community".
 *
 * Capped rather than complete. There is no ordering that makes an arbitrary cut
 * meaningful (the obvious one, member count, is not a field on the document),
 * so this is a first page in document-id order and no more. At COMMUNITY_
 * DIRECTORY_MAX communities the screen needs real discovery — ranking, paging,
 * or both — rather than a longer list.
 */
export const COMMUNITY_DIRECTORY_MAX = 50;

export async function listCommunities({ pageSize = COMMUNITY_DIRECTORY_MAX } = {}) {
  return getCollection("communities", { pageSize });
}

// ---------- Books ----------
//
// A book has two people attached to it, and they are not the same thing:
//
//   ownerId  — who the book belongs to. Set once, at creation, and never moves.
//   holderId — who physically has the copy right now. Moves at every handoff.
//
// A new book starts with both pointing at the same person, and they diverge the
// first time it is lent out. Finishing a book does not send it home: the reader
// stays its holder until the next reader collects it from them. Everything below
// is written so that a handoff *cannot* touch `ownerId` even by accident — see
// `updateBook`.

/**
 * Add a book. The payload is rebuilt from scratch by `normalizeNewBook`, which
 * throws when a required field is missing rather than writing a half-formed
 * document — so `status`, `genre`, `holderId` and `communityId` are guaranteed
 * on every book in the collection, and `createdAt` is added by createOne.
 *
 * A book starts out with its owner — always, not merely by default. It has
 * never been handed over, so there is nowhere else for it to be, and storing
 * `holderId` here means the read path never has to infer it. A caller that asks
 * for anything else is describing a handoff, which is `transferBookHolder`.
 */
export async function createBook(payload) {
  return createOne("books", normalizeNewBook(payload));
}
/**
 * How long a freshly added book keeps showing up in the "new books" rail.
 *
 * There is no `isNewBook(book)` predicate to go with it any more. There was one,
 * and it existed only because the old `listNewBooks` fetched an unfiltered slice
 * and sifted it here; the window is a `where` clause now, so every book the
 * query returns is new by construction and nothing is left to test.
 */
export const NEW_BOOK_WINDOW_DAYS = 10;

/**
 * Recently added books of a community, newest first.
 *
 * A bounded range scan: `createdAt >= cutoff` with the matching `orderBy`, so
 * this reads the ten documents it returns and not one more, whether the
 * community holds thirty books or thirty thousand. It used to pull an unordered
 * slice of a hundred and sort it here, which stopped finding the newest books
 * at all past that size — an unordered scan comes back in document-id order,
 * and an auto-generated id has nothing to do with when it was written.
 *
 * One caveat, inherited from `serverTimestamp()`: between a write and the
 * server's acknowledgement the local document's `createdAt` is null, so an
 * ordered query does not see it. A book added on this device is therefore
 * missing from this rail for one round trip, and appears when the write lands.
 * The previous unordered scan avoided that at the cost of being wrong at scale,
 * which is a far worse trade.
 *
 * These books stay in the main list as well; this is an extra view of them,
 * not a bucket they move into.
 */
export async function listNewBooks({ communityId, limit: max = 10 } = {}) {
  if (!communityId) return [];
  const cutoff = Date.now() - NEW_BOOK_WINDOW_DAYS * 86_400_000;
  return getCollection("books", {
    where: [
      ["communityId", "==", communityId],
      ["createdAt", ">=", atMillis(cutoff)],
    ],
    orderByField: "createdAt",
    descending: true,
    pageSize: max,
  });
}

/**
 * `in` accepts at most 30 values. The genre list is fixed at 20 (utils/i18n.js
 * GENRES), so every possible selection fits — this guards the day it doesn't.
 */
export const MAX_GENRE_FILTER = 30;

/**
 * One page of a community's books, newest first.
 *
 * Every filter is a real query constraint now. It used to fetch one page and
 * then narrow it in JavaScript, which meant a book matching the search on page
 * three simply did not exist as far as the UI was concerned — and, because the
 * narrowing ran *before* the "is there another page" check, a search that
 * removed even one row from the page also reported that there was nothing more
 * to load. Both bugs are the same bug: a filter that the database was never
 * told about.
 *
 * How each filter maps:
 *
 *   communityId  `==`. Required, and not merely for the index: the `books` list
 *                rule is satisfied by the *query*, not by the documents, so an
 *                unscoped read is rejected outright.
 *   status       `==`.
 *   genres       `in`, up to MAX_GENRE_FILTER values. Matches `genre`, the
 *                single primary genre — so a book filed under
 *                ["fiction","history"] does not answer a search for history.
 *                That is the pre-existing meaning of the field, unchanged here;
 *                widening it means `array-contains-any` over `genres`, which
 *                cannot coexist with the `array-contains` search below.
 *   search       `array-contains` over the denormalised prefix set. Prefix
 *                matching from a word boundary and nothing more — see
 *                utils/search.js, which states the limits in full.
 *
 * All of them are equality-shaped, so they compose with `orderBy(createdAt)`
 * and with each other; the eight resulting index permutations are declared in
 * firestore.indexes.json.
 *
 * `hasMore` is "the page came back full", so the final page costs one extra
 * empty query. The alternative — over-fetching by one — cannot work here,
 * because the cursor has to be the snapshot of the last row actually returned.
 */
export async function listBooks({ communityId, search, status, genres, pageSize = 30, cursor = null } = {}) {
  if (!communityId) return { items: [], nextCursor: null, hasMore: false };

  const wheres = [["communityId", "==", communityId]];
  if (status) wheres.push(["status", "==", status]);

  const genreList = (Array.isArray(genres) ? genres : []).filter(Boolean);
  if (genreList.length) {
    if (genreList.length > MAX_GENRE_FILTER) {
      throw new Error(`listBooks: at most ${MAX_GENRE_FILTER} genres may be filtered at once`);
    }
    wheres.push(["genre", "in", genreList]);
  }

  const term = searchTerm(search);
  if (term) wheres.push(["searchPrefixes", "array-contains", term]);

  const { rows, cursor: nextCursor } = await getPage("books", {
    where: wheres,
    orderByField: "createdAt",
    descending: true,
    pageSize,
    cursor,
  });

  const hasMore = rows.length === pageSize;
  return { items: rows, nextCursor: hasMore ? nextCursor : null, hasMore };
}

/**
 * Every book physically with this person right now, and every book they own.
 *
 * Two equality filters and no ordering, so Firestore serves them by merging
 * single-field indexes — no composite index, and the read is proportional to
 * the answer rather than to the size of the community's shelf. The screens that
 * want these used to fetch two hundred books and filter for a handful in
 * JavaScript, which broke silently at the two-hundred-and-first book.
 *
 * `holderId` is queried directly rather than through `holderIdOf`'s
 * "missing means the owner" fallback: the schema sets it on every new book and
 * the security rules require it on create, so a book without one is a document
 * that predates the field, not a case to support.
 *
 * Neither pages. `pageSize` is a ceiling, not a window: a person holding or
 * owning more than 200 books in one community would see the list silently stop
 * there. Every screen that reads these counts what comes back, so the number
 * would be wrong rather than merely short — at which point these need a cursor
 * and the screens need "load more".
 */
export async function listBooksHeldBy({ communityId, userId, pageSize = 200 } = {}) {
  if (!communityId || !userId) return [];
  return getCollection("books", {
    where: [["communityId", "==", communityId], ["holderId", "==", userId]],
    pageSize,
  });
}

export async function listBooksOwnedBy({ communityId, userId, pageSize = 200 } = {}) {
  if (!communityId || !userId) return [];
  return getCollection("books", {
    where: [["communityId", "==", communityId], ["ownerId", "==", userId]],
    pageSize,
  });
}

// A book's rating is read straight off the book: `ratingSum` and `ratingCount`
// are written at creation and kept current by recalcBookRating, and the read
// side folds them with ratingSummary (utils/rating.js). There is no summary
// fetch for a list screen to make, which is the point of denormalising them.

export async function getBook(id) { return getOne("books", id); }

/**
 * Update a book. Every field is checked against the book schema, and an unknown
 * one is refused outright — a patch is the other half of how a document drifts,
 * and a field nothing has agreed on has no business being written.
 *
 * `ownerId` is dropped from the patch — ownership is fixed at creation, and
 * every lending operation goes through here, so the one way to lose an owner is
 * a patch that carries a stale or borrowed `ownerId` along for the ride.
 * Dropping it makes that impossible rather than merely discouraged. Admin
 * correction of a genuinely wrong owner goes through `reassignBookOwner`.
 */
export async function updateBook(id, patch) {
  if (!patch || typeof patch !== "object") throw new Error("updateBook: patch must be an object");
  let fields = patch;
  if ("ownerId" in fields) {
    const { ownerId, ...rest } = fields;
    logger.warn("firestore.updateBook", "ownerId is immutable; dropped from patch", {
      bookId: id, attempted: ownerId,
    });
    fields = rest;
  }

  const out = normalizeBookPatch(fields);

  // `searchPrefixes` is derived, so it is refused as an input and rewritten as
  // an output: an edit to the title or the author has to rebuild it in the same
  // write, or the book stays findable under its old name and invisible under
  // its new one. A patch may carry only one of the two fields, so the other is
  // read back off the stored document rather than guessed at.
  if ("name" in out || "author" in out) {
    const current = "name" in out && "author" in out ? null : await getOne("books", id);
    Object.assign(out, bookSearchFields({
      name: out.name ?? current?.name,
      author: out.author ?? current?.author,
    }));
  }

  return updateOne("books", id, out);
}

/**
 * Deliberately move ownership — the one sanctioned way. This is a data
 * correction (the admin picked the wrong member when adding the book), not part
 * of lending: it leaves `holderId` alone, because who has the copy right now is
 * unaffected by fixing who it belongs to.
 */
export async function reassignBookOwner(id, ownerId) {
  return updateOne("books", id, normalizeBookOwner(ownerId));
}

export async function deleteBook(id) { return deleteOne("books", id); }

/**
 * Hand a book to its next holder.
 *
 * This is the only place a book changes hands. `ownerId` is read from the stored
 * book rather than taken from the caller, so a stale copy held in component
 * state can't quietly rewrite who the book belongs to — and it is never part of
 * the patch, so the owner survives the transfer untouched.
 *
 * @param previousBorrowingId  loan to close out, when taking from a live reader
 * @param borrowing            fields for the new loan; ids are filled in here
 */
export async function transferBookHolder({
  bookId, toUserId, previousBorrowingId = null, borrowing = null,
}) {
  if (!bookId) throw new Error("transferBookHolder: missing bookId");
  if (!toUserId) throw new Error("transferBookHolder: missing toUserId");

  const book = await getBook(bookId);
  if (!book) throw new Error("transferBookHolder: book not found");
  const ownerId = book.ownerId ?? null;

  if (previousBorrowingId) {
    await updateBorrowing(previousBorrowingId, { status: "completed", returnDate: Date.now() });
  }

  let createdBorrowing = null;
  if (borrowing) {
    createdBorrowing = await createBorrowing({
      ...borrowing,
      bookId,
      borrowerId: toUserId,
      ownerId, // the loan records who it belongs to, which is not who lent it
      status: "active",
    });
  }

  // Note the absence of `ownerId`. The holder moves, the owner does not.
  const patch = { status: "unavailable", borrowerId: toUserId, holderId: toUserId };
  await updateBook(bookId, patch);

  return { book: { ...book, ...patch }, borrowing: createdBorrowing, ownerId };
}

/**
 * The reader is done, so the book is free for whoever wants it next — but it is
 * still on their shelf. `holderId` stays put; only `borrowerId` (the *active
 * loan*) clears. The book leaves them when someone collects it, not before.
 */
export async function releaseBookAfterReading({ bookId, holderId }) {
  if (!bookId) throw new Error("releaseBookAfterReading: missing bookId");
  if (!holderId) throw new Error("releaseBookAfterReading: missing holderId");
  const patch = { status: "available", borrowerId: null, holderId };
  await updateBook(bookId, patch);
  return patch;
}

/**
 * Send a book home — the one handoff that needs no code, because the owner is
 * the one place a copy is always allowed to go. This is what clears the "books
 * you hold" gate on the way out of a community.
 *
 * An active read is refused rather than quietly closed: finishing a book is the
 * reader's own act (it is where the rating is collected), and the exit rules
 * check for it first precisely so it cannot be skipped by returning the book.
 *
 * @returns the updated book
 */
export async function returnBookToOwner({ bookId, fromUserId }) {
  if (!bookId) throw new Error("returnBookToOwner: missing bookId");
  if (!fromUserId) throw new Error("returnBookToOwner: missing fromUserId");

  const book = await getBook(bookId);
  if (!book) throw new Error("returnBookToOwner: book not found");
  if (!book.ownerId) throw new Error("returnBookToOwner: book has no owner");
  if (holderIdOf(book) !== fromUserId) {
    throw new Error("returnBookToOwner: not the current holder");
  }
  // Owner and holder are the same person for every book that has never been
  // lent out. Nothing to move, and no error either — the caller's goal is met.
  if (book.ownerId === fromUserId) return book;

  const active = await getActiveBorrowingByBook(bookId);
  if (active && active.borrowerId === fromUserId) {
    throw new Error("returnBookToOwner: finish the active read first");
  }

  const patch = { status: "available", borrowerId: null, holderId: book.ownerId };
  await updateBook(bookId, patch);
  return { ...book, ...patch };
}

// ---------- Posts ----------
export async function createPost(payload) { return createOne("posts", payload); }

/**
 * Edit a post. Only its author can, and only its title and body — the rules
 * freeze the rest, so a patch carrying `authorId` or `communityId` would be a
 * write the server refuses rather than a helpful no-op.
 */
export async function updatePost(id, patch) {
  return updateOne("posts", id, normalizePostPatch(patch));
}

/** Take a post down. Only its author can — see the rules. */
export async function deletePost(id) { return deleteOne("posts", id); }

export async function getPost(id) { return getOne("posts", id); }

/**
 * The posts behind a user's `likedPostIds`, in the order they were liked.
 *
 * Reads are chunked rather than fired all at once for the same reason
 * `getBooksByIds` chunks: a long list would otherwise open one connection per
 * id. A post that has since gone private, or been deleted, simply drops out —
 * the read is refused or empty, and a liked-posts screen that failed wholesale
 * because one post moved would be worse than one that is a row shorter.
 */
export async function getPostsByIds(postIds, concurrency = 5) {
  if (!postIds || postIds.length === 0) return [];
  const results = [];
  for (let i = 0; i < postIds.length; i += concurrency) {
    const batch = postIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((id) => getPost(id).catch(() => null))
    );
    results.push(...batchResults.filter(Boolean));
  }
  return results;
}

/**
 * Like or unlike a post.
 *
 * Two writes, and they are not interchangeable: `likedPostIds` on the profile
 * is the fact — it is what the liked-posts screen reads and what decides
 * whether the heart is filled — and `likeCount` on the post is a denormalised
 * total, kept because a feed cannot count a field it is not allowed to read
 * across every user.
 *
 * The profile is written first. If the counter write then fails (offline, a
 * rule refusing a stale delta), the user's own view of what they liked is still
 * correct and the total is merely one behind — the opposite order would show a
 * heart the profile does not remember.
 */
export async function togglePostLike({ postId, userId, likedPostIds = [], liked }) {
  if (!postId || !userId) throw new Error("togglePostLike: missing postId or userId");

  const current = Array.isArray(likedPostIds) ? likedPostIds : [];
  const has = current.includes(postId);
  const next = liked ?? !has;
  if (next === has) return { likedPostIds: current, changed: false };

  const updatedIds = next
    ? [postId, ...current.filter((id) => id !== postId)]
    : current.filter((id) => id !== postId);

  await updateUser(userId, { likedPostIds: updatedIds });

  // Read-modify-write rather than a blind set: the rules only accept a value
  // one away from the stored one, so the count has to start from what is
  // actually there — including posts written before likes existed, which have
  // no counter at all.
  try {
    const post = await getOne("posts", postId);
    const currentCount = Number.isInteger(post?.likeCount) ? post.likeCount : 0;
    const nextCount = Math.max(0, currentCount + (next ? 1 : -1));
    await updateOne("posts", postId, { likeCount: nextCount });
  } catch (err) {
    logger.warn("firestore.togglePostLike.count", err?.message, { postId });
  }

  return { likedPostIds: updatedIds, changed: true };
}

/** How many posts the discovery half of the Home feed reads. */
export const PUBLIC_FEED_MAX = 60;

/**
 * The discovery feed: posts from every public community, newest first.
 *
 * `isPublic` is denormalised onto the post rather than read from its community,
 * because the security rule has to decide per document and a `get()` there would
 * cost one document read per row returned. The flag is stamped at creation and
 * re-stamped by `syncPostVisibility` when a community's privacy changes.
 *
 * A caller's own community is NOT excluded here — an inequality on
 * `communityId` cannot be combined with the equality on `isPublic` and the sort
 * on `createdAt` in one index. The Home feed drops the duplicates in JavaScript,
 * over one page of posts.
 */
export async function listPublicPosts({ pageSize = PUBLIC_FEED_MAX } = {}) {
  return getCollection("posts", {
    where: [["isPublic", "==", true]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
}

/**
 * Re-stamp every post of a community after its privacy changed.
 *
 * Without this a community that goes private keeps its old notices in everyone
 * else's feed — the post carries the flag, so the post is what has to change.
 * Bounded by the community's own post count and only ever run by its admin.
 */
export async function syncPostVisibility(communityId, isPublic) {
  if (!communityId) return 0;
  const posts = await listPostsByCommunity(communityId, 500);
  const stale = posts.filter((p) => Boolean(p.isPublic) !== Boolean(isPublic));
  for (const post of stale) {
    await updateOne("posts", post.id, { isPublic: Boolean(isPublic) });
  }
  return stale.length;
}

/**
 * A community's noticeboard, newest first — ordered by the index rather than in
 * JavaScript. Sorting a page client-side only ever ordered *that page*, so the
 * newest post fell off the board entirely once a community had more than
 * `pageSize` of them and the unordered scan happened not to include it.
 *
 * A post written on this device is missing for one round trip while its
 * `serverTimestamp()` resolves — the same trade `listNewBooks` documents.
 */
export async function listPostsByCommunity(communityId, pageSize = 30) {
  if (!communityId) return [];
  return getCollection("posts", {
    where: [["communityId", "==", communityId]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
}

// There is no global post feed, and there cannot be one: `posts` is readable
// only to members of the owning community, and a rule is checked against the
// query, so an unscoped list is denied rather than filtered. `listAllPosts`
// used to be defined here, had no callers, and would have thrown for every one
// it might have had.

// ---------- Notifications ----------
export async function createNotification(payload) {
  return createOne("notifications", normalizeNewNotification(payload));
}

export async function getNotificationById(id) {
  return getOne("notifications", id);
}

/**
 * A user's inbox, newest first.
 *
 * Both the ordering and the ceiling are the query's now. It previously fetched
 * *every* notification a user had ever received — unbounded, on a fifteen-second
 * poll (NotificationContext) — and sorted them here. An account a year old would
 * have re-read its whole history four times a minute.
 *
 * The cap is a real product limit, not a page: nothing pages this list, so
 * notification number 201 is not reachable from the UI. That is the size at
 * which this needs a "load older" affordance and a cursor to go with it.
 */
export const NOTIFICATION_PAGE_MAX = 200;

export async function listNotifications(userId, pageSize = NOTIFICATION_PAGE_MAX) {
  if (!userId) return [];
  return getCollection("notifications", {
    where: [["recipientId", "==", userId]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
}

/**
 * Deliver one notification to every member of a community.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * "A new book was added" is the only message this app sends to a whole
 * community at once, and it used to be sent from the Add-Book screen as one
 * `createNotification` per member inside a `Promise.all`. That is N independent
 * round trips originating in a browser: fine at twenty members, tens of seconds
 * and a partially-written inbox at two thousand.
 *
 * This is the seam that fixes it, and it is deliberately shaped as *one call
 * that takes a community* rather than a helper that takes a list of recipients.
 * Fan-out belongs on a server — an `onDocumentCreated` Cloud Function on
 * `books` — and when this project moves to the Blaze plan that is a rewrite of
 * this function's body and nothing else. Callers already say what they mean.
 *
 * Until then the work happens here, batched. Batching does not make the write
 * count smaller: two thousand members is still two thousand documents. What it
 * buys is round trips and atomicity — four committed batches instead of two
 * thousand racing promises, and a batch either lands whole or not at all.
 *
 * The caller supplies the copy. i18n is a UI concern and the data layer has no
 * business holding Kazakh strings; `notification` is everything a notification
 * needs except `recipientId`, which this function fills in per member.
 *
 * Returns the number of notifications written. Throws if the member read or any
 * batch commit fails — callers that must not be blocked by delivery should not
 * await this. See the note at the AddBook call site.
 */
const FAN_OUT_BATCH_MAX = 500; // Firestore's hard ceiling on writes per batch.

export async function notifyCommunityMembers({ communityId, excludeUserId = null, notification }) {
  if (!communityId) throw new Error("notifyCommunityMembers: missing communityId");
  if (!notification || typeof notification !== "object") {
    throw new Error("notifyCommunityMembers: notification must be an object");
  }

  const members = await listUsersByCommunity(communityId);
  const recipientIds = (members || [])
    .map((m) => m.id)
    .filter((id) => id && id !== excludeUserId);
  if (recipientIds.length === 0) return 0;

  // Normalize once per recipient rather than once overall: `normalizeNewNotification`
  // validates `recipientId`, so a member row with a malformed id is rejected here
  // instead of being committed and then bounced by the security rules mid-batch.
  const docs = recipientIds.map((recipientId) =>
    stripServerOwned("notifications", normalizeNewNotification({ ...notification, recipientId }))
  );

  return runFs("notifyCommunityMembers", async () => {
    if (isFirebaseConfigured) {
      for (let i = 0; i < docs.length; i += FAN_OUT_BATCH_MAX) {
        const chunk = docs.slice(i, i + FAN_OUT_BATCH_MAX);
        const batch = writeBatch(db);
        for (const fields of chunk) {
          batch.set(doc(collection(db, "notifications")), { ...fields, createdAt: serverTimestamp() });
        }
        await batch.commit();
      }
      return docs.length;
    }
    // One localStorage read/write for the whole fan-out. Looping `createOne`
    // here would re-serialize the entire database once per recipient.
    const data = readLS();
    data.notifications = data.notifications || [];
    const now = Date.now();
    for (const fields of docs) {
      data.notifications.push({ ...fields, id: uid(), createdAt: now });
    }
    writeLS(data);
    return docs.length;
  });
}

export async function markNotificationRead(id) {
  return updateOne("notifications", id, { read: true });
}
export async function updateNotification(id, patch) {
  return updateOne("notifications", id, patch);
}
export async function deleteNotification(id) {
  return deleteOne("notifications", id);
}

// ---------- Requests, generally ----------
//
// A notification about a request carries only its id, so the screen that acts
// on one — approving a join, refusing a leave — reads the request itself rather
// than trusting the copy of it that travelled in the notification. The rules
// let the subject and the community's admin read it, and nobody else.
export async function getRequestById(id) { return getOne("requests", id); }

// ---------- Join requests ----------
//
// The book travels with the request now, in full. `normalizeJoinRequest` holds
// it to the same contract Add Book is held to, so what the admin approves is
// already a valid book — approval hands it to `createBook` and nothing has to
// be re-typed or re-checked in between.
export async function createJoinRequest(payload) {
  return createOne("requests", normalizeJoinRequest(payload));
}
export async function listJoinRequests(communityId) {
  return getCollection("requests", {
    where: [["communityId", "==", communityId], ["type", "==", "join"]],
  });
}
export async function updateJoinRequest(id, patch) { return updateOne("requests", id, patch); }
export async function cancelJoinRequest(id) { return updateOne("requests", id, { status: "cancelled" }); }

// ---------- Leave requests ----------
export async function createLeaveRequest(payload) {
  return createOne("requests", { type: "leave", status: "pending", ...payload });
}
export async function listLeaveRequests(communityId) {
  return getCollection("requests", {
    where: [["communityId", "==", communityId], ["type", "==", "leave"], ["status", "==", "pending"]],
  });
}
export async function getPendingLeaveRequest(userId) {
  const rows = await getCollection("requests", {
    where: [["userId", "==", userId], ["type", "==", "leave"], ["status", "==", "pending"]],
  });
  return rows[0] || null;
}
export async function updateLeaveRequest(id, patch) { return updateOne("requests", id, patch); }

// ---------- Pickup requests ----------
// Stored in the same "requests" collection with type:"pickup".
//
// Two invariants, and both are enforced here rather than by the screen that
// happens to be open. A screen can be re-entered, double-tapped, restored from a
// stale cache, or opened in a second tab; a rule that only lives in a click
// handler is a rule that holds until one of those happens.
//
//   1. At most ONE pending request per (book, requester). `openPickupRequest`
//      is idempotent, and its `created` flag is what tells a caller whether it
//      is looking at a request it just opened or one that was already there.
//   2. At most ONE pickup in flight per requester, across all books. Collecting
//      a book is a physical errand; two of them at once is not a thing a reader
//      can do, and each one blocks a book for three days.

export async function createPickupRequest(payload) {
  return createOne("requests", { type: "pickup", status: "pending", ...payload });
}

/** A pickup the caller cannot start, and which of the two rules refused it. */
export class PickupBlockedError extends Error {
  constructor(reason, { bookId = null } = {}) {
    super(`pickup blocked: ${reason}`);
    this.name = "PickupBlockedError";
    /**
     * "other-pickup" — a request is open elsewhere; "other-loan" — a book of
     * theirs is out; "returning" — this copy is on its way home to its owner.
     */
    this.reason = reason;
    /** The book that is in the way, so a caller can link to it. */
    this.bookId = bookId;
  }
}

/**
 * The requester's open pickup request, on any book, or null.
 *
 * Three equality clauses and no orderBy, so Firestore serves it by merging the
 * single-field indexes it maintains anyway — no composite index, and the rules
 * accept the query because `requesterId == uid()` is one of the disjuncts the
 * `requests` list rule allows.
 */
export async function getPendingPickupForUser(requesterId) {
  if (!requesterId) return null;
  const rows = await getCollection("requests", {
    where: [
      ["requesterId", "==", requesterId],
      ["type", "==", "pickup"],
      ["status", "==", "pending"],
    ],
    pageSize: 1,
  });
  return rows[0] || null;
}

/**
 * Open a pickup request — or hand back the one that is already open.
 *
 * This is the fix for a code being sent twice. The notification carrying the
 * handoff code used to be sent by whoever pressed the button, next to a create
 * that never asked whether a request already existed; so a second press, a
 * re-entered screen, or a book page restored from cache all produced a second
 * identical request and a second identical code. Sending is now conditional on
 * `created`, and `created` can only be true once per (book, requester) — the
 * check and the create sit in the same call, so nothing in between can slip past.
 *
 * @returns `{ request, created }` — `created` is false when an open request was
 *   found, and the caller must NOT notify again in that case.
 * @throws {PickupBlockedError} when the requester already has a pickup in
 *   flight on a different book, or a book of their own still out on loan.
 */
export async function openPickupRequest(payload) {
  const bookId = payload?.bookId;
  const requesterId = payload?.requesterId;
  if (!bookId || !requesterId) {
    throw new Error("openPickupRequest: bookId and requesterId are required");
  }

  const existing = await getPickupRequest(bookId, requesterId);
  if (existing) return { request: existing, created: false };

  // Nothing open for this book — so this would be a new errand, and the
  // one-at-a-time rules apply. Checked in this order because a request the
  // reader has forgotten about is the likelier of the two.
  const elsewhere = await getPendingPickupForUser(requesterId);
  if (elsewhere) throw new PickupBlockedError("other-pickup", { bookId: elsewhere.bookId });

  const loan = await getActiveBorrowingForUser(requesterId);
  if (loan && loan.bookId !== bookId) {
    throw new PickupBlockedError("other-loan", { bookId: loan.bookId });
  }

  // A copy its owner is collecting is not a copy anybody else may start
  // collecting. The reservation already hides it from the shelf, but a reader
  // who kept the book page open, or reached it from a saved list, still has a
  // button — so the rule lives here, where every route to a new pickup passes.
  const book = await getBook(bookId);
  const returning = await getPendingReturnForBook({
    bookId, communityId: book?.communityId,
  });
  if (returning) throw new PickupBlockedError("returning", { bookId });

  const request = await createPickupRequest(payload);
  return { request, created: true };
}

/**
 * The pending pickup request for a given user + book, or null.
 *
 * `bookId` is part of the query rather than a JavaScript filter over the
 * result. Four equality clauses need no composite index — Firestore merges the
 * automatic single-field ones — so the earlier compromise bought nothing and
 * cost a read of every pending request the user had anywhere.
 */
export async function getPickupRequest(bookId, requesterId) {
  if (!bookId || !requesterId) return null;
  const rows = await getCollection("requests", {
    where: [
      ["requesterId", "==", requesterId],
      ["type", "==", "pickup"],
      ["status", "==", "pending"],
      ["bookId", "==", bookId],
    ],
    pageSize: 1,
  });
  return rows[0] || null;
}

/** Update any field on a pickup request (e.g. refresh the pickupCode). */
export async function updatePickupRequest(id, patch) {
  return updateOne("requests", id, patch);
}

/** Mark a pickup request as cancelled. */
export async function cancelPickupRequest(id) {
  return updateOne("requests", id, { status: "cancelled" });
}

/** Mark a pickup request as fulfilled (book successfully received). */
export async function fulfillPickupRequest(id) {
  return updateOne("requests", id, { status: "fulfilled" });
}

// ---------- Return requests ----------
//
// A pickup run backwards: the *owner* of a book asks whoever has it to bring it
// home, because they are leaving the community and cannot go while a copy of
// theirs is out (utils/communityExit.js). Stored in the same collection with
// `type: "return"`; the shape lives in schema.js.
//
// Three invariants, all enforced here rather than on the screen that happens to
// be open — a screen can be re-entered, double-tapped or restored from cache:
//
//   1. At most ONE pending return per (book, owner). `openReturnRequest` is
//      idempotent and reports whether it created anything, so the code is sent
//      exactly once per request.
//   2. Opening a return takes the book off the shelf, and only a request that
//      did that may put it back. `reservedBook` on the request is the record of
//      which of the two happened.
//   3. The book moves only in `completeReturnToOwner`, and only into its
//      owner's hands. There is no lane here that hands it to a third party.
//
// Unlike a pickup there is no one-errand-at-a-time rule. A member leaving may
// have several copies out with several people, and every one of them has to
// come back before they can go — serialising that would mean nine days to
// collect three books.

/** Every query below names the community, because the `requests` list rule
 * only accepts a query it can scope: a member may list their own community's
 * requests or their own. "Which book is being returned" is the first of those,
 * and it is the question the pickup screen has to be able to ask. */
export async function createReturnRequest(payload) {
  return createOne("requests", normalizeReturnRequest(payload));
}

/** The owner's open return on one book, or null. */
export async function getReturnRequest(bookId, requesterId) {
  if (!bookId || !requesterId) return null;
  const rows = await getCollection("requests", {
    where: [
      ["requesterId", "==", requesterId],
      ["type", "==", "return"],
      ["status", "==", "pending"],
      ["bookId", "==", bookId],
    ],
    pageSize: 1,
  });
  return rows[0] || null;
}

/**
 * Any open return on a book, whoever opened it — the question a reader's pickup
 * screen has to ask before offering to collect a copy that is on its way home.
 *
 * Scoped by community because the rules require it (see above), which is also
 * the only scope in which the answer means anything: a book and the person
 * collecting it are always in the same community.
 */
export async function getPendingReturnForBook({ bookId, communityId } = {}) {
  if (!bookId || !communityId) return null;
  const rows = await getCollection("requests", {
    where: [
      ["communityId", "==", communityId],
      ["type", "==", "return"],
      ["status", "==", "pending"],
      ["bookId", "==", bookId],
    ],
    pageSize: 1,
  });
  return rows[0] || null;
}

/** Every return this member has open, on any book — the leave screen's list. */
export async function listPendingReturnsForUser(requesterId) {
  if (!requesterId) return [];
  return getCollection("requests", {
    where: [
      ["requesterId", "==", requesterId],
      ["type", "==", "return"],
      ["status", "==", "pending"],
    ],
  });
}

export async function updateReturnRequest(id, patch) {
  return updateOne("requests", id, patch);
}

/**
 * Take a book out of circulation while its owner arranges to collect it.
 *
 * The book becomes "unavailable" — occupied, in the holder's hands, not
 * borrowable — but `borrowerId` stays null, because nobody is reading it. That
 * pair is what tells a reservation from a loan everywhere else in the app (see
 * utils/bookReturn.js `isOnLoan`), and it is why the reservation does not have
 * to invent a status of its own that every list and badge would have to learn.
 */
export async function reserveBookForReturn(bookId) {
  return updateBook(bookId, { status: "unavailable", borrowerId: null });
}

/**
 * Put a reserved book back on the shelf, when the return is cancelled or lapses.
 *
 * Refuses to touch a book somebody is actually reading: a return opened against
 * a live loan never reserved anything, and "releasing" it would tell the
 * community a book that is out on loan is free to collect.
 */
export async function releaseBookReservation(bookId) {
  const book = await getBook(bookId);
  if (!book) return null;
  if (book.status === "available") return book;
  if (book.borrowerId) return book;
  const patch = { status: "available", borrowerId: null };
  await updateBook(bookId, patch);
  return { ...book, ...patch };
}

/**
 * Open a return — or hand back the one that is already open.
 *
 * Order matters and is not an accident. The request is written *first* and the
 * book is reserved second: a reservation with no request pointing at it is a
 * book stuck occupied with nothing in the app able to explain why or clear it,
 * whereas a request whose reservation failed is merely a request the next call
 * can reserve again. `reservedBook` is decided before the create, from the
 * status the book has right now, so the two writes cannot disagree about
 * whether this request is what took the book off the shelf.
 *
 * @returns `{ request, created, book }` — when `created` is false the code has
 *   already been sent and the caller must NOT send it again.
 */
export async function openReturnRequest({
  bookId, requesterId, communityId, requesterName = "", returnCode = null,
} = {}) {
  if (!bookId || !requesterId) {
    throw new Error("openReturnRequest: bookId and requesterId are required");
  }

  const book = await getBook(bookId);
  if (!book) throw new Error("openReturnRequest: book not found");
  if (book.ownerId !== requesterId) {
    throw new Error("openReturnRequest: only the owner may ask for a book back");
  }
  const holderId = holderIdOf(book);
  if (!holderId || holderId === requesterId) {
    // Already home. Not an error — the caller's goal is met, and saying so
    // beats opening a request against nobody.
    return { request: null, created: false, book };
  }

  const existing = await getReturnRequest(bookId, requesterId);
  if (existing) return { request: existing, created: false, book };

  // A book already out on loan is already occupied; reserving is only for the
  // copy that is sitting free on somebody's shelf, which is the one a third
  // reader could otherwise start collecting mid-return.
  const reservedBook = book.status === "available";

  const request = await createReturnRequest({
    bookId,
    communityId: communityId || book.communityId,
    requesterId,
    requesterName,
    holderId,
    bookName: book.name,
    returnCode: returnCode || newPickupCode(),
    reservedBook,
  });

  if (reservedBook) {
    try {
      await reserveBookForReturn(bookId);
    } catch (err) {
      // The request stands; the book is simply still on the shelf. Worth
      // knowing about, not worth failing an otherwise-opened request over.
      logger.error("firestore.openReturnRequest.reserve", err?.message, { bookId, code: err?.code });
    }
  }

  return { request, created: true, book };
}

/**
 * Close a return without the book moving — cancelled by its owner, or lapsed
 * after three days. Either way the book goes back on the shelf if this request
 * is what took it off.
 *
 * The request is stamped before the book is freed, not after. If only the first
 * write lands, the leave screen finds a book that is unavailable with no
 * request behind it and can put it back; if only the second did, the community
 * would see a bookable copy that the app still believes is spoken for.
 */
export async function closeReturnRequest(id, status = "cancelled") {
  if (!id) throw new Error("closeReturnRequest: missing id");
  const request = await getOne("requests", id);
  await updateReturnRequest(id, { status });
  if (request?.reservedBook && request.bookId) {
    await releaseBookReservation(request.bookId);
  }
  return { ...request, status };
}

/** The owner changed their mind, or is starting over with a fresh code. */
export async function cancelReturnRequest(id) {
  return closeReturnRequest(id, "cancelled");
}

/** Three days went by. Kept apart from a cancellation so the history says which. */
export async function expireReturnRequest(id) {
  return closeReturnRequest(id, "expired");
}

/**
 * The handover happened: the owner has the copy back in their hands.
 *
 * This is the only place a return moves a book, and it moves it to exactly one
 * destination — the owner named on the book itself, never the caller's idea of
 * who that is. Three things settle here, in this order:
 *
 *   1. any live loan is closed. The reader has physically handed the book over,
 *      so their borrowing is finished whether or not they finished the book —
 *      the alternative is a loan that outlives the copy it is about;
 *   2. the book goes home: available again, with its owner, borrowed by nobody;
 *   3. the request is marked fulfilled, so nothing tries to expire or cancel it
 *      afterwards.
 *
 * A book that is already home is not an error. Holders can hand a copy back
 * from their own shelf without a code (`returnBookToOwner`), and when they do,
 * this call simply closes the paperwork.
 *
 * @returns `{ book, closedBorrowing, alreadyHome }`
 */
export async function completeReturnToOwner({ bookId, ownerId, requestId = null } = {}) {
  if (!bookId) throw new Error("completeReturnToOwner: missing bookId");
  if (!ownerId) throw new Error("completeReturnToOwner: missing ownerId");

  const book = await getBook(bookId);
  if (!book) throw new Error("completeReturnToOwner: book not found");
  if (book.ownerId !== ownerId) {
    throw new Error("completeReturnToOwner: only the owner may take the book back");
  }

  if (holderIdOf(book) === ownerId) {
    if (requestId) await updateReturnRequest(requestId, { status: "fulfilled" });
    return { book, closedBorrowing: null, alreadyHome: true };
  }

  const active = await getActiveBorrowingByBook(bookId);
  if (active) {
    await updateBorrowing(active.id, { status: "completed", returnDate: Date.now() });
  }

  const patch = { status: "available", borrowerId: null, holderId: ownerId };
  await updateBook(bookId, patch);
  if (requestId) await updateReturnRequest(requestId, { status: "fulfilled" });

  return { book: { ...book, ...patch }, closedBorrowing: active, alreadyHome: false };
}

// ---------- Borrowings ----------
export async function createBorrowing(payload) {
  return createOne("borrowings", normalizeNewBorrowing(payload));
}
export async function getActiveBorrowingForUser(userId) {
  const rows = await getCollection("borrowings", {
    where: [["borrowerId", "==", userId], ["status", "==", "active"]],
  });
  return rows[0] || null;
}
// Get the active borrowing for a specific book (to find current holder + pickup code)
export async function getActiveBorrowingByBook(bookId) {
  const rows = await getCollection("borrowings", {
    where: [["bookId", "==", bookId], ["status", "==", "active"]],
  });
  return rows[0] || null;
}

// The most recent completed borrowing for a book — who had it last. Ordered and
// limited by the query, so this is a single read however many times the book has
// gone round; it used to fetch the book's entire loan history to pick one row.
export async function getLastCompletedBorrowingByBook(bookId) {
  if (!bookId) return null;
  const rows = await getCollection("borrowings", {
    where: [["bookId", "==", bookId], ["status", "==", "completed"]],
    orderByField: "createdAt",
    descending: true,
    pageSize: 1,
  });
  return rows[0] || null;
}
export async function listBorrowingsForUser(userId, status) {
  const wheres = [["borrowerId", "==", userId]];
  if (status) wheres.push(["status", "==", status]);
  return getCollection("borrowings", { where: wheres });
}
export async function listBorrowingsByOwner(ownerId) {
  return getCollection("borrowings", { where: [["ownerId", "==", ownerId]] });
}
export async function updateBorrowing(id, patch) { return updateOne("borrowings", id, patch); }

// ---------- Ratings & reviews ----------
//
// One rating per (book, user). The document id is derived from the pair, so a
// second rating from the same person overwrites the first instead of stuffing
// the ballot box — and reading "did I already rate this?" is a point read.
//
// The book document carries a denormalised { rating, ratingSum, ratingCount }
// so list screens never have to fan out over the ratings collection. It is
// recomputed from the rating documents after every write: without Cloud
// Functions there is no server-side trigger, and a full recompute is both
// cheap at this scale and self-healing — any drift is corrected by the next
// person who rates.

function ratingDocId(bookId, userId) { return `${bookId}__${userId}`; }

export async function listRatingsForBook(bookId) { return getCollection("ratings", { where: [["bookId", "==", bookId]] }); }

/**
 * The rating this user left for this book, or null. A point read: the document
 * id is derived from the pair, and the security rules refuse a rating written
 * anywhere else, so there is exactly one place it can be.
 */
export async function getUserRatingForBook(bookId, userId) {
  if (!bookId || !userId) return null;
  return getOne("ratings", ratingDocId(bookId, userId));
}

/** Recompute a book's aggregate from its rating documents and persist it. */
export async function recalcBookRating(bookId) {
  const summary = aggregateFromRatings(await listRatingsForBook(bookId));
  await updateBook(bookId, {
    rating: summary.average,
    ratingSum: summary.sum,
    ratingCount: summary.count,
  });
  return summary;
}

/**
 * Create or replace this user's rating for a book, then refresh the book's
 * aggregate. Returns { rating, summary } so callers can update their caches
 * without a round trip.
 *
 * Eligibility (only people who actually read the book may rate) is enforced by
 * the caller via hasUserCompletedBook — this function is the write path.
 */
export async function submitRating({ bookId, userId, value, review = "", authorName = "", photoURL = "" }) {
  const document = normalizeRating({ bookId, userId, value, review, authorName, photoURL });

  const id = ratingDocId(bookId, userId);
  const previous = await getOne("ratings", id);

  // A rating is an upsert at a deterministic id, so the storage layer cannot
  // tell a first rating from a revised one — `createdAt` is stamped here, on
  // the create, and left alone afterwards so re-rating doesn't reorder the
  // review feed. It is a client clock rather than the server's for the same
  // reason: a merge write has no create hook to hang serverTimestamp() on.
  const rating = await setOne("ratings", id, {
    ...document,
    ...(previous ? {} : { createdAt: Date.now() }),
  });

  const summary = await recalcBookRating(bookId);
  return { rating, summary };
}

/**
 * True when the user has borrowed and returned this book — the gate for being
 * allowed to rate it.
 */
export async function hasUserCompletedBook(bookId, userId) {
  if (!bookId || !userId) return false;
  const rows = await getCollection("borrowings", {
    where: [["bookId", "==", bookId], ["borrowerId", "==", userId], ["status", "==", "completed"]],
  });
  return rows.length > 0;
}

/**
 * Batch fetch books by IDs with concurrency control.
 *
 * A miss is skipped rather than fatal. Saved-book ids outlive the community
 * they were saved in, and books are readable only to members of their own
 * community, so a stale id now comes back as a permission error — one of those
 * must not empty the whole shelf.
 */
export async function getBooksByIds(bookIds, concurrency = 5) {
  if (!bookIds || bookIds.length === 0) return [];

  const results = [];
  for (let i = 0; i < bookIds.length; i += concurrency) {
    const batch = bookIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((id) => getBook(id).catch(() => null))
    );
    results.push(...batchResults.filter(Boolean));
  }

  return results;
}

// ---------- Reading sessions ----------
//
// See schema.js for the shape and utils/readingProgress.js for why a session is
// recorded in two places at once. The short version: the row is the log, the map
// on the user document is the index, and only the map is ever read by a screen.

/**
 * Record a finished timer run, and fold it into the reader's profile.
 *
 * `readingDays` is passed in rather than read back because the caller — the
 * timer screen — is holding the signed-in profile already, and re-reading it
 * here would spend a document read to learn something the client just had. The
 * cost of that shortcut is stated in utils/readingProgress.js: this is a
 * client-side read-modify-write, so it is the *aggregate* that can lose a
 * simultaneous write from a second device, never the session row.
 *
 * Returns the patch that was applied, so the caller can put the same values
 * into its own auth state without a refetch.
 */
export async function logReadingSession({
  userId, communityId = null, bookId = null, seconds, startedAt, endedAt, readingDays = {},
} = {}) {
  const session = normalizeNewReadingSession({
    userId, communityId, bookId, seconds, startedAt, endedAt,
  });

  // The log first. If the profile fold fails after this, the sitting is still on
  // record and a later write repairs the map; the other order would lose it.
  await createOne("readingSessions", session);

  const patch = normalizeReadingProgress({
    readingDays,
    dayKey: session.dayKey,
    seconds: session.seconds,
    endedAt: session.endedAt,
  });
  await updateOne("users", userId, patch);

  return { session, patch };
}

/**
 * A reader's most recent sittings, newest first. Their own only — the security
 * rules scope this collection to its author, and the week other people see is
 * served from the aggregate on the profile instead.
 */
export async function listReadingSessions({ userId, pageSize = 20 } = {}) {
  if (!userId) return [];
  return getCollection("readingSessions", {
    where: [["userId", "==", userId]],
    orderByField: "startedAt",
    descending: true,
    pageSize,
  });
}

/**
 * Where a member stands in their community by reading time this week.
 *
 * One query, because every member's day map is denormalised onto the profile
 * this already has to list — the ranking is then computed here from the same
 * seven-day window the profile chart draws, so the badge and the chart can never
 * disagree. Returns null outside a community, or for a member the list does not
 * contain — a stale `communityId`, most likely.
 */
export async function getCommunityReadingRank({ communityId, userId } = {}) {
  if (!communityId || !userId) return null;
  const members = await listUsersByCommunity(communityId);
  return rankByWeeklyReading(members, userId);
}

// Reviews are not a separate collection: a review is the optional text a
// reader attaches to their rating, so it lives on the rating document and is
// derived from listRatingsForBook via reviewsFromRatings (utils/rating.js).