// The shape of every document this app stores, in one place.
//
// firestore.js is the only module that writes anything, and this is the only
// module that says what "written" looks like. Each collection below declares
// three things: the fields a caller has to supply, the fields the data layer
// fills in by itself, and a normalizer that turns a raw payload into the exact
// document that lands in the database. Every write path in firestore.js runs
// its payload through the matching normalizer and throws when a required field
// is missing, so a caller cannot invent a shape — which is the whole point.
// Before this file the contract lived in the Add-Book form, and every schema
// drift the project has had came from some other caller writing a document
// directly.
//
// Field-level rules — what a name may contain, how long a review may be — stay
// in utils/validators.js. This module is about documents, not fields, and calls
// into that one rather than restating it.
//
// The normalizers are pure and free of the Firebase SDK: they describe the
// stored shape, not how it gets there, so the localStorage fallback and the
// real Firestore branch are held to the same contract by construction.

import { logger } from "../utils/logger.js";
import { clampStars } from "../utils/rating.js";
import {
  MIN_SESSION_SECONDS,
  addReadingSeconds, clampSessionSeconds, dayKey, totalReadingSeconds,
} from "../utils/readingProgress.js";
import { searchPrefixes } from "../utils/search.js";
import { toMillis } from "../utils/time.js";
import {
  LIMITS,
  clampLoanDays,
  clampText,
  isLoanDays,
  isYear,
  safeImageUrl,
  validateBookPayload,
} from "../utils/validators.js";

/**
 * A payload that does not describe a storable document. `errorKey` is set when
 * the failure has an i18n message worth putting in front of a user; the rest is
 * for the log.
 */
export class SchemaError extends Error {
  constructor(message, { collection = null, field = null, errorKey = null } = {}) {
    super(message);
    this.name = "SchemaError";
    this.collection = collection;
    this.field = field;
    this.errorKey = errorKey;
  }
}

/**
 * Fields the data layer owns outright. A caller may never pass one: createOne
 * strips them and stamps its own, so the value stored and the value the caller
 * imagined can never disagree.
 */
export const SERVER_OWNED_FIELDS = Object.freeze(["createdAt"]);

// ---------- shared field coercion ----------

function requirePayload(collection, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SchemaError(`${collection}: payload must be an object`, { collection });
  }
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A non-empty string, or a SchemaError naming the field that was missing. */
function requiredId(collection, field, value) {
  const id = str(value);
  if (!id) throw new SchemaError(`${collection}: missing ${field}`, { collection, field });
  return id;
}

function requiredText(collection, field, value, max, errorKey = null) {
  const text = clampText(value, max);
  if (!text) throw new SchemaError(`${collection}: missing ${field}`, { collection, field, errorKey });
  return text;
}

/** Throw unless every required field of a finished document is present. */
function assertRequired(collection, document, required) {
  for (const field of required) {
    const value = document[field];
    if (value === undefined || value === null || value === "") {
      throw new SchemaError(`${collection}: missing required field "${field}"`, { collection, field });
    }
  }
  return document;
}

/** Strip the fields the data layer owns, complaining if a caller supplied one. */
export function stripServerOwned(collection, payload) {
  if (!payload || typeof payload !== "object") return payload;
  let stripped = payload;
  for (const field of SERVER_OWNED_FIELDS) {
    if (field in stripped) {
      if (stripped === payload) stripped = { ...payload };
      logger.warn(`schema.${collection}`, `${field} is owned by the data layer; dropped from the payload`, {
        attempted: payload[field],
      });
      delete stripped[field];
    }
  }
  return stripped;
}

// ---------- users ----------
//
// A profile as it exists the moment it is created, which is not the same as a
// profile in its steady state: the security rules insist a new user is a plain
// `user` belonging to no community, because joining and being promoted are
// separate, separately-authorised writes. `normalizeUserMembership` is that
// second write, and it is here rather than in a caller so the seed script and
// the Create-Community screen describe membership the same way.

export const USER_ROLES = Object.freeze(["user", "admin"]);

export const userSchema = Object.freeze({
  collection: "users",
  required: Object.freeze(["id", "email", "nickname", "role"]),
  defaults: Object.freeze({
    firstName: "", lastName: "", phone: "", address: "",
    photoURL: "", notificationsEnabled: true, savedBookIds: [],
  }),
  immutable: Object.freeze(["email", "createdAt"]),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewUser(payload) {
  requirePayload("users", payload);
  const id = requiredId("users", "id", payload.id);
  const email = requiredText("users", "email", payload.email, LIMITS.NAME_MAX).toLowerCase();
  const nickname = requiredId("users", "nickname", payload.nickname).toLowerCase();

  const document = {
    ...userSchema.defaults,
    id,
    email,
    nickname,
    firstName: clampText(payload.firstName, LIMITS.NAME_MAX),
    lastName: clampText(payload.lastName, LIMITS.NAME_MAX),
    phone: clampText(payload.phone, 20),
    // Shown to whoever comes to collect a book, so it travels with the profile.
    address: clampText(payload.address, LIMITS.ADDRESS_MAX),
    photoURL: safeImageUrl(payload.photoURL),
    notificationsEnabled: payload.notificationsEnabled !== false,
    savedBookIds: Array.isArray(payload.savedBookIds) ? payload.savedBookIds.map(str).filter(Boolean) : [],
    // Nobody registers as an admin and nobody registers into a community; the
    // rules assert both, so deriving them here means a caller cannot try.
    role: "user",
    communityId: null,
  };

  // Mock mode keeps the password on the profile so nickname login can work
  // without Firebase Auth. The rules reject this field outright, which is the
  // guard that keeps it out of a real database — it is carried, never invented.
  if (payload.password != null) document.password = payload.password;

  return assertRequired("users", document, userSchema.required);
}

/**
 * The one patch that moves a person between communities.
 *
 * `role` is written only when the caller names one, because the rules check a
 * membership write by exactly which keys it touches — an ejection may move
 * `communityId` and nothing else — and a patch that restates an unchanged role
 * would be a different write than the one those rules describe. Naming a role
 * requires a community to hold it in: an admin is an admin *of* somewhere.
 */
export function normalizeUserMembership({ communityId, role, joinRequestId } = {}) {
  const cid = communityId == null || communityId === "" ? null : str(communityId);
  const patch = { communityId: cid };

  if (role !== undefined) {
    if (!USER_ROLES.includes(role)) {
      throw new SchemaError(`users: unknown role "${role}"`, { collection: "users", field: "role" });
    }
    if (role === "admin" && !cid) {
      throw new SchemaError("users: an admin must belong to a community", {
        collection: "users", field: "communityId",
      });
    }
    patch.role = role;
  }

  // The rules can only verify an admin-approved join if the write names the
  // request that approved it.
  if (joinRequestId) patch.joinRequestId = str(joinRequestId);
  return patch;
}

// ---------- communities ----------
//
// `memberIds` is written once, at creation, and never maintained afterwards —
// membership lives on the user document as `communityId`, and the security
// rules deliberately do not consult this array. It exists because the create
// rule pins it to exactly the founder.

export const communitySchema = Object.freeze({
  collection: "communities",
  required: Object.freeze(["name", "nickname", "ownerId", "memberIds"]),
  defaults: Object.freeze({ isPrivate: false, notificationsEnabled: true, photoURL: "" }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewCommunity(payload) {
  requirePayload("communities", payload);
  const ownerId = requiredId("communities", "ownerId", payload.ownerId);

  return assertRequired("communities", {
    ...communitySchema.defaults,
    name: requiredText("communities", "name", payload.name, LIMITS.NAME_MAX),
    nickname: requiredId("communities", "nickname", payload.nickname).toLowerCase(),
    ownerId,
    // A community begins with exactly its founder in it — the create rule
    // checks for this array literally, so it is derived, not accepted.
    memberIds: [ownerId],
    isPrivate: Boolean(payload.isPrivate),
    notificationsEnabled: payload.notificationsEnabled !== false,
    photoURL: safeImageUrl(payload.photoURL),
  }, communitySchema.required);
}

/**
 * The fields an owner may edit after the fact, and how each is coerced.
 *
 * `ownerId`, `memberIds` and `createdAt` are absent on purpose: the security
 * rules freeze the first and the third, and the array is written once at
 * creation and never maintained (see the note above), so an edit screen that
 * "helpfully" resent it would be writing a value nothing reads.
 */
const COMMUNITY_PATCH_FIELDS = Object.freeze({
  name:     (v) => requiredText("communities", "name", v, LIMITS.NAME_MAX),
  nickname: (v) => requiredId("communities", "nickname", v).toLowerCase(),
  isPrivate: (v) => Boolean(v),
  notificationsEnabled: (v) => v !== false,
  photoURL: (v) => safeImageUrl(v),
});

const COMMUNITY_IMMUTABLE = Object.freeze(["ownerId", "memberIds"]);

/**
 * A community patch, field by field — same contract as `normalizeBookPatch`:
 * nothing is defaulted, everything present is coerced, and an immutable or
 * server-owned field is dropped with a warning rather than sent to be refused
 * by the rules.
 */
export function normalizeCommunityPatch(patch) {
  requirePayload("communities", patch);

  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (COMMUNITY_IMMUTABLE.includes(field) || SERVER_OWNED_FIELDS.includes(field)) {
      logger.warn("schema.communities", `${field} is immutable; dropped from patch`, { attempted: value });
      continue;
    }
    const coerce = COMMUNITY_PATCH_FIELDS[field];
    if (!coerce) {
      throw new SchemaError(`communities: unknown field "${field}"`, { collection: "communities", field });
    }
    out[field] = coerce(value);
  }

  if (!Object.keys(out).length) {
    throw new SchemaError("communities: patch is empty", { collection: "communities" });
  }
  return out;
}

// ---------- books ----------
//
// The one collection with a real invariant behind it: `ownerId` is who the book
// belongs to and never moves, `holderId` is who has the copy today and moves at
// every handoff. A new book starts with both pointing at the same person, which
// is why `holderId` is derived here rather than accepted from the caller.
//
// `status`, `genre`, `holderId` and `createdAt` are all required by the security
// rules on create, so a book missing any of them is not merely untidy — it is a
// write the server would reject.

export const BOOK_STATUSES = Object.freeze(["available", "unavailable"]);

export const bookSchema = Object.freeze({
  collection: "books",
  /** Present on every stored book. `createdAt` is added by createOne. */
  required: Object.freeze([
    "name", "author", "communityId", "ownerId", "holderId", "status", "genre",
  ]),
  /**
   * Written on every new book without the caller mentioning them. The
   * descriptive fields are absent from this list on purpose: validateBookPayload
   * already returns a value for each one, empty string included.
   */
  defaults: Object.freeze({
    borrowerId: null,
    rating: 0,
    ratingSum: 0,
    ratingCount: 0,
  }),
  /** Frozen by the security rules once the document exists. */
  immutable: Object.freeze(["communityId", "createdAt"]),
  /**
   * Maintained by the data layer from other fields, never accepted from a
   * caller — `normalizeBookPatch` rejects it like any other unknown field, and
   * `updateBook` recomputes it after the patch is validated.
   */
  derived: Object.freeze(["searchPrefixes"]),
  serverOwned: SERVER_OWNED_FIELDS,
});

/**
 * The denormalised search index for one book, derived from its title and
 * author. See utils/search.js for what it can and cannot match.
 *
 * This is a separate export rather than part of the two normalizers because it
 * has to run in three places — a new book, an edit that touches either field,
 * and the backfill script — and deriving it twice from two definitions is how
 * search would quietly start disagreeing with the shelf.
 */
export function bookSearchFields({ name, author } = {}) {
  return { searchPrefixes: searchPrefixes(name, author) };
}

function bookGenres(value, { collection = "books" } = {}) {
  const genres = Array.isArray(value) ? value.map(str).filter(Boolean) : [];
  if (!genres.length) {
    throw new SchemaError(`${collection}: at least one genre is required`, {
      collection, field: "genres", errorKey: "addBookErrGenre",
    });
  }
  return genres.slice(0, 3);
}

function bookYear(value) {
  if (value === "" || value == null) return "";
  if (!isYear(value)) {
    throw new SchemaError("books: year is out of range", {
      collection: "books", field: "year", errorKey: "addBookErrYear",
    });
  }
  return Number(value);
}

function bookMaxDays(value) {
  if (!isLoanDays(value)) {
    throw new SchemaError("books: maxDays is out of range", {
      collection: "books", field: "maxDays", errorKey: "addBookErrMaxDays",
    });
  }
  return clampLoanDays(value);
}

function bookStatus(value) {
  const status = str(value);
  if (!BOOK_STATUSES.includes(status)) {
    throw new SchemaError(`books: unknown status "${value}"`, { collection: "books", field: "status" });
  }
  return status;
}

function bookCount(field, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new SchemaError(`books: ${field} must be a non-negative number`, { collection: "books", field });
  }
  return field === "ratingCount" ? Math.trunc(n) : n;
}

function nullableId(field, value) {
  if (value == null || value === "") return null;
  const id = str(value);
  if (!id) throw new SchemaError(`books: ${field} must be a user id or null`, { collection: "books", field });
  return id;
}

/**
 * Every field a book patch may carry, and how each one is coerced. An allowlist
 * rather than a passthrough: a field that is not here is a field nothing has
 * agreed on, and letting it through is exactly how the drift started. Adding a
 * field to the book document means adding it here first.
 */
const BOOK_PATCH_FIELDS = Object.freeze({
  name: (v) => requiredText("books", "name", v, LIMITS.NAME_MAX, "addBookErrName"),
  author: (v) => requiredText("books", "author", v, LIMITS.AUTHOR_MAX, "addBookErrName"),
  description: (v) => clampText(v, LIMITS.DESCRIPTION_MAX),
  coverUrl: (v) => safeImageUrl(v),
  year: bookYear,
  maxDays: bookMaxDays,
  genres: (v) => bookGenres(v),
  genre: (v) => requiredId("books", "genre", v),
  status: bookStatus,
  holderId: (v) => requiredId("books", "holderId", v),
  borrowerId: (v) => nullableId("borrowerId", v),
  rating: (v) => bookCount("rating", v),
  ratingSum: (v) => bookCount("ratingSum", v),
  ratingCount: (v) => bookCount("ratingCount", v),
});

/**
 * The document for a brand-new book, built from an Add-Book payload.
 *
 * Throws a SchemaError — carrying the same i18n key the form uses — rather than
 * quietly filling a blank, because a book with no genre or no status is a book
 * the rest of the app cannot reason about.
 */
export function normalizeNewBook(payload) {
  requirePayload("books", payload);

  const validated = validateBookPayload(payload);
  if (!validated.ok) {
    throw new SchemaError(`books: ${validated.errorKey}`, {
      collection: "books", errorKey: validated.errorKey,
    });
  }
  const safe = validated.value;
  const ownerId = requiredId("books", "ownerId", payload.ownerId);
  const communityId = requiredId("books", "communityId", payload.communityId);

  // A book that has never been handed over is with its owner, and a book that
  // has never been lent is available. Both are facts about a *new* book, not
  // preferences, so they are derived here instead of trusted from the caller —
  // the security rules assert the same two things on create.
  if (payload.holderId && str(payload.holderId) !== ownerId) {
    logger.warn("schema.books", "a new book starts with its owner; holderId overridden", {
      ownerId, attempted: payload.holderId,
    });
  }
  if (payload.status && str(payload.status) !== "available") {
    logger.warn("schema.books", "a new book is available; status overridden", {
      attempted: payload.status,
    });
  }

  const document = {
    ...bookSchema.defaults,
    name: safe.name,
    author: safe.author,
    description: safe.description,
    coverUrl: safe.coverUrl,
    year: safe.year,
    maxDays: safe.maxDays,
    genres: safe.genres,
    // `genre` is the single-valued field the queries and the rules use; it is
    // the first of `genres` by definition, never something the caller picks
    // separately, or the two drift apart.
    genre: safe.genres[0],
    communityId,
    ownerId,
    holderId: ownerId,
    status: "available",
    // Search is an indexed `array-contains` against this, so a book without it
    // is a book nobody can find by name. Derived here, at the only point a
    // book is born, so that can never be a state a document is in.
    ...bookSearchFields(safe),
  };

  // Fresh books carry zeroed rating counters from birth: getRatingSummaries
  // treats a missing `ratingCount` as a pre-counter document and pays a fan-out
  // over the ratings collection to repair it.
  return assertRequired("books", document, bookSchema.required);
}

/**
 * The one field `normalizeBookPatch` refuses, validated on its own.
 *
 * Owner reassignment is a deliberate, separate act — an admin correcting who a
 * book belongs to — so it gets a separate entry point rather than a hole in the
 * patch allowlist. This exists so that route is still schema-checked instead of
 * being the last place a caller can write a book field unsupervised.
 */
export function normalizeBookOwner(ownerId) {
  return { ownerId: requiredId("books", "ownerId", ownerId) };
}

/**
 * A book patch, field by field. Nothing is defaulted — a patch says what
 * changes, and filling in the rest would overwrite live values with form
 * leftovers — but every field present is coerced and range-checked, and an
 * immutable or server-owned field is dropped with a warning rather than sent to
 * be refused by the security rules.
 */
export function normalizeBookPatch(patch) {
  requirePayload("books", patch);

  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (bookSchema.immutable.includes(field)) {
      logger.warn("schema.books", `${field} is immutable; dropped from patch`, { attempted: value });
      continue;
    }
    const coerce = BOOK_PATCH_FIELDS[field];
    if (!coerce) {
      throw new SchemaError(`books: unknown field "${field}"`, { collection: "books", field });
    }
    out[field] = coerce(value);
  }

  if ("genres" in out) out.genre = out.genres[0];
  if (!Object.keys(out).length) {
    throw new SchemaError("books: patch is empty", { collection: "books" });
  }
  return out;
}

// ---------- posts ----------
//
// A noticeboard entry. Only the two fields an author can see on screen are
// editable; who wrote it, which community it belongs to and when it was posted
// are what make it that post rather than a different one, and the security
// rules freeze all four.

const POST_PATCH_FIELDS = Object.freeze({
  // The text is the post, so it is the field that may not be emptied. `title`
  // is here only for the posts written when it was the required one; nothing
  // creates it any more, and an edit may clear it.
  body: (v) => requiredText("posts", "body", v, LIMITS.DESCRIPTION_MAX, "fillAllFields"),
  title: (v) => clampText(v, LIMITS.NAME_MAX),
});

const POST_IMMUTABLE = Object.freeze(["communityId", "authorId", "authorName"]);

export function normalizePostPatch(patch) {
  requirePayload("posts", patch);

  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (POST_IMMUTABLE.includes(field) || SERVER_OWNED_FIELDS.includes(field)) {
      logger.warn("schema.posts", `${field} is immutable; dropped from patch`, { attempted: value });
      continue;
    }
    const coerce = POST_PATCH_FIELDS[field];
    if (!coerce) {
      throw new SchemaError(`posts: unknown field "${field}"`, { collection: "posts", field });
    }
    out[field] = coerce(value);
  }

  if (!Object.keys(out).length) {
    throw new SchemaError("posts: patch is empty", { collection: "posts" });
  }
  return out;
}

// ---------- notifications ----------
//
// An envelope: `recipientId`, `title`, `type` and `read` are the same on every
// notification, and each `type` hangs its own payload off the side (a bookId, a
// pickupCode, the requestId that authorises a membership write). The envelope is
// pinned down here; the per-type extras ride along untouched, because the screen
// that reads them is the only thing that knows what they mean.

export const notificationSchema = Object.freeze({
  collection: "notifications",
  required: Object.freeze(["recipientId", "title", "type", "read"]),
  defaults: Object.freeze({ body: "", read: false }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewNotification(payload) {
  requirePayload("notifications", payload);
  const {
    recipientId, title, type, body, read, createdAt, ...extras
  } = payload;

  if (createdAt !== undefined) {
    logger.warn("schema.notifications", "createdAt is owned by the data layer; dropped", { attempted: createdAt });
  }
  if (read === true) {
    // The rules reject a notification created already-read, and so would common
    // sense: nobody has seen it yet.
    logger.warn("schema.notifications", "a new notification is unread; read overridden");
  }

  return assertRequired("notifications", {
    ...extras,
    recipientId: requiredId("notifications", "recipientId", recipientId),
    title: requiredText("notifications", "title", title, LIMITS.NAME_MAX),
    type: requiredId("notifications", "type", type),
    body: clampText(body, LIMITS.DESCRIPTION_MAX),
    read: false,
  }, notificationSchema.required);
}

// ---------- borrowings ----------
//
// One loan of one book to one reader. `ownerId` is copied off the book at
// creation so the loan can name who to notify without a second read — it
// records who the book belongs to, which is not necessarily who handed it over.
//
// Every loan carries a `pickupCode` from birth. It is the four digits the
// current reader reads out to whoever comes to collect the book next, so a loan
// without one is a book that cannot be handed on — and it is minted here rather
// than at the handoff screen because "the reader always has a code to give" is a
// fact about the document, not about the screen that happens to ask for it.

/** The four digits exchanged at a handoff. A handshake, not a secret. */
export function newPickupCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export const borrowingSchema = Object.freeze({
  collection: "borrowings",
  required: Object.freeze(["bookId", "borrowerId", "status", "pickupCode"]),
  defaults: Object.freeze({ ownerId: null, returnDate: null }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewBorrowing(payload) {
  requirePayload("borrowings", payload);
  const { bookId, borrowerId, ownerId, status, pickupCode, createdAt, ...extras } = payload;

  if (createdAt !== undefined) {
    logger.warn("schema.borrowings", "createdAt is owned by the data layer; dropped", { attempted: createdAt });
  }
  if (status && str(status) !== "active") {
    logger.warn("schema.borrowings", "a new loan is active; status overridden", { attempted: status });
  }

  return assertRequired("borrowings", {
    ...borrowingSchema.defaults,
    ...extras,
    bookId: requiredId("borrowings", "bookId", bookId),
    borrowerId: requiredId("borrowings", "borrowerId", borrowerId),
    ownerId: ownerId ? str(ownerId) : null,
    pickupCode: str(pickupCode) || newPickupCode(),
    // A loan is created at the moment the reader takes the book; there is no
    // other state it can start in, and the rules only accept this one.
    status: "active",
  }, borrowingSchema.required);
}

// ---------- ratings ----------
//
// One document per (book, user) at a deterministic id, so a second rating is an
// overwrite rather than a second vote. The score lives in `value` and nowhere
// else — the security rules range-check that field by name.

export const ratingSchema = Object.freeze({
  collection: "ratings",
  required: Object.freeze(["bookId", "userId", "value"]),
  defaults: Object.freeze({ review: "", authorName: "", photoURL: "" }),
});

export function normalizeRating(payload) {
  requirePayload("ratings", payload);
  const bookId = requiredId("ratings", "bookId", payload.bookId);
  const userId = requiredId("ratings", "userId", payload.userId);
  const value = clampStars(payload.value);
  if (!value) {
    throw new SchemaError("ratings: value must be between 1 and 5", { collection: "ratings", field: "value" });
  }

  return assertRequired("ratings", {
    bookId,
    userId,
    value,
    // The rules cap a review at 2000 characters, so a longer one is not a big
    // review — it is a rejected write.
    review: clampText(payload.review, LIMITS.REVIEW_MAX),
    authorName: clampText(payload.authorName, LIMITS.NAME_MAX),
    photoURL: safeImageUrl(payload.photoURL),
  }, ratingSchema.required);
}

// ---------- reading sessions ----------
//
// One finished run of the reading timer. Immutable once written: the rules deny
// update and delete outright, because this collection is the durable log the
// denormalised `readingDays` map on the user document is folded from, and a log
// you can rewrite is not one.
//
// `dayKey` is derived here rather than on the server, and it is the reader's own
// calendar day — see utils/readingProgress.js for why that matters. It is stored
// alongside the timestamps rather than computed from them on read so the row and
// the map can never disagree about which square a sitting belongs in.

export const readingSessionSchema = Object.freeze({
  collection: "readingSessions",
  required: Object.freeze(["userId", "dayKey", "seconds", "startedAt", "endedAt"]),
  defaults: Object.freeze({ communityId: null, bookId: null }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewReadingSession(payload) {
  requirePayload("readingSessions", payload);
  const userId = requiredId("readingSessions", "userId", payload.userId);

  const seconds = clampSessionSeconds(payload.seconds);
  if (!seconds) {
    throw new SchemaError(
      `readingSessions: seconds must be a whole number of at least ${MIN_SESSION_SECONDS}`,
      { collection: "readingSessions", field: "seconds" }
    );
  }

  const endedAt = toMillis(payload.endedAt, Date.now());
  // A run that reports no start is stamped from its own length, so the pair is
  // always consistent — a session whose `startedAt` sits after its `endedAt`
  // would quietly break any later recount from this log.
  const startedAt = toMillis(payload.startedAt, endedAt - seconds * 1000);

  return assertRequired("readingSessions", {
    ...readingSessionSchema.defaults,
    userId,
    // Carried so a leaderboard can be rebuilt for one community without reading
    // every member's profile. Null for a reader who belongs to none.
    communityId: payload.communityId ? str(payload.communityId) : null,
    // Which book the sitting was spent on, when the reader had one on loan. The
    // profile does not use it yet; the log would be unable to answer "how long
    // did this book take" without it, and that cannot be backfilled later.
    bookId: payload.bookId ? str(payload.bookId) : null,
    seconds,
    startedAt: Math.min(startedAt, endedAt),
    endedAt,
    dayKey: dayKey(new Date(endedAt)),
  }, readingSessionSchema.required);
}

/**
 * The other half of a logged session: the patch that folds it into the reader's
 * own profile. Kept here, next to the row it mirrors, so the two shapes are
 * written in one place — and pure, so the localStorage fallback and Firestore
 * produce the same numbers.
 */
export function normalizeReadingProgress({ readingDays, dayKey: key, seconds, endedAt } = {}) {
  const days = addReadingSeconds(readingDays, key, seconds);
  return {
    readingDays: days,
    readingSeconds: totalReadingSeconds(days),
    lastReadAt: toMillis(endedAt, Date.now()),
  };
}
