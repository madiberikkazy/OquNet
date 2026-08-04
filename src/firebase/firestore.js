// Firestore data layer with a transparent localStorage fallback.
// Collections: users, communities, books, posts, notifications, requests, borrowings, ratings, reviews

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, serverTimestamp,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "./config.js";
import { logger } from "../utils/logger.js";
import { clampStars, aggregateFromRatings } from "../utils/rating.js";
import { holderIdOf } from "../utils/bookHolder.js";

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
    users: [], communities: [], books: [], posts: [],
    notifications: [], requests: [], borrowings: [], ratings: [], reviews: [],
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
async function getCollection(name, { where: wheres = [], orderByField, descending = false, pageSize, cursor } = {}) {
  if (isFirebaseConfigured) {
    const constraints = wheres.map(([f, op, v]) => where(f, op, v));
    if (orderByField) constraints.push(orderBy(orderByField, descending ? "desc" : "asc"));
    if (cursor) constraints.push(startAfter(cursor));
    if (pageSize) constraints.push(limit(pageSize));
    const q = query(collection(db, name), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
  if (orderByField) {
    rows = [...rows].sort((a, b) => {
      const av = a[orderByField] ?? 0;
      const bv = b[orderByField] ?? 0;
      return descending ? bv - av : av - bv;
    });
  }
  if (pageSize) rows = rows.slice(0, pageSize);
  return rows;
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

async function createOne(name, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("createOne: payload must be an object");
  }
  return runFs(`createOne.${name}`, async () => {
    if (isFirebaseConfigured) {
      if (payload.id) {
        await setDoc(doc(db, name, payload.id), { ...payload, createdAt: serverTimestamp() });
        return payload;
      }
      const ref = await addDoc(collection(db, name), { ...payload, createdAt: serverTimestamp() });
      return { id: ref.id, ...payload };
    }
    const data = readLS();
    const record = { id: payload.id || uid(), createdAt: Date.now(), ...payload };
    data[name] = data[name] || [];
    data[name].push(record);
    writeLS(data);
    return record;
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
export async function createUserDoc(profile) { return createOne("users", profile); }
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
export async function listUsersByCommunity(communityId) {
  return getCollection("users", { where: [["communityId", "==", communityId]] });
}
export async function searchUsers(qStr) {
  const rows = await getCollection("users");
  const s = qStr.toLowerCase();
  return rows.filter(
    (u) =>
      u.nickname?.toLowerCase().includes(s) ||
      u.firstName?.toLowerCase().includes(s) ||
      u.lastName?.toLowerCase().includes(s)
  );
}

// ---------- Communities ----------
export async function getCommunityByNickname(nickname) {
  const rows = await getCollection("communities", { where: [["nickname", "==", nickname]] });
  return rows[0] || null;
}
export async function createCommunity(payload) { return createOne("communities", payload); }
export async function getCommunity(id) { return getOne("communities", id); }
export async function updateCommunity(id, patch) { return updateOne("communities", id, patch); }
export async function searchCommunities(qStr) {
  const rows = await getCollection("communities");
  const s = qStr.toLowerCase();
  return rows.filter((c) => c.nickname?.toLowerCase().includes(s) || c.name?.toLowerCase().includes(s));
}
export async function listCommunities() { return getCollection("communities"); }

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

export async function createBook(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("createBook: payload must be an object");
  }
  if (!payload.ownerId) throw new Error("createBook: missing ownerId");
  // A book starts out with its owner — always, not merely by default. It has
  // never been handed over, so there is nowhere else for it to be, and storing
  // `holderId` here means the read path never has to infer it. A caller that
  // asks for anything else is describing a handoff, which is `transferBookHolder`.
  if (payload.holderId && payload.holderId !== payload.ownerId) {
    logger.warn("firestore.createBook", "a new book starts with its owner; holderId overridden", {
      ownerId: payload.ownerId, attempted: payload.holderId,
    });
  }
  return createOne("books", { ...payload, holderId: payload.ownerId });
}
export async function listBooks({ communityId, search, status, genres, pageSize = 30, cursor = null } = {}) {
  const wheres = [];
  if (communityId) wheres.push(["communityId", "==", communityId]);
  if (status) wheres.push(["status", "==", status]);
  let rows = await getCollection("books", { where: wheres, pageSize: pageSize + 1, cursor }); // +1 to detect if there are more
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((b) => b.name?.toLowerCase().includes(s) || b.author?.toLowerCase().includes(s));
  }
  // Genre filtering is client-side (multi-select, no Firestore compound index needed)
  if (genres && genres.length > 0) {
    rows = rows.filter((b) => genres.includes(b.genre));
  }
  
  // Check if there are more results
  let hasMore = false;
  let nextCursor = null;
  if (rows.length > pageSize) {
    hasMore = true;
    rows = rows.slice(0, pageSize);
    nextCursor = rows[rows.length - 1] || null;
  }
  
  return { items: rows, nextCursor, hasMore };
}

/**
 * Rating summaries for a page of books, as bookId -> { count, average, sum }.
 *
 * Books carry their own denormalised counters, so the common case costs zero
 * extra reads. Only documents written before those counters existed are backed
 * by a fan-out over the ratings collection — and rating one of them repairs it
 * for good (see recalcBookRating).
 */
export async function getRatingSummaries(books, concurrency = 5) {
  const summaries = {};
  const legacyIds = [];

  for (const book of books || []) {
    if (book?.ratingCount == null) {
      legacyIds.push(book.id);
      continue;
    }
    const count = Number(book.ratingCount) || 0;
    const sum = Number(book.ratingSum);
    summaries[book.id] = {
      count,
      sum: Number.isFinite(sum) ? sum : count * (Number(book.rating) || 0),
      average: count ? (Number.isFinite(sum) ? sum / count : Number(book.rating) || 0) : 0,
    };
  }

  if (legacyIds.length) {
    Object.assign(summaries, await listRatingsForBooks(legacyIds, concurrency));
  }
  return summaries;
}

/**
 * Batch fetch ratings for multiple books with concurrency control
 */
export async function listRatingsForBooks(bookIds, concurrency = 5) {
  if (!bookIds || bookIds.length === 0) return {};
  
  // Return map of bookId -> { count, average }
  const ratingMap = {};
  
  // Initialize all books with empty ratings
  bookIds.forEach((bookId) => {
    ratingMap[bookId] = { count: 0, sum: 0, average: 0 };
  });

  // Fetch ratings in batches
  for (let i = 0; i < bookIds.length; i += concurrency) {
    const batch = bookIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((id) => listRatingsForBook(id))
    );
    
    // Map results back to book IDs
    batchResults.forEach((ratings, idx) => {
      ratingMap[batch[idx]] = aggregateFromRatings(ratings || []);
    });
  }
  
  return ratingMap;
}

export async function getBook(id) { return getOne("books", id); }

/**
 * Update a book. `ownerId` is dropped from the patch — ownership is fixed at
 * creation, and every lending operation goes through here, so the one way to
 * lose an owner is a patch that carries a stale or borrowed `ownerId` along for
 * the ride. Dropping it makes that impossible rather than merely discouraged.
 * Admin correction of a genuinely wrong owner goes through `reassignBookOwner`.
 */
export async function updateBook(id, patch) {
  if (!patch || typeof patch !== "object") throw new Error("updateBook: patch must be an object");
  if ("ownerId" in patch) {
    const { ownerId, ...rest } = patch;
    logger.warn("firestore.updateBook", "ownerId is immutable; dropped from patch", {
      bookId: id, attempted: ownerId,
    });
    return updateOne("books", id, rest);
  }
  return updateOne("books", id, patch);
}

/**
 * Deliberately move ownership — the one sanctioned way. This is a data
 * correction (the admin picked the wrong member when adding the book), not part
 * of lending: it leaves `holderId` alone, because who has the copy right now is
 * unaffected by fixing who it belongs to.
 */
export async function reassignBookOwner(id, ownerId) {
  if (!ownerId) throw new Error("reassignBookOwner: missing ownerId");
  return updateOne("books", id, { ownerId });
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
export async function listPostsByCommunity(communityId, pageSize = 30) {
  // No orderBy here — avoids the Firestore composite index requirement.
  // Sort client-side instead.
  const rows = await getCollection("posts", {
    where: [["communityId", "==", communityId]],
    pageSize,
  });
  return rows.sort((a, b) => {
    const at = a.createdAt?.toMillis?.() ?? a.createdAt ?? 0;
    const bt = b.createdAt?.toMillis?.() ?? b.createdAt ?? 0;
    return bt - at;
  });
}

// Fetch all posts across all communities (for global feed)
export async function listAllPosts(pageSize = 100) {
  const rows = await getCollection("posts", { pageSize });
  return rows.sort((a, b) => {
    const at = a.createdAt?.toMillis?.() ?? a.createdAt ?? 0;
    const bt = b.createdAt?.toMillis?.() ?? b.createdAt ?? 0;
    return bt - at;
  });
}

// ---------- Notifications ----------
export async function createNotification(payload) {
  return createOne("notifications", payload);
}

export async function getNotificationById(id) {
  return getOne("notifications", id);
}

// Fetch without orderBy to avoid Firestore silently skipping docs
// whose serverTimestamp() hasn't resolved yet; sort client-side instead.
export async function listNotifications(userId) {
  if (isFirebaseConfigured) {
    const q = query(
      collection(db, "notifications"),
      where("recipientId", "==", userId)
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => {
      const at = a.createdAt?.toMillis?.() ?? a.createdAt ?? 0;
      const bt = b.createdAt?.toMillis?.() ?? b.createdAt ?? 0;
      return bt - at;
    });
    return rows;
  }
  const data = readLS();
  const rows = (data.notifications || []).filter((n) => n.recipientId === userId);
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return rows;
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

// ---------- Join requests ----------
export async function createJoinRequest(payload) {
  return createOne("requests", { type: "join", status: "pending", ...payload });
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
// One pending request per user per book at a time.

export async function createPickupRequest(payload) {
  return createOne("requests", { type: "pickup", status: "pending", ...payload });
}

/** Return the pending pickup request for a given user + book, or null. */
export async function getPickupRequest(bookId, requesterId) {
  // Query by requesterId + type; filter bookId in JS to minimise index requirements.
  const rows = await getCollection("requests", {
    where: [["requesterId", "==", requesterId], ["type", "==", "pickup"], ["status", "==", "pending"]],
  });
  return rows.find((r) => r.bookId === bookId) || null;
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

// ---------- Borrowings ----------
export async function createBorrowing(payload) {
  return createOne("borrowings", { status: "active", ...payload });
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

// Get the most recent completed borrowing for a book (to show the last holder)
export async function getLastCompletedBorrowingByBook(bookId) {
  const rows = await getCollection("borrowings", {
    where: [["bookId", "==", bookId], ["status", "==", "completed"]],
  });
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    const at = a.createdAt?.toMillis?.() ?? a.createdAt ?? 0;
    const bt = b.createdAt?.toMillis?.() ?? b.createdAt ?? 0;
    return bt - at;
  });
  return rows[0];
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

/** The rating this user left for this book, or null. */
export async function getUserRatingForBook(bookId, userId) {
  if (!bookId || !userId) return null;
  const direct = await getOne("ratings", ratingDocId(bookId, userId));
  if (direct) return direct;
  // Ratings written before the deterministic-id scheme live under random ids.
  const rows = await getCollection("ratings", {
    where: [["bookId", "==", bookId], ["userId", "==", userId]],
  });
  return rows[0] || null;
}

/** Recompute a book's aggregate from its rating documents and persist it. */
export async function recalcBookRating(bookId) {
  const summary = aggregateFromRatings(await listRatingsForBook(bookId));
  await updateOne("books", bookId, {
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
  if (!bookId) throw new Error("submitRating: missing bookId");
  if (!userId) throw new Error("submitRating: missing userId");
  const stars = clampStars(value);
  if (!stars) throw new Error("submitRating: value must be between 1 and 5");

  const id = ratingDocId(bookId, userId);
  const existing = await getCollection("ratings", {
    where: [["bookId", "==", bookId], ["userId", "==", userId]],
  });
  const previous = existing.find((r) => r.id === id) || null;

  const rating = await setOne("ratings", id, {
    bookId,
    userId,
    value: stars,
    stars,                       // legacy readers still look at `stars`
    review: String(review || "").trim(),
    authorName,
    photoURL,
    ...(previous ? {} : { createdAt: Date.now() }),
  });

  // Collapse pre-deterministic duplicates so this user is counted exactly once.
  await Promise.all(
    existing.filter((r) => r.id !== id).map((r) => deleteOne("ratings", r.id))
  );

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
 * Batch fetch books by IDs with concurrency control
 */
export async function getBooksByIds(bookIds, concurrency = 5) {
  if (!bookIds || bookIds.length === 0) return [];
  
  const results = [];
  for (let i = 0; i < bookIds.length; i += concurrency) {
    const batch = bookIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((id) => getBook(id))
    );
    results.push(...batchResults.filter(Boolean));
  }
  
  return results;
}

// Reviews are not a separate collection: a review is the optional text a
// reader attaches to their rating, so it lives on the rating document and is
// derived from listRatingsForBook via reviewsFromRatings (utils/rating.js).