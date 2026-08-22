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
import { isPageBand, clampPages, loanDaysForPages } from "../utils/bookPages.js";
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
    // When somebody proved they can be reached on this number, or null for a
    // profile that has never had one. Not a flag the client sets to be believed:
    // the rules refuse `phone` and `phoneVerifiedAt` from every client, and the
    // only writer is the verification webhook, running with the Admin SDK after
    // our bot has seen a message arrive from that very number. Nobody registers
    // with a phone — see firebase/phoneVerify.js and server/server.js.
    phoneVerifiedAt: null,
    photoURL: "", notificationsEnabled: true, savedBookIds: [],
    // Denormalised totals for the follow graph — see the follows section below.
    // A profile born with both at zero is what lets every screen read a number
    // rather than testing for one; accounts created before follows existed have
    // neither field, which is why every reader of them defaults to 0.
    followersCount: 0, followingCount: 0,
  }),
  immutable: Object.freeze(["email", "createdAt"]),
  serverOwned: SERVER_OWNED_FIELDS,
});

/**
 * What makes a person findable, denormalised onto their profile.
 *
 * The same arrangement books have, and for the same reason: `array-contains`
 * is one indexed equality lookup, where a search across three separate name
 * fields would be three queries whose results have to be merged, deduplicated
 * and re-sorted in the browser.
 *
 * Names go in alongside the handle deliberately. Search used to be a prefix
 * scan on `nickname` alone, so somebody could be looked at on screen —
 * "Madi Berikkazy" — and still not be findable by that name, which is not a
 * limitation a person searching for their friend would ever guess at. The
 * prefixes are lowercased by `searchPrefixes`, so this is also what makes the
 * match case-insensitive: a range scan over a stored "Madi" never matches a
 * typed "madi".
 *
 * `email` is deliberately absent. It is not shown anywhere in the app, and
 * indexing it would make every account findable by an address its owner never
 * published.
 */
export function userSearchFields({ firstName, lastName, nickname } = {}) {
  return { searchPrefixes: searchPrefixes(firstName, lastName, nickname) };
}

/** The fields a profile edit can change that `searchPrefixes` is built from. */
export const USER_SEARCH_SOURCES = Object.freeze(["firstName", "lastName", "nickname"]);

export function normalizeNewUser(payload) {
  requirePayload("users", payload);
  const id = requiredId("users", "id", payload.id);
  const email = requiredText("users", "email", payload.email, LIMITS.NAME_MAX).toLowerCase();
  const nickname = requiredId("users", "nickname", payload.nickname).toLowerCase();
  const firstName = clampText(payload.firstName, LIMITS.NAME_MAX);
  const lastName = clampText(payload.lastName, LIMITS.NAME_MAX);

  const document = {
    ...userSchema.defaults,
    id,
    email,
    nickname,
    firstName,
    lastName,
    // Built from the clamped values above, never the raw payload: what is
    // searchable has to be what is stored.
    ...userSearchFields({ firstName, lastName, nickname }),
    // Carried, never invented: registration does not ask for a number, and a
    // profile is only ever born without one. A caller that passes one anyway
    // gets it stored unverified, which is what `phoneVerifiedAt: null` says.
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

/**
 * The stored loan period. Derived from `pages` on every write this app makes,
 * so this is a backstop rather than a field anyone fills in — and it points the
 * admin at the page band, which is the only thing they can actually change.
 */
function bookMaxDays(value) {
  if (!isLoanDays(value)) {
    throw new SchemaError("books: maxDays is out of range", {
      collection: "books", field: "maxDays", errorKey: "addBookErrPages",
    });
  }
  return clampLoanDays(value);
}

/**
 * How long the book is, as one of the bands the picker offers.
 *
 * Refused rather than rounded when it is not a band: a page count that came
 * from somewhere other than the picker has no business setting a loan period,
 * and `clampPages` exists for reading old data back, not for accepting new.
 */
function bookPages(value) {
  if (!isPageBand(value)) {
    throw new SchemaError("books: pages is not one of the bands", {
      collection: "books", field: "pages", errorKey: "addBookErrPages",
    });
  }
  return clampPages(value);
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
  pages: bookPages,
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
    pages: safe.pages,
    // Derived from `pages` by validateBookPayload, and stored beside it: the
    // band is the fact about the book, the days are what the loan screens read.
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
    // Provenance, and the only reason the security rules let a brand-new member
    // create a book at all: this names the approved application the book came
    // in with. Absent on every book an admin adds themselves.
    ...(payload.joinRequestId
      ? { joinRequestId: requiredId("books", "joinRequestId", payload.joinRequestId) }
      : {}),
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
  // The loan period is not editable on its own — it is what the page band says
  // it is. An edit that moves the band moves the allowance in the same write,
  // so the two can never end up describing different books.
  if ("pages" in out) out.maxDays = loanDaysForPages(out.pages);
  if (!Object.keys(out).length) {
    throw new SchemaError("books: patch is empty", { collection: "books" });
  }
  return out;
}

// ---------- join requests ----------
//
// Joining costs a book. That was always the rule, but the form only asked for a
// title and an author, so the admin approving a request was agreeing to
// something they could not see and then had to type in again themselves. The
// applicant now fills in the whole book — the same fields, run through the same
// validator as Add Book — and approval is what puts it on the shelf.
//
// It is nested under `book` rather than spread across `bookName`, `bookAuthor`,
// `bookGenres`… because it is a book: it is handed to `createBook` whole at
// approval, and a flat set of seven prefixed fields is one rename away from
// disagreeing with the document it becomes.

/**
 * The book attached to a request, whatever era the request comes from.
 *
 * Requests written before this change carry a title and an author at the top
 * level and nothing else. They are still pending in somebody's inbox, so they
 * still have to render and still have to be approvable — the admin just has
 * more blanks to fill in on the review form.
 */
export function requestBook(request) {
  if (request?.book && typeof request.book === "object") return { ...request.book };
  return {
    name: str(request?.bookName),
    author: str(request?.bookAuthor),
    description: str(request?.bookDescription),
    coverUrl: safeImageUrl(request?.bookCoverUrl),
    genres: [],
    pages: "",
    year: "",
  };
}

/**
 * A join request, with the book its applicant is bringing.
 *
 * `validateBookPayload` is the same gate Add Book runs through, so a request
 * that survives this is a request the admin can approve without editing a
 * thing. `ownerId` is not asked for and not stored: the book belongs to
 * whoever is applying, and that is `userId`.
 */
export function normalizeJoinRequest(payload) {
  requirePayload("requests", payload);

  const validated = validateBookPayload(payload?.book);
  if (!validated.ok) {
    throw new SchemaError(`requests: ${validated.errorKey}`, {
      collection: "requests", errorKey: validated.errorKey,
    });
  }
  const { ownerId, ...book } = validated.value;

  return {
    type: "join",
    status: "pending",
    userId: requiredId("requests", "userId", payload.userId),
    communityId: requiredId("requests", "communityId", payload.communityId),
    userNickname: str(payload.userNickname),
    userName: str(payload.userName),
    book,
  };
}

// ---------- return requests ----------
//
// The mirror image of a pickup: a pickup is a reader asking for somebody else's
// book, a return is an *owner* asking for their own book back — the errand a
// member has to run for every copy of theirs that is out before they can leave
// the community (see utils/communityExit.js).
//
// It lives in the same collection with `type: "return"` and, like a pickup, is
// keyed by (bookId, requesterId): one open request per book per owner, and the
// data layer's `openReturnRequest` is what enforces that.
//
// Two fields are worth explaining:
//
//   `holderId`     — who the copy has to come back from, stamped at the moment
//                    the request opens. It is not re-derived later: if the book
//                    moves on to somebody else in the meantime, that is a
//                    different handoff and this request is stale, which is
//                    exactly what the screen needs to be able to notice.
//   `reservedBook` — whether opening this request is what took the book off the
//                    shelf. Only then may cancelling put it back: a book that
//                    was already out on loan when the owner asked for it must
//                    not be marked "available" by a cancellation.
//
// `communityId` is carried so the `requests` list rule has something a member's
// query can be scoped by — it is how the pickup screen asks "is this book being
// returned to its owner?" without being able to read every request in the
// database.

/**
 * Which end of the handover opened it.
 *
 * The two are the same document on purpose — `requesterId` is whoever collects
 * either way, so every screen and every query downstream reads one shape. This
 * is the one place they have to differ, and it is about who may call the thing
 * off: an owner asking for their property back is not something the person
 * holding it gets to cancel, while an offer to hand a book over is exactly the
 * offer its maker may withdraw. The security rules turn on this field.
 *
 * Absent means "owner" — every request written before the holder could open one
 * was the owner's, and the rules read it with that default.
 */
export const RETURN_OPENED_BY = Object.freeze(["owner", "holder"]);

export const returnRequestSchema = Object.freeze({
  collection: "requests",
  required: Object.freeze([
    "type", "status", "bookId", "requesterId", "holderId", "communityId",
    "returnCode", "openedBy",
  ]),
  defaults: Object.freeze({
    bookName: "", requesterName: "", reservedBook: false, openedBy: "owner",
  }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeReturnRequest(payload) {
  requirePayload("requests", payload);

  const requesterId = requiredId("requests", "requesterId", payload.requesterId);
  const holderId = requiredId("requests", "holderId", payload.holderId);
  if (requesterId === holderId) {
    throw new SchemaError("requests: a return needs a holder other than the owner", {
      collection: "requests", field: "holderId",
    });
  }

  const openedBy = payload.openedBy === undefined ? "owner" : str(payload.openedBy);
  if (!RETURN_OPENED_BY.includes(openedBy)) {
    throw new SchemaError(`requests: unknown openedBy "${payload.openedBy}"`, {
      collection: "requests", field: "openedBy",
    });
  }

  return assertRequired("requests", {
    ...returnRequestSchema.defaults,
    type: "return",
    // Every return is born pending; the rules accept no other opening status.
    status: "pending",
    bookId: requiredId("requests", "bookId", payload.bookId),
    communityId: requiredId("requests", "communityId", payload.communityId),
    requesterId,
    holderId,
    bookName: clampText(payload.bookName, LIMITS.NAME_MAX),
    requesterName: clampText(payload.requesterName, LIMITS.NAME_MAX),
    // The four digits the holder reads out at the handover. Minted here when the
    // caller does not bring one, for the same reason a loan mints its own: a
    // request without a code is a handover that cannot be confirmed.
    returnCode: str(payload.returnCode) || newPickupCode(),
    reservedBook: Boolean(payload.reservedBook),
    openedBy,
  }, returnRequestSchema.required);
}

// ---------- posts ----------
//
// A noticeboard entry. Only the two fields an author can see on screen are
// editable; who wrote it, which community it belongs to and when it was posted
// are what make it that post rather than a different one, and the security
// rules freeze all four.

export const postSchema = Object.freeze({
  collection: "posts",
  // `isPublic` is required rather than defaulted on purpose: it decides who can
  // see the post, and the create rule refuses a post that does not carry it as
  // a bool. Guessing a default here would be guessing at an audience.
  required: Object.freeze(["communityId", "authorId", "body"]),
  defaults: Object.freeze({ title: "", likeCount: 0, commentCount: 0 }),
  serverOwned: SERVER_OWNED_FIELDS,
});

/**
 * A new noticeboard entry.
 *
 * `likeCount` is written at birth rather than left absent. The security rule
 * tolerates a missing counter — it reads `get('likeCount', 0)` — but the feed
 * has to *show* a total to everybody looking at the post, and a field that only
 * appears once somebody has liked it is a field every reader has to guess at.
 * Zero is a number; nothing is not.
 */
export function normalizeNewPost(payload) {
  requirePayload("posts", payload);

  if (typeof payload.isPublic !== "boolean") {
    throw new SchemaError("posts: isPublic must be a boolean", {
      collection: "posts", field: "isPublic",
    });
  }

  return assertRequired("posts", {
    ...postSchema.defaults,
    communityId: requiredId("posts", "communityId", payload.communityId),
    authorId: requiredId("posts", "authorId", payload.authorId),
    authorName: clampText(payload.authorName, LIMITS.NAME_MAX),
    title: clampText(payload.title, LIMITS.NAME_MAX),
    body: requiredText("posts", "body", payload.body, LIMITS.DESCRIPTION_MAX, "fillAllFields"),
    isPublic: payload.isPublic,
    likeCount: 0,
    // Same reasoning as `likeCount` above: a total every reader can see has to
    // exist from birth, or the first comment looks like a number appearing out
    // of nowhere rather than a count going up.
    commentCount: 0,
  }, postSchema.required);
}

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

// ---------- comments ----------
//
// A reply under a post. Its own top-level collection rather than a subcollection
// of the post, and it carries a copy of the post's audience — `communityId` and
// `isPublic` — which is the whole reason it can be read cheaply.
//
// Rules are not filters: a list query has to be provably safe before it runs, so
// every read has to *name* the ground it stands on. With the audience copied
// onto the comment, "the comments under this post" is a query this caller is
// plainly allowed to make, and the rule costs no document reads. A subcollection
// would have to `get()` the post once per comment returned to learn the same
// two fields, which is a billed read per row of a comment list.
//
// It is denormalisation, and it has the usual condition attached: the copy is
// written once, at creation, from the post the rules re-read in the same write.
// A post that later changes audience (a community going private, see
// `syncPostVisibility`) leaves its comments behind — they stay as readable as
// the post was when they were written, which is the safe direction for a flag
// that says who may look.

export const commentSchema = Object.freeze({
  collection: "comments",
  required: Object.freeze(["postId", "authorId", "body", "communityId"]),
  defaults: Object.freeze({ authorName: "", photoURL: "" }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export function normalizeNewComment(payload) {
  requirePayload("comments", payload);

  if (typeof payload.isPublic !== "boolean") {
    throw new SchemaError("comments: isPublic must be a boolean", {
      collection: "comments", field: "isPublic",
    });
  }

  return assertRequired("comments", {
    ...commentSchema.defaults,
    postId: requiredId("comments", "postId", payload.postId),
    communityId: requiredId("comments", "communityId", payload.communityId),
    authorId: requiredId("comments", "authorId", payload.authorId),
    // Who wrote it, as they were called at the time — the same arrangement a
    // loan uses for a book's name, and for the same reason: a list of replies
    // renders without a profile fetch per row.
    authorName: clampText(payload.authorName, LIMITS.NAME_MAX),
    photoURL: safeImageUrl(payload.photoURL),
    body: requiredText("comments", "body", payload.body, LIMITS.DESCRIPTION_MAX, "fillAllFields"),
    isPublic: payload.isPublic,
  }, commentSchema.required);
}

// ---------- chats ----------
//
// One conversation between two people, and the id *is* the pair: both uids,
// sorted, joined by a separator. Nothing about that is cosmetic — it is what
// makes a duplicate conversation impossible to create.
//
// The alternative, allocating a random id and searching for an existing chat
// before writing one, has a race with itself: two people opening each other's
// profile at the same moment both find nothing and both create a chat, and from
// then on there are two threads and each of them can only see half the
// conversation. No amount of client-side checking closes that window, because
// the check and the write are two round trips. Deriving the id from the members
// removes the question — both devices compute the same string, and the second
// write is an update of the first document rather than a second document. The
// rules enforce the same derivation, so it holds for a caller that is not this
// app.
//
// Sorting is what makes the pair unordered: a chat is a relationship, not a
// direction, and `a__b` must be the same conversation as `b__a`.
//
// Messages live in a subcollection, `chats/{chatId}/messages`. They are the
// unbounded half of the model and belong under the document that scopes them:
// a thread's history is read by opening one collection with one rule, and it
// never has to be filtered out of everybody else's messages.
//
// What the chat document itself carries is exactly what the conversation list
// needs — who is in it, the last thing said, when, and one unread counter per
// member. That list is the most-read screen in a chat app, and this shape draws
// it from one query with no fan-out: without the rollup, every row would need
// its own query into that thread's messages.

/** Joins the two uids in a chat id. */
export const CHAT_ID_SEPARATOR = "__";

export const chatSchema = Object.freeze({
  collection: "chats",
  required: Object.freeze(["memberIds", "unread"]),
  defaults: Object.freeze({ lastMessage: null }),
  serverOwned: SERVER_OWNED_FIELDS,
});

export const messageSchema = Object.freeze({
  collection: "messages",
  required: Object.freeze(["senderId", "text"]),
  defaults: Object.freeze({}),
  serverOwned: SERVER_OWNED_FIELDS,
});

/**
 * The id of the conversation between two people.
 *
 * Deterministic and symmetric: same two ids in either order, same string. Throws
 * for a single person talking to themselves — a self-chat is not a degenerate
 * conversation to be tolerated, it is a bug upstream, and the rules refuse it
 * too.
 */
export function chatIdFor(a, b) {
  const first = requiredId("chats", "memberIds", a);
  const second = requiredId("chats", "memberIds", b);

  if (first === second) {
    throw new SchemaError("chats: a chat needs two different people", {
      collection: "chats", field: "memberIds", errorKey: "chatSelfError",
    });
  }
  // An id containing the separator would make two different pairs collide on
  // one string. Firebase uids never contain one; a caller inventing ids might.
  if (first.includes(CHAT_ID_SEPARATOR) || second.includes(CHAT_ID_SEPARATOR)) {
    throw new SchemaError(`chats: a user id may not contain "${CHAT_ID_SEPARATOR}"`, {
      collection: "chats", field: "memberIds",
    });
  }

  return [first, second].sort().join(CHAT_ID_SEPARATOR);
}

/** The two members of a chat, sorted — the same order the id is built from. */
export function chatMemberIds(a, b) {
  chatIdFor(a, b); // validates the pair, including the self-chat refusal
  return [String(a).trim(), String(b).trim()].sort();
}

/**
 * The person on the other side, from a chat document and the reader's own id.
 *
 * Returns null when the reader is not in `memberIds` — a corrupt row rather
 * than a missing user, and one the list should skip instead of drawing.
 */
export function otherMemberId(chat, selfId) {
  const members = Array.isArray(chat?.memberIds) ? chat.memberIds : [];
  if (!selfId || !members.includes(selfId)) return null;
  return members.find((id) => id !== selfId) ?? null;
}

/**
 * The chat document as it is born, on the first message rather than on the
 * first visit: an empty conversation is not one, and a chat created by merely
 * opening somebody's profile would put a blank row in both people's lists.
 *
 * `unread` starts at zero for both and is moved by `sendMessage` — the sender
 * has read everything they just wrote, and the recipient has one more waiting.
 */
export function normalizeNewChat({ senderId, recipientId } = {}) {
  const memberIds = chatMemberIds(senderId, recipientId);
  return assertRequired("chats", {
    memberIds,
    unread: { [memberIds[0]]: 0, [memberIds[1]]: 0 },
    lastMessage: null,
  }, chatSchema.required);
}

/**
 * One message. Text only, and required to be text: a message with nothing in it
 * is a mis-tap, and the composer refuses to send one for the same reason the
 * rules do.
 */
export function normalizeNewMessage({ senderId, text } = {}) {
  return assertRequired("messages", {
    senderId: requiredId("messages", "senderId", senderId),
    text: requiredText("messages", "text", text, LIMITS.MESSAGE_MAX, "chatEmptyMessage"),
  }, messageSchema.required);
}

// ---------- receipts ----------
//
// Two ticks and a blue tick, without a write per message.
//
// The obvious model — a `readAt` on every message — costs one write per message
// displayed, and the rules would have to let a reader edit somebody else's
// message to set it. Instead each member keeps two *watermarks* on the chat
// document: the newest moment their device has the conversation
// (`deliveredAt`), and the newest moment they have looked at it (`readAt`).
// A message is delivered or read if it is older than the corresponding mark.
//
// One write when a message lands, one when the thread is opened — regardless of
// how many messages either covers — and both are the writer's own field, which
// is a rule a member can be trusted with. The marks only ever move forward: the
// rules pin each write to `request.time`, so a client cannot rewind one to
// pretend it has not seen something.

/** What an outgoing message has achieved, from the sender's side. */
export const MESSAGE_STATUS = Object.freeze({
  pending: "pending",     // written locally; the server has not stamped it yet
  sent: "sent",           // on the server, not yet on the other device
  delivered: "delivered", // their app has it
  read: "read",           // they have opened the thread since
});

/** One member's watermark, in milliseconds, or 0 when they have none. */
export function chatWatermark(chat, field, userId) {
  if (!chat || !userId) return 0;
  return toMillis(chat[field]?.[userId], 0);
}

/**
 * The tick to draw next to one of the reader's own messages.
 *
 * Deliberately pure and given everything it needs, so the rule lives in one
 * place and can be tested without a database or a screen. `peerId` rather than
 * "the other member" because a caller that has the chat has both ids already.
 *
 * A message with no resolved stamp is `pending`: Firestore reports this
 * client's own write before the server has stamped it, and calling that "sent"
 * would show a tick for something that may still fail.
 */
export function messageStatus(message, chat, peerId) {
  const at = toMillis(message?.createdAt, 0);
  if (!at) return MESSAGE_STATUS.pending;
  if (at <= chatWatermark(chat, "readAt", peerId)) return MESSAGE_STATUS.read;
  if (at <= chatWatermark(chat, "deliveredAt", peerId)) return MESSAGE_STATUS.delivered;
  return MESSAGE_STATUS.sent;
}

/** The preview the conversation list draws, kept on the chat document. */
export function chatPreviewOf({ senderId, text }) {
  return {
    senderId: requiredId("chats", "lastMessage.senderId", senderId),
    // Same clamp as the message itself: the preview is a copy of it, not a
    // summary, and a list row truncates in CSS rather than in the database.
    text: requiredText("chats", "lastMessage.text", text, LIMITS.MESSAGE_MAX),
  };
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

// ---------- follows ----------
//
// One document per "A follows B", at the deterministic id `A__B`. The id is the
// fact, and everything else falls out of it:
//
//   · Following twice is an overwrite rather than a second edge, so a
//     double-tap cannot inflate anybody's counter.
//   · "Am I following this person?" is a single get() at a known path, not a
//     query — which is what makes the button on a profile cost one read.
//   · The security rules can check ownership from the path alone: a caller may
//     only write `$(uid())__$(someoneElse)`, so an edge naming somebody else as
//     the follower is refused before the document is even looked at.
//
// The two counters (`followersCount`, `followingCount` on the user documents)
// are denormalised totals kept beside this collection, for the same reason
// `likeCount` sits on a post: a profile cannot count documents it is not
// allowed to page through. This collection is the fact; the counters are a
// summary that follows it.

/** Joins the two uids in a follow id. Shares the chat separator on purpose. */
export const FOLLOW_ID_SEPARATOR = CHAT_ID_SEPARATOR;

export const followSchema = Object.freeze({
  collection: "follows",
  required: Object.freeze(["id", "followerId", "followingId"]),
  defaults: Object.freeze({}),
  serverOwned: SERVER_OWNED_FIELDS,
});

/**
 * The id of the edge "follower follows following".
 *
 * Ordered, unlike `chatIdFor`: following is not symmetric, and A__B and B__A
 * are two different facts that must be able to coexist.
 */
export function followIdFor(followerId, followingId) {
  const follower = requiredId("follows", "followerId", followerId);
  const following = requiredId("follows", "followingId", followingId);

  if (follower === following) {
    throw new SchemaError("follows: nobody follows themselves", {
      collection: "follows", field: "followingId", errorKey: "followSelfError",
    });
  }
  if (follower.includes(FOLLOW_ID_SEPARATOR) || following.includes(FOLLOW_ID_SEPARATOR)) {
    throw new SchemaError(`follows: a user id may not contain "${FOLLOW_ID_SEPARATOR}"`, {
      collection: "follows", field: "followerId",
    });
  }

  return `${follower}${FOLLOW_ID_SEPARATOR}${following}`;
}

export function normalizeNewFollow(payload) {
  requirePayload("follows", payload);
  const followerId = requiredId("follows", "followerId", payload.followerId);
  const followingId = requiredId("follows", "followingId", payload.followingId);

  return assertRequired("follows", {
    // Written into the document as well as used as the path, so a row read out
    // of a list query knows its own id in the localStorage branch too.
    id: followIdFor(followerId, followingId),
    followerId,
    followingId,
  }, followSchema.required);
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
