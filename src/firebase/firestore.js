// Firestore data layer with a transparent localStorage fallback.
// Collections: users, follows, communities, books, posts, notifications, requests, borrowings, ratings, reviews

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, increment,
  query, where, orderBy, limit, startAfter, serverTimestamp, Timestamp, writeBatch,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "./config.js";
import { logger } from "../utils/logger.js";
import { aggregateFromRatings } from "../utils/rating.js";
import { holderIdOf } from "../utils/bookHolder.js";
import { searchTerm } from "../utils/search.js";
import { toMillis } from "../utils/time.js";
import {
  bookSearchFields,
  chatIdFor, chatMemberIds, chatPreviewOf, chatWatermark,
  normalizeNewBook, normalizeBookPatch, normalizeBookOwner, normalizeNewBorrowing,
  normalizeNewChat, normalizeNewMessage, normalizeNewFollow, followIdFor,
  normalizeNewCommunity, normalizeCommunityPatch, normalizeNewPost, normalizePostPatch,
  normalizeNewComment,
  normalizeJoinRequest, normalizeReturnRequest, newPickupCode,
  normalizeNewNotification, normalizeNewUser, normalizeRating,
  userSearchFields, USER_SEARCH_SOURCES,
  normalizeNewReadingSession, normalizeReadingProgress,
  stripServerOwned,
} from "./schema.js";
import { rankByWeeklyReading } from "../utils/readingProgress.js";

// Document shape is schema.js's job, and every write below goes through it.
// `toMillis` is re-exported so a screen reading a stored timestamp reaches for
// the same helper the data layer wrote it with, without a second import.
export { toMillis } from "../utils/time.js";
export { SchemaError } from "./schema.js";
// A chat's id is a pure function of the two people in it, so the screens
// compute it rather than looking it up — see the chats section below.
export { chatIdFor, otherMemberId } from "./schema.js";
// A follow's id is likewise a pure function of the two people in it, so a
// screen asking "am I following them?" reads one known path — see Follows.
export { followIdFor } from "./schema.js";
// The tick beside a message is a pure function of the message and the two
// watermarks on its chat — see the receipts note in schema.js.
export { messageStatus, MESSAGE_STATUS, chatWatermark } from "./schema.js";

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
    follows: [], comments: [],
    readingSessions: [], phoneVerifications: [],
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
      if (op === "array-contains-any") {
        return Array.isArray(r[f]) && v.some((x) => r[f].includes(x));
      }
      // An operator this matcher does not know would filter nothing at all and
      // look like a query that simply matched everything. Better to say so.
      throw new Error(`getPage: unsupported where operator "${op}"`);
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

/**
 * The same query as `getCollection`, kept open.
 *
 * `onRows` is called with the first page and again every time the server's
 * answer changes — a new document, a deleted one, or a field moving underneath
 * one that is already on screen. That last case is the whole reason this exists:
 * a like is a number on somebody else's post, and a screen that only ever read
 * it once would show every other reader a total frozen at whatever it was when
 * they opened the app.
 *
 * Real-time where there is a real database, and a poll where there is not —
 * exactly the arrangement `watchPhoneVerification` documents. Firestore also
 * reports this client's own pending writes before the server has acknowledged
 * them, so a like is on screen in the same frame it was tapped, and disappears
 * by itself if the write turns out to be refused.
 *
 * `onError` fires instead of `onRows` when the query is refused or its index is
 * missing; a caller showing two of these must be able to keep the other one.
 *
 * @returns an unsubscribe function — call it on unmount, always.
 */
function watchCollection(name, options = {}, { onRows, onError, pollMs = 4000 } = {}) {
  if (typeof onRows !== "function") return () => {};
  const { where: wheres = [], orderByField, descending = false, pageSize } = options;

  const fail = (err) => {
    logger.error(`firestore.watch.${name}`, err?.message, { code: err?.code });
    onError?.(err);
  };

  if (isFirebaseConfigured) {
    const constraints = wheres.map(([f, op, v]) => where(f, op, v));
    if (orderByField) constraints.push(orderBy(orderByField, descending ? "desc" : "asc"));
    if (pageSize) constraints.push(limit(pageSize));
    return onSnapshot(
      query(collection(db, name), ...constraints),
      (snap) => onRows(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      fail
    );
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const rows = await getCollection(name, options);
      if (!stopped) onRows(rows);
    } catch (err) {
      if (!stopped) fail(err);
    }
  };
  tick();
  const id = setInterval(tick, pollMs);
  return () => { stopped = true; clearInterval(id); };
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
/**
 * Patch a profile, keeping what it is findable by in step with what it says.
 *
 * A rename used to leave `searchPrefixes` describing the old name — the array
 * is denormalised, and `updateUser` wrote whatever it was handed. That is the
 * gap the comment on `searchUsers` used to describe as the next step; this is
 * that step.
 *
 * The extra read happens only when the patch actually touches a name, which is
 * a profile edit and therefore rare — never on the saved-books, liked-posts or
 * membership writes that make up almost all the traffic through here. It is
 * needed because prefixes are built from all three fields at once, and a patch
 * carrying only `firstName` cannot say what the other two are.
 *
 * `deleteAccount` benefits without knowing it exists: scrubbing a profile
 * blanks the names, so the prefixes rebuild to the placeholder handle and the
 * account stops being findable by a name it no longer carries.
 */
export async function updateUser(id, patch) {
  return updateOne("users", id, await withUserSearchFields(id, patch));
}

async function withUserSearchFields(id, patch) {
  if (!patch || typeof patch !== "object") return patch;
  if (!USER_SEARCH_SOURCES.some((field) => field in patch)) return patch;

  // A profile that has gone missing mid-edit still gets a coherent array out of
  // the patch alone; `updateOne` is what decides whether the write lands.
  const current = (await getOne("users", id).catch(() => null)) ?? {};
  return { ...patch, ...userSearchFields({ ...current, ...patch }) };
}
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
 * Find people — anywhere in the app, by name or by handle.
 *
 * One indexed `array-contains` against `searchPrefixes`, the same primitive
 * book search uses, bounded to SEARCH_RESULT_MAX rows. No composite index is
 * involved: an array-contains with no orderBy is served by the single-field
 * index Firestore maintains by itself.
 *
 * This replaces a prefix scan on `nickname` alone, which could only find people
 * by the handle: somebody looking for "Madi Berikkazy" — the name on the screen
 * they were just looking at — found nothing at all unless they happened to know
 * it was @madi. Typing any word of a name now finds them, in any case, because
 * `searchPrefixes` lowercases what it stores.
 *
 * Deliberately not scoped to the caller's community: the app is used to find
 * people you are not yet sharing books with, and `users` is readable to any
 * signed-in caller by design (see the rules header). What the limits still are
 * — prefix from a word boundary, no fuzziness, no ranking — is written down in
 * utils/search.js, and the step after this one is a real search service.
 */
export async function searchUsers(qStr, { pageSize = SEARCH_RESULT_MAX } = {}) {
  const term = searchTerm(qStr);
  if (!term) return [];
  return getCollection("users", {
    where: [["searchPrefixes", "array-contains", term]],
    pageSize,
  });
}

// ---------- Follows ----------
//
// The subscription graph: one document per "A follows B", at the id `A__B`.
// Following is one-directional and not symmetric — B following back is a second
// document — which is the one way this differs from a chat id.
//
// Every write here maintains two things that must not be able to disagree: the
// edge itself, and the two denormalised counters (`followersCount` on the person
// being followed, `followingCount` on the follower). The edge is the fact and is
// always written first; the counters are a summary of it, kept because a profile
// cannot count a collection it would have to page through to total. The security
// rules lean on that ordering: a +1 on somebody else's `followersCount` is only
// accepted while the matching follow document exists, and a −1 only once it is
// gone, so a caller cannot move a stranger's counter without leaving the edge
// behind that explains it.
//
// Both directions undo themselves on a refused counter write, so the pair is
// never left half-applied — the same arrangement `togglePostLike` uses, and for
// the same reason: the person who tapped saw one action, not three writes.

/** How many rows a followers/following list returns. */
export const FOLLOW_PAGE_MAX = 200;

/** Is `followerId` following `followingId`? One get() at a known path. */
export async function isFollowing(followerId, followingId) {
  if (!followerId || !followingId || followerId === followingId) return false;
  return Boolean(await getOne("follows", followIdFor(followerId, followingId)));
}

/** The people following `userId`, newest first. */
export async function listFollowers(userId, { pageSize = FOLLOW_PAGE_MAX } = {}) {
  if (!userId) return [];
  return getCollection("follows", {
    where: [["followingId", "==", userId]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
}

/** The people `userId` follows, newest first. */
export async function listFollowing(userId, { pageSize = FOLLOW_PAGE_MAX } = {}) {
  if (!userId) return [];
  return getCollection("follows", {
    where: [["followerId", "==", userId]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
}

/**
 * Move one of a profile's follow counters by ±1.
 *
 * A delta rather than a computed total, so two people following the same person
 * in the same second both count. The localStorage branch clamps at zero for the
 * same reason the rules do: a negative follower count is not a number anybody
 * should ever be shown.
 */
async function adjustFollowCount(userId, field, delta) {
  if (!userId) throw new Error("adjustFollowCount: missing userId");
  if (delta === 0) return;
  return runFs(`adjustFollowCount.${field}`, async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, "users", userId), { [field]: increment(delta) });
      return;
    }
    const data = readLS();
    const idx = (data.users || []).findIndex((r) => r.id === userId);
    if (idx < 0) throw new Error(`adjustFollowCount: no user ${userId}`);
    const stored = Number.isInteger(data.users[idx][field]) ? data.users[idx][field] : 0;
    data.users[idx] = { ...data.users[idx], [field]: Math.max(0, stored + delta) };
    writeLS(data);
  });
}

/** A counter that has nothing left to subtract — an old profile, or a lost write. */
async function canDecrement(userId, field) {
  const person = await getOne("users", userId).catch(() => null);
  return Number.isInteger(person?.[field]) && person[field] > 0;
}

/**
 * Follow somebody.
 *
 * Idempotent: following a person you already follow is a no-op that reports
 * `changed: false`, not a second edge and not a second +1. That matters more
 * than it sounds — the button is one tap away from being double-tapped, and the
 * counter is the part a duplicate would corrupt permanently.
 *
 * @returns `{ following: true, changed }` — `changed` is false when the edge was
 *   already there, which is how a caller knows whether to notify anybody.
 */
export async function followUser({ followerId, followingId } = {}) {
  const id = followIdFor(followerId, followingId);
  if (await getOne("follows", id)) return { following: true, changed: false };

  await createOne("follows", normalizeNewFollow({ followerId, followingId }));

  try {
    await adjustFollowCount(followingId, "followersCount", 1);
  } catch (err) {
    // The edge is what the rules read to allow the +1, so it cannot be left
    // behind a counter that never moved: the next unfollow would then subtract
    // from a total this follow never added to.
    await deleteOne("follows", id).catch((undoErr) => {
      logger.error("firestore.followUser.undo", undoErr?.message, { followerId, followingId });
    });
    throw err;
  }

  try {
    await adjustFollowCount(followerId, "followingCount", 1);
  } catch (err) {
    await Promise.all([
      adjustFollowCount(followingId, "followersCount", -1),
      deleteOne("follows", id),
    ].map((p) => p.catch((undoErr) => {
      logger.error("firestore.followUser.undo", undoErr?.message, { followerId, followingId });
    })));
    throw err;
  }

  return { following: true, changed: true };
}

/**
 * Stop following somebody. The mirror of `followUser`, in the mirror order: the
 * edge goes first here too, because that is the state the rules require before
 * they will accept a −1.
 */
export async function unfollowUser({ followerId, followingId } = {}) {
  const id = followIdFor(followerId, followingId);
  if (!(await getOne("follows", id))) return { following: false, changed: false };

  // Read both counters before the edge goes, while there is still something to
  // check against: an account that predates follows carries neither field, and
  // asking the rules to take one below zero is a denied write, not a smaller
  // number. Same guard `togglePostLike` puts in front of an unlike.
  const [followersMovable, followingMovable] = await Promise.all([
    canDecrement(followingId, "followersCount"),
    canDecrement(followerId, "followingCount"),
  ]);

  await deleteOne("follows", id);

  try {
    if (followersMovable) await adjustFollowCount(followingId, "followersCount", -1);
    if (followingMovable) await adjustFollowCount(followerId, "followingCount", -1);
  } catch (err) {
    // Put the edge back rather than leave a profile that says it is not
    // following somebody whose counter still says otherwise.
    await createOne("follows", normalizeNewFollow({ followerId, followingId })).catch((undoErr) => {
      logger.error("firestore.unfollowUser.undo", undoErr?.message, { followerId, followingId });
    });
    throw err;
  }

  return { following: false, changed: true };
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
 *   genres       `array-contains`(-any) over `genres`, up to
 *                MAX_GENRE_FILTER values — so a book filed under
 *                ["fiction","history"] answers for history as well as for
 *                fiction. `genre` is only ever `genres[0]` and exists for the
 *                security rules, not because a book has one genre.
 *
 *                The exception is a genre asked for at the same time as a
 *                search: only one array clause is allowed per query and the
 *                search holds it, so that combination falls back to `genre in`
 *                and sees primary genres only.
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

  const term = searchTerm(search);

  const genreList = (Array.isArray(genres) ? genres : []).filter(Boolean);
  if (genreList.length) {
    if (genreList.length > MAX_GENRE_FILTER) {
      throw new Error(`listBooks: at most ${MAX_GENRE_FILTER} genres may be filtered at once`);
    }
    if (term) {
      // Firestore accepts one array clause per query, and the search below has
      // already claimed it. So a genre asked for *while searching* falls back
      // to `genre` — the primary — and a book whose second genre matches is
      // missed. It is the narrower answer, and it is the one this query could
      // always give; widening it needs the genre filter to move off the server,
      // which would make `hasMore` a statement about rows nobody asked for.
      wheres.push(["genre", "in", genreList]);
    } else {
      // The whole array, so a book counts under every genre it claims and not
      // merely the one that happens to be first. `array-contains-any` and
      // `array-contains` read the same CONTAINS index; the single-value form is
      // used when there is one genre because it is the cheaper of the two.
      wheres.push(genreList.length === 1
        ? ["genres", "array-contains", genreList[0]]
        : ["genres", "array-contains-any", genreList]);
    }
  }

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
/**
 * Hand a book from a departing member to somebody else.
 *
 * The admin's tool, used when a member is ejected: every book physically with
 * that member has to end up somewhere, and the alternative to naming a keeper
 * is a book recorded as being in the hands of somebody who is no longer in the
 * community — invisible to everyone and reachable by nobody.
 *
 * Three things move together, which is why this is one call rather than three
 * writes at the call site:
 *
 *   · Any loan the departing member had open is completed. It has to be: the
 *     book is not with them any more, and an active borrowing left behind
 *     follows the person, blocking them from borrowing wherever they go next.
 *   · The book becomes `available` with its new holder rather than `unavailable`
 *     to them. They were handed it; they did not ask to read it, and marking it
 *     as their active read would put a book on their profile they never took.
 *   · Ownership follows the holder only when the departing member owned it —
 *     `transferOwnership`, decided by the caller. A copy somebody else owns
 *     keeps its owner; a copy the leaver owned would otherwise be left
 *     belonging to an outsider, which is the same orphan in a different field.
 */
export async function reassignHeldBook({ bookId, toUserId, transferOwnership = false } = {}) {
  if (!bookId) throw new Error("reassignHeldBook: missing bookId");
  if (!toUserId) throw new Error("reassignHeldBook: missing toUserId");

  const book = await getBook(bookId);
  if (!book) throw new Error("reassignHeldBook: book not found");

  const active = await getActiveBorrowingByBook(bookId).catch(() => null);
  if (active?.id) {
    await updateBorrowing(active.id, { status: "completed", returnDate: Date.now() });
  }

  const patch = { holderId: toUserId, status: "available", borrowerId: null };
  await updateBook(bookId, patch);
  if (transferOwnership) await reassignBookOwner(bookId, toUserId);

  return {
    ...book,
    ...patch,
    ownerId: transferOwnership ? toUserId : book.ownerId ?? null,
  };
}

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
//
// Written through the schema like every other create in this file. It used to
// be the one exception, which is exactly why it could produce a post with no
// `isPublic` (invisible to everyone outside the community, silently) and no
// `likeCount` (a total the feed had to invent). Both are now part of what a post
// *is* — see `normalizeNewPost`.
export async function createPost(payload) {
  return createOne("posts", normalizeNewPost(payload));
}

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
 * Move a post's like total by one, as a delta rather than as a number.
 *
 * This is the difference between a total everybody agrees on and a total that
 * quietly loses likes. The old code read the counter, added one in JavaScript
 * and wrote the result back: two people liking the same post within the same
 * second both read 4, both wrote 5, and one of the likes was gone — with no
 * error anywhere, because each write was individually valid. `increment()` is
 * resolved by the server against whatever the stored value is at the moment it
 * lands, so concurrent likes add up.
 *
 * The security rule sees the resolved value, not the sentinel, so the ±1 bound
 * still holds — which is what stops this from being a way to write an arbitrary
 * number onto somebody else's post.
 */
async function adjustPostLikeCount(postId, delta) {
  return runFs("adjustPostLikeCount", async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, "posts", postId), { likeCount: increment(delta) });
      return;
    }
    // A single browser tab against its own localStorage: no second writer to
    // race, so read-modify-write is the honest implementation of the same thing.
    const data = readLS();
    const idx = (data.posts || []).findIndex((r) => r.id === postId);
    if (idx < 0) throw new Error(`adjustPostLikeCount: no post ${postId}`);
    const stored = Number.isInteger(data.posts[idx].likeCount) ? data.posts[idx].likeCount : 0;
    data.posts[idx] = { ...data.posts[idx], likeCount: Math.max(0, stored + delta) };
    writeLS(data);
  });
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
 * They are one action to the person who tapped, so they succeed or fail
 * together. The counter failing used to be logged and swallowed: the profile
 * kept the like, the screen kept its optimistic +1, and every *other* reader saw
 * a total that was never written — the like was real to exactly one person.
 * Now a refused counter puts the profile back and the failure reaches the
 * caller, whose screen is the only thing that can undo what it drew.
 *
 * @returns `{ likedPostIds, likeDelta, changed }` — `likeDelta` is what the
 *   total actually moved by, which is 0 when there was nothing to subtract.
 */
export async function togglePostLike({ postId, userId, likedPostIds = [], liked }) {
  if (!postId || !userId) throw new Error("togglePostLike: missing postId or userId");

  const current = Array.isArray(likedPostIds) ? likedPostIds : [];
  const has = current.includes(postId);
  const next = liked ?? !has;
  if (next === has) return { likedPostIds: current, likeDelta: 0, changed: false };

  const updatedIds = next
    ? [postId, ...current.filter((id) => id !== postId)]
    : current.filter((id) => id !== postId);

  // Unliking is the one direction that can be refused outright: the rule will
  // not take the counter below zero, so a post whose stored total is already 0
  // — a legacy post with no counter, or one whose likes were lost to the race
  // above — has nothing to subtract. Reading it first is cheaper than a denied
  // write, and the write itself is still a delta, so this is a guard against
  // the degenerate case rather than a read the increment depends on.
  let delta = next ? 1 : -1;
  if (!next) {
    const post = await getOne("posts", postId);
    if (!Number.isInteger(post?.likeCount) || post.likeCount <= 0) delta = 0;
  }

  await updateUser(userId, { likedPostIds: updatedIds });

  if (delta !== 0) {
    try {
      await adjustPostLikeCount(postId, delta);
    } catch (err) {
      await updateUser(userId, { likedPostIds: current }).catch((undoErr) => {
        logger.error("firestore.togglePostLike.undo", undoErr?.message, { postId, userId });
      });
      throw err;
    }
  }

  return { likedPostIds: updatedIds, likeDelta: delta, changed: true };
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
  return getCollection("posts", { ...publicPostsQuery(pageSize) });
}

function publicPostsQuery(pageSize) {
  return {
    where: [["isPublic", "==", true]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  };
}

/**
 * The same discovery feed, kept open — see `watchCollection`.
 *
 * Home uses this rather than `listPublicPosts` so that a post published while
 * somebody is looking at the feed arrives on its own, and so that a like landing
 * on a post already on screen moves the number every reader can see. Both are
 * the same mechanism: the query result changed, so the screen changed.
 */
export function watchPublicPosts({ pageSize = PUBLIC_FEED_MAX, ...handlers } = {}) {
  return watchCollection("posts", publicPostsQuery(pageSize), handlers);
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
  return getCollection("posts", communityPostsQuery(communityId, pageSize));
}

/** How many of somebody's posts a profile counts. A cap, not a page. */
export const POSTS_BY_AUTHOR_MAX = 200;

/**
 * Everything one person has posted, as far as this caller is allowed to see it.
 *
 * The second filter is not optional and not a refinement — it is what makes the
 * query legal. The rules can allow or deny a query but never filter one, so a
 * post list has to *name* the ground it stands on: either the community the
 * caller belongs to, or the public flag. `authorId` alone would be refused
 * outright, which is a denied read rather than a smaller answer.
 *
 * Both shapes are equality-only with no ordering, so Firestore serves them by
 * merging the single-field indexes it maintains on its own — no composite index,
 * and nothing to add to firestore.indexes.json.
 *
 * It follows that the number this produces is the number *this viewer* may see,
 * which is the honest one to show them: a stranger counting somebody's posts
 * from outside their community is counting the public ones, because those are
 * the only ones that exist as far as they are concerned.
 */
export async function listPostsByAuthor({ authorId, communityId = null, pageSize = POSTS_BY_AUTHOR_MAX } = {}) {
  if (!authorId) return [];
  return getCollection("posts", {
    where: [
      ["authorId", "==", authorId],
      communityId ? ["communityId", "==", communityId] : ["isPublic", "==", true],
    ],
    pageSize,
  });
}

function communityPostsQuery(communityId, pageSize) {
  return {
    where: [["communityId", "==", communityId]],
    orderByField: "createdAt",
    descending: true,
    pageSize,
  };
}

/** A community's noticeboard, kept open — the member's half of the Home feed. */
export function watchPostsByCommunity(communityId, { pageSize = 100, ...handlers } = {}) {
  if (!communityId) return () => {};
  return watchCollection("posts", communityPostsQuery(communityId, pageSize), handlers);
}

// There is no global post feed, and there cannot be one: `posts` is readable
// only to members of the owning community, and a rule is checked against the
// query, so an unscoped list is denied rather than filtered. `listAllPosts`
// used to be defined here, had no callers, and would have thrown for every one
// it might have had.

// ---------- Comments ----------
//
// Replies under a post. The audience is copied onto every comment at creation
// (see schema.js), which is what makes both halves of this cheap: a list is one
// indexed query with no document reads spent in the rules, and the counter on
// the post is the only thing that has to be maintained alongside.

/** How many replies one post's thread loads. A cap, not a page. */
export const COMMENT_PAGE_MAX = 200;

/** The `where` clause that makes a comment query legal for this caller. */
function commentAudience(communityId) {
  // Same rule the post itself is read under: the caller's own community, or
  // the public flag. Naming one of the two is not optional — a query the rules
  // cannot prove safe is refused outright rather than trimmed.
  return communityId ? ["communityId", "==", communityId] : ["isPublic", "==", true];
}

/**
 * The thread under one post, oldest first — the order a conversation is read in.
 *
 * Sorted here rather than by the database. Two equality filters with no ordering
 * is a query Firestore serves from the single-field indexes it maintains by
 * itself; adding `orderBy` would make it a composite index for no gain, since a
 * thread is capped at two hundred replies and sorting that in the browser costs
 * nothing measurable.
 */
export async function listComments({ postId, communityId = null, pageSize = COMMENT_PAGE_MAX } = {}) {
  if (!postId) return [];
  const rows = await getCollection("comments", {
    where: [["postId", "==", postId], commentAudience(communityId)],
    pageSize,
  });
  return rows.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
}

/** The same thread, kept open — a reply from somebody else appears by itself. */
export function watchComments({ postId, communityId = null, pageSize = COMMENT_PAGE_MAX } = {}, handlers = {}) {
  if (!postId) return () => {};
  const { onRows, ...rest } = handlers;
  return watchCollection(
    "comments",
    { where: [["postId", "==", postId], commentAudience(communityId)], pageSize },
    {
      ...rest,
      onRows: (rows) => onRows?.([...rows].sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt))),
    }
  );
}

/**
 * Move a post's reply counter by ±1.
 *
 * The mirror of `adjustPostLikeCount`, and it exists for the same reason: the
 * feed shows a total, and counting a collection it would have to page through
 * to total is not something a feed row can do.
 */
async function adjustPostCommentCount(postId, delta) {
  if (!postId) throw new Error("adjustPostCommentCount: missing postId");
  if (delta === 0) return;
  return runFs("adjustPostCommentCount", async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, "posts", postId), { commentCount: increment(delta) });
      return;
    }
    const data = readLS();
    const idx = (data.posts || []).findIndex((r) => r.id === postId);
    if (idx < 0) throw new Error(`adjustPostCommentCount: no post ${postId}`);
    const stored = Number.isInteger(data.posts[idx].commentCount) ? data.posts[idx].commentCount : 0;
    data.posts[idx] = { ...data.posts[idx], commentCount: Math.max(0, stored + delta) };
    writeLS(data);
  });
}

/**
 * Write a reply.
 *
 * Two writes, and they are one action to whoever tapped send: the comment, then
 * the total on the post. A refused counter takes the comment back out rather
 * than leaving a thread whose length nobody else can see — the same undo
 * `togglePostLike` does, for the same reason.
 */
export async function createComment(payload) {
  const comment = await createOne("comments", normalizeNewComment(payload));
  try {
    await adjustPostCommentCount(comment.postId, 1);
  } catch (err) {
    await deleteOne("comments", comment.id).catch((undoErr) => {
      logger.error("firestore.createComment.undo", undoErr?.message, { commentId: comment.id });
    });
    throw err;
  }
  return comment;
}

/**
 * Take a reply back down. The author's own, or a community admin's moderation —
 * the rules decide which, and this call is the same either way.
 */
export async function deleteComment({ id, postId } = {}) {
  if (!id) throw new Error("deleteComment: missing id");
  await deleteOne("comments", id);

  // Nothing to subtract from a counter already at zero: the rules refuse it,
  // and a post whose count was lost to an older build would otherwise be
  // undeletable-from. Same guard an unlike carries.
  if (postId) {
    const post = await getOne("posts", postId).catch(() => null);
    if (Number.isInteger(post?.commentCount) && post.commentCount > 0) {
      await adjustPostCommentCount(postId, -1).catch((err) => {
        // The comment is gone, which is what the caller asked for. A counter
        // one too high is worth a log, not a failure they can act on.
        logger.warn("firestore.deleteComment.count", err?.message, { postId });
      });
    }
  }
}

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

// ---------- Chats ----------
//
// Two collections, one of them nested: `chats/{chatId}` is the conversation and
// `chats/{chatId}/messages` is everything said in it. schema.js explains why the
// id is derived from the pair rather than allocated; what follows is what that
// buys the code here — no "find or create" step anywhere, and no way for two
// devices to open two threads for one pair of people.
//
// The chat document is a rollup of its own subcollection: who is in it, the last
// thing said, when, and one unread counter per member. It exists so the
// conversation list is a single query. Without it that screen would be one
// query per row to find the last message and another to count the unread ones,
// which is the shape that stops working at exactly the point the app starts
// being used.
//
// The rollup is only true if it is written with the message it summarises, so
// both go in one batch: either the message lands and the list moves, or neither
// happens. This is the reason sendMessage does not lean on createOne.

/** One page of a thread. Long enough that scrolling back is rare. */
export const MESSAGE_PAGE_MAX = 200;

/** Conversations per reader. The list is sorted by recency, so this is a tail. */
export const CHAT_LIST_MAX = 100;

/** The subcollection path for one thread's messages. */
function messagesPath(chatId) {
  return `chats/${chatId}/messages`;
}

export async function getChat(chatId) {
  return getOne("chats", chatId);
}

/**
 * Every conversation this reader is in, most recent first.
 *
 * `array-contains` on `memberIds` is what makes one query answer "my chats"
 * without a second collection per user to maintain — and it is the same
 * predicate the security rule requires, so the query and the permission to run
 * it are the same statement.
 *
 * A subscription rather than a fetch: a chat list that only updated on a
 * refresh is a chat list that is wrong, and the unread badge on the tab is read
 * from exactly this data.
 */
export function watchChatsForUser(userId, { pageSize = CHAT_LIST_MAX, ...handlers } = {}) {
  if (!userId) return () => {};
  return watchCollection(
    "chats",
    {
      where: [["memberIds", "array-contains", userId]],
      orderByField: "updatedAt",
      descending: true,
      pageSize,
    },
    handlers
  );
}

/**
 * One thread, live.
 *
 * Ordered newest-first and capped, which is the only way to ask for "the last
 * page" of an unbounded collection — a year-old conversation must not be
 * downloaded in full to show what was said a minute ago. The screen reverses it
 * for display; `listMessages` below returns it already reversed for callers
 * that just want the history.
 */
export function watchMessages(chatId, { pageSize = MESSAGE_PAGE_MAX, ...handlers } = {}) {
  if (!chatId) return () => {};
  return watchCollection(
    messagesPath(chatId),
    { orderByField: "createdAt", descending: true, pageSize },
    handlers
  );
}

/** The last page of a thread, oldest first — reading order. */
export async function listMessages(chatId, pageSize = MESSAGE_PAGE_MAX) {
  if (!chatId) return [];
  const rows = await getCollection(messagesPath(chatId), {
    orderByField: "createdAt",
    descending: true,
    pageSize,
  });
  return rows.reverse();
}

/**
 * Say something to somebody.
 *
 * Creates the conversation if this is the first thing said in it — a chat is
 * born from a message, never from somebody opening a profile, which is what
 * keeps empty threads out of both people's lists.
 *
 * The unread counter moves here rather than on the recipient's device, because
 * the recipient may not have one running. It is an `increment`, not a read
 * followed by a write: two messages arriving at once must count as two.
 *
 * @returns the stored message, with the id of the chat it landed in.
 */
export async function sendMessage({ senderId, recipientId, text } = {}) {
  // Throws for a missing id, a self-chat, or an empty message — all of them
  // before anything is written, and all of them the same refusals the rules make.
  const chatId = chatIdFor(senderId, recipientId);
  const memberIds = chatMemberIds(senderId, recipientId);
  const message = normalizeNewMessage({ senderId, text });
  const preview = chatPreviewOf({ senderId, text: message.text });

  return runFs("sendMessage", async () => {
    if (isFirebaseConfigured) {
      const batch = writeBatch(db);
      const messageRef = doc(collection(db, messagesPath(chatId)));

      batch.set(messageRef, { ...message, createdAt: serverTimestamp() });
      // A merge, so the same statement creates the conversation and updates it.
      // `memberIds` is rewritten identically every time rather than only on
      // create: the rules freeze it, so this can only ever be a no-op, and it
      // means a chat document can never exist without one.
      batch.set(doc(db, "chats", chatId), {
        memberIds,
        lastMessage: { ...preview, at: serverTimestamp() },
        updatedAt: serverTimestamp(),
        unread: {
          [recipientId]: increment(1),
          // Whoever is talking has read their own thread by definition. This
          // also clears anything that arrived while they were typing, which is
          // the behaviour every messaging app has and nobody notices.
          [senderId]: 0,
        },
      }, { merge: true });

      await batch.commit();
      return { id: messageRef.id, chatId, ...message };
    }

    // One read/write for both documents, so the fallback is as atomic as a
    // single-threaded browser can make it.
    const data = readLS();
    const messages = messagesPath(chatId);
    data[messages] = data[messages] || [];
    data.chats = data.chats || [];

    // A strictly increasing stamp, not the raw clock. Two messages sent in the
    // same millisecond — which is a keypress apart, not a contrivance — would
    // otherwise tie, and a tie is broken by document id, which is random: the
    // conversation would read back in an order nobody said it in. Firestore's
    // own `serverTimestamp()` has microsecond resolution and does not need
    // this; the fallback owns its clock, so it fixes it here.
    const latest = data[messages].reduce((max, m) => Math.max(max, m.createdAt || 0), 0);
    const now = Math.max(Date.now(), latest + 1);
    const stored = { ...message, id: uid(), createdAt: now };
    data[messages].push(stored);

    const idx = data.chats.findIndex((c) => c.id === chatId);
    const previous = idx >= 0 ? data.chats[idx] : null;
    const chat = {
      ...(previous ?? normalizeNewChat({ senderId, recipientId })),
      id: chatId,
      memberIds,
      lastMessage: { ...preview, at: now },
      updatedAt: now,
      unread: {
        ...(previous?.unread ?? {}),
        [recipientId]: (previous?.unread?.[recipientId] ?? 0) + 1,
        [senderId]: 0,
      },
    };
    if (idx >= 0) data.chats[idx] = chat;
    else data.chats.push(chat);

    writeLS(data);
    return { id: stored.id, chatId, ...message };
  });
}

/**
 * Mark a thread read for one member — what opening it does.
 *
 * Two fields, both the caller's own and both written by name: a dotted path, so
 * the other member's count and watermark survive, which a whole-map write would
 * not. `readAt` is what turns the sender's ticks blue; see `messageStatus` in
 * schema.js for why it is a watermark rather than a flag on every message.
 *
 * Callers should skip this when the counter is already zero *and* the watermark
 * already covers the last message — see `needsReadReceipt` — so opening a quiet
 * chat costs nothing.
 */
export async function markChatRead({ chatId, userId } = {}) {
  if (!chatId || !userId) return null;

  return runFs("markChatRead", async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, "chats", chatId), {
        [`unread.${userId}`]: 0,
        [`readAt.${userId}`]: serverTimestamp(),
      });
      return { id: chatId };
    }
    const data = readLS();
    const idx = (data.chats || []).findIndex((c) => c.id === chatId);
    if (idx < 0) return null;
    data.chats[idx] = {
      ...data.chats[idx],
      unread: { ...(data.chats[idx].unread ?? {}), [userId]: 0 },
      readAt: { ...(data.chats[idx].readAt ?? {}), [userId]: Date.now() },
    };
    writeLS(data);
    return data.chats[idx];
  });
}

/**
 * "Their app has it" — the second tick.
 *
 * Written by the *recipient's* device, because that is the only party that can
 * honestly claim delivery. It is one write per arrival rather than per message:
 * the watermark covers everything older than it, so a burst of five messages
 * received together costs the same as one.
 *
 * Deliberately not written by the sender at send time. That would be the sender
 * asserting something about somebody else's phone, which is exactly what a
 * delivery receipt is supposed not to be.
 */
export async function markChatDelivered({ chatId, userId } = {}) {
  if (!chatId || !userId) return null;

  return runFs("markChatDelivered", async () => {
    if (isFirebaseConfigured) {
      await updateDoc(doc(db, "chats", chatId), {
        [`deliveredAt.${userId}`]: serverTimestamp(),
      });
      return { id: chatId };
    }
    const data = readLS();
    const idx = (data.chats || []).findIndex((c) => c.id === chatId);
    if (idx < 0) return null;
    data.chats[idx] = {
      ...data.chats[idx],
      deliveredAt: { ...(data.chats[idx].deliveredAt ?? {}), [userId]: Date.now() },
    };
    writeLS(data);
    return data.chats[idx];
  });
}

/**
 * Does this member owe the other one a receipt for what is on screen?
 *
 * Both halves matter. The counter alone would skip the write for a thread the
 * reader is already sitting in when a message arrives — it is zeroed on open,
 * so the reader would be looking at a message whose sender never sees it turn
 * blue. The watermark alone would keep writing for a thread with nothing new.
 */
export function needsReadReceipt(chat, userId) {
  if (!chat || !userId) return false;
  if (unreadFor(chat, userId) > 0) return true;
  const last = toMillis(chat.lastMessage?.at);
  return last > 0 && last > chatWatermark(chat, "readAt", userId);
}

/** The same question for delivery, asked by whoever just received something. */
export function needsDeliveryReceipt(chat, userId) {
  if (!chat || !userId) return false;
  // Nothing to acknowledge about your own message.
  if (!chat.lastMessage?.senderId || chat.lastMessage.senderId === userId) return false;
  const last = toMillis(chat.lastMessage?.at);
  return last > 0 && last > chatWatermark(chat, "deliveredAt", userId);
}

// ---------- Presence ----------
//
// "Online" without a presence server.
//
// Firestore has no connection state — that is the Realtime Database's
// `onDisconnect`, a second product with a second SDK and a second set of rules.
// What it has is documents, so presence here is a heartbeat: an app that is
// open and visible stamps `lastActiveAt` on its own profile every
// PRESENCE_HEARTBEAT_MS, and anybody reading that profile calls it online while
// the stamp is fresher than PRESENCE_WINDOW_MS.
//
// The window is deliberately wider than the heartbeat. A phone that misses one
// beat — a tunnel, a locked screen for a moment, a slow write — is not somebody
// who left, and a status that flickers is worse than one that lags.
//
// What this cannot do is notice a disconnection. Closing the app writes
// nothing (`beforeunload` does not survive a phone being locked, and a killed
// tab never runs it at all), so somebody who leaves reads as online until their
// stamp goes stale. That is the honest cost of not running a presence server,
// and it is why the window is a minute rather than ten.

/** How often an open app says it is still here. */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** How long a stamp counts as "now". Two missed beats, plus room to write. */
export const PRESENCE_WINDOW_MS = 75_000;

/**
 * Stamp this user as active. Called on a timer by the app; safe to spam.
 *
 * Goes straight to `updateOne` rather than through `updateUser`, which would
 * check whether the patch touches a name and possibly read the profile first —
 * a read this write can never need.
 */
export async function touchPresence(userId) {
  if (!userId) return null;
  return updateOne("users", userId, {
    lastActiveAt: isFirebaseConfigured ? serverTimestamp() : Date.now(),
  });
}

/** Is this profile's heartbeat fresh enough to call them online? */
export function isOnline(user, now = Date.now()) {
  const at = toMillis(user?.lastActiveAt, 0);
  return at > 0 && now - at < PRESENCE_WINDOW_MS;
}

/** When they were last seen, in ms, or 0 for a profile that never reported. */
export function lastSeenAt(user) {
  return toMillis(user?.lastActiveAt, 0);
}

/** How many messages in this chat this reader has not opened yet. */
export function unreadFor(chat, userId) {
  const count = chat?.unread?.[userId];
  return typeof count === "number" && count > 0 ? count : 0;
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

/**
 * The other side of the same list: every return where this member is the one
 * handing a book over, rather than the one collecting it.
 *
 * A return names the collector in `requesterId`, so the query above cannot see
 * these — the leave screen was blind to exactly the errands its own rules block
 * on, and sent the member to another screen to find them.
 *
 * Scoped by community because the rules require it. A `list` is checked against
 * the query, and `holderId` is not one of the disjuncts it accepts; the
 * community equality is, and it is also the only scope in which the answer means
 * anything — a handover is always inside one community.
 */
export async function listPendingReturnsForHolder({ holderId, communityId } = {}) {
  if (!holderId || !communityId) return [];
  return getCollection("requests", {
    where: [
      ["communityId", "==", communityId],
      ["type", "==", "return"],
      ["status", "==", "pending"],
      ["holderId", "==", holderId],
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
    // The book's own community, not the caller's idea of it. The rules accept a
    // return only when its `communityId` is the one on the requester's profile,
    // and a screen that passes a route parameter instead is a screen that can
    // pass a stale one — which the server then refuses with nothing on it to say
    // why. The book knows where it lives; nobody else has to be right about it.
    communityId: book.communityId || communityId,
    requesterId,
    requesterName,
    holderId,
    bookName: book.name,
    returnCode: returnCode || newPickupCode(),
    reservedBook,
    openedBy: "owner",
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
 * The same handover, offered from the other end: the holder wants to give the
 * book back.
 *
 * Until this existed, that was the one handoff in the app with no code in it.
 * A pickup is two people agreeing; the owner asking for a book back is two
 * people agreeing; and handing a book home was one person pressing a button and
 * the app telling its owner afterwards that it had happened. The owner had no
 * say in a claim about where their own property physically was.
 *
 * So it opens the *same document* the owner's own flow opens, with the same
 * fields in the same places: `requesterId` is the owner, because they are the
 * one collecting, and `holderId` is whoever is handing it over. Everything
 * downstream — the code screen, `completeReturnToOwner`, the sweep of stale and
 * expired requests, the pickup screen's "is this copy already going home?" —
 * therefore works on it unchanged, and cannot tell which end started it.
 *
 * Who ends up with the four digits is not a detail. They go to the person
 * handing the book over, and the person receiving it types them in; that is
 * what makes the code a handshake rather than a confirm button, and it is the
 * arrangement a pickup already uses. Here the giver is the caller, so the code
 * comes back in the return value for their own screen to show, and the owner is
 * merely told that a return is waiting for them.
 *
 * The book is NOT reserved. That lane belongs to the owner in the security
 * rules, and it is not needed: `openPickupRequest` refuses any book with an
 * open return, so the copy is already out of reach of a third reader.
 *
 * @returns `{ request, created, book, alreadyHome }` — when `created` is false
 *   a return was already open, and the caller must NOT notify again.
 */
export async function offerReturnToOwner({ bookId, holderId } = {}) {
  if (!bookId || !holderId) {
    throw new Error("offerReturnToOwner: bookId and holderId are required");
  }

  const book = await getBook(bookId);
  if (!book) throw new Error("offerReturnToOwner: book not found");

  const ownerId = book.ownerId;
  if (!ownerId) throw new Error("offerReturnToOwner: book has no owner");

  // Already home — the caller's goal is met. Not an error, and not a request:
  // there is nobody on the other side of this handover.
  if (ownerId === holderId) {
    return { request: null, created: false, book, alreadyHome: true };
  }
  if (holderIdOf(book) !== holderId) {
    throw new Error("offerReturnToOwner: only the current holder may hand a book back");
  }

  // Idempotent against *any* open return on this book, not just one this holder
  // opened. The owner may have asked for it first, in which case a code is
  // already out with somebody — and two codes for one handover is one code that
  // does not work.
  const existing = await getPendingReturnForBook({ bookId, communityId: book.communityId });
  if (existing) return { request: existing, created: false, book, alreadyHome: false };

  const request = await createReturnRequest({
    bookId,
    communityId: book.communityId,
    // The collector is the owner named on the book, never the caller's idea of
    // who that is — the security rule checks this against the book document for
    // the same reason.
    requesterId: ownerId,
    holderId,
    bookName: book.name,
    returnCode: newPickupCode(),
    reservedBook: false,
    // The one field that records which end opened this, and the only thing the
    // two flows disagree about: an offer may be withdrawn by whoever made it,
    // and an owner's demand for their own property may not be called off by the
    // person holding it. See schema.js.
    openedBy: "holder",
  });

  return { request, created: true, book, alreadyHome: false };
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

// ---------- Phone verifications ----------
//
// One document per attempt to prove a phone number, keyed by the token that
// travels in the Telegram deep link. See firebase/phoneVerify.js for the flow;
// what matters here is who writes what:
//
//   the client  creates the attempt (its own userId, the number it claims, the
//               channel it picked) and may cancel it. That is all it can do.
//   the bot     reads the attempt by token, compares the number on the contact
//               card Telegram vouches for against the claim, and only then writes
//               the profile. It does that with the Admin SDK, which bypasses
//               the rules entirely, because there is no client claim the rules
//               could check any more: with Firebase SMS the proven number
//               arrived in the ID token, and with a bot it arrives at a server.
//
// The client therefore never writes `phone` or `phoneVerifiedAt` — the rules
// refuse it outright — and this collection is the only thing standing between
// "I typed a number" and "somebody messaged us from it".

/** A verification attempt, at a known id: the token is the document. */
export async function createPhoneVerification(token, payload) {
  if (!token) throw new Error("createPhoneVerification: missing token");
  return setOne("phoneVerifications", token, payload);
}

export async function getPhoneVerification(token) {
  return getOne("phoneVerifications", token);
}

/** The subject giving up on their own attempt — the one update they may make. */
export async function cancelPhoneVerification(token) {
  if (!token) return null;
  return updateOne("phoneVerifications", token, { status: "cancelled" });
}

/**
 * Watch one attempt until the bot resolves it.
 *
 * Real-time where there is a real database, and a poll where there is not: the
 * localStorage fallback has no change feed, and a screen that only worked with
 * Firebase configured would be the first in this project that did not.
 *
 * @returns an unsubscribe function — call it on unmount, always.
 */
export function watchPhoneVerification(token, onChange, { pollMs = 2000 } = {}) {
  if (!token || typeof onChange !== "function") return () => {};

  if (isFirebaseConfigured) {
    return onSnapshot(
      doc(db, "phoneVerifications", token),
      (snap) => onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      (err) => logger.error("firestore.watchPhoneVerification", err?.message, { code: err?.code })
    );
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    onChange(await getOne("phoneVerifications", token));
  };
  tick();
  const id = setInterval(tick, pollMs);
  return () => { stopped = true; clearInterval(id); };
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
/** How many stops of a book's history one screen will draw. */
export const BOOK_JOURNEY_MAX = 60;

/**
 * Every loan of one book, oldest first — the book's journey.
 *
 * Ascending, unlike every other list in this file, because this one is read as
 * a story rather than a feed: a book starts with its owner and passes from hand
 * to hand, and the interesting end of that is where it is *now*, at the bottom.
 *
 * Capped rather than paged. Sixty stops is a book that has been round a
 * community for years, and a journey is a thing you look at, not a thing you
 * scroll for ever — the alternative is a cursor and a "load more" on a screen
 * nobody will reach the bottom of.
 *
 * Loans are readable by any signed-in caller (see limit (1) in the rules
 * header), so this needs no community filter to be *allowed* — but the book
 * itself is community-scoped, so a caller who cannot read the book never gets
 * as far as asking.
 */
export async function listBorrowingsForBook(bookId, { pageSize = BOOK_JOURNEY_MAX } = {}) {
  if (!bookId) return [];
  return getCollection("borrowings", {
    where: [["bookId", "==", bookId]],
    orderByField: "createdAt",
    pageSize,
  });
}

/**
 * The people in a journey, fetched once each.
 *
 * A book that has been round a community of ten twenty times names ten people
 * across twenty loans, and a lookup per loan would be twenty reads for ten
 * answers. Mirrors `getBooksByIds`: bounded concurrency, misses dropped rather
 * than failing the batch — a reader whose account is gone should leave a gap in
 * the story, not break the screen.
 */
export async function getUsersByIds(userIds, concurrency = 5) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return {};

  const found = {};
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const rows = await Promise.all(batch.map((id) => getUserById(id).catch(() => null)));
    batch.forEach((id, n) => { found[id] = rows[n] ?? null; });
  }
  // A plain object, not a Map: this is cached by React Query and persisted to
  // IndexedDB through a JSON serializer, which turns a Map into `{}`.
  return found;
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