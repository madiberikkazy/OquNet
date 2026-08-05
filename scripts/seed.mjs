#!/usr/bin/env node
//
// Seed a Firestore project with a working community: one admin, three members,
// twelve books at assorted stages of being lent and rated.
//
//   node scripts/seed.mjs            # refuses if the collections aren't empty
//   node scripts/seed.mjs --force    # wipe those collections first, then seed
//
// Credentials come from a service-account key — `serviceAccount.json` at the
// repo root (gitignored), or a path in GOOGLE_APPLICATION_CREDENTIALS.
//
// ── Why this script imports src/firebase/schema.js ───────────────────────────
// Every document below is built by the same normalizer the app uses. That is
// the whole point of the file: seeded data that was hand-written as object
// literals would be data whose shape nothing checks, and a seed that disagrees
// with the app is how this project acquired four read-time fallbacks in the
// first place. If a normalizer rejects something here, the app would have been
// unable to write it too — which is the correct outcome, not an obstacle.
//
// ── The two things this script does that the app cannot ──────────────────────
// It runs as the Admin SDK, so the security rules do not apply. It uses that
// for exactly two things, both of which the app has no way to express:
//
//   1. `createdAt` is backdated. The rules pin it to `request.time`, so a real
//      client can only ever write "now" — but a shelf where all twelve books
//      arrived in the same second is not a shelf worth looking at, and the
//      "new books" rail needs some of them to be genuinely recent.
//   2. Auth accounts are created outright, so a user document's id is the uid
//      the app will later sign in as.
//
// Everything else follows the app's own sequence: create the book, then hand it
// over, then rate it — rather than writing the end state directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

import {
  normalizeBookPatch,
  normalizeNewBook,
  normalizeNewBorrowing,
  normalizeNewCommunity,
  normalizeNewUser,
  normalizeRating,
  normalizeUserMembership,
} from "../src/firebase/schema.js";
import { aggregateFromRatings } from "../src/utils/rating.js";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FORCE = process.argv.includes("--force");

// Wiped by --force and checked for emptiness otherwise. `usernames` is in the
// list because it is an index of `users`: leaving it behind would keep every
// seeded nickname permanently taken.
const COLLECTIONS = [
  "books", "borrowings", "ratings", "requests", "posts",
  "notifications", "users", "usernames", "communities",
];

const SEED_PASSWORD = "oqunet123";
const DAY = 86_400_000;

// ── credentials ──────────────────────────────────────────────────────────────

function loadCredential() {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const path = explicit ? resolve(explicit) : resolve(ROOT, "serviceAccount.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(
      `\nNo service-account key at ${path}.\n\n` +
      "  Firebase console → Project settings → Service accounts → Generate new private key,\n" +
      "  save it as serviceAccount.json in the repo root (it is gitignored), and re-run.\n"
    );
    process.exit(1);
  }
}

const credential = loadCredential();
initializeApp({ credential: cert(credential), projectId: credential.project_id });
const db = getFirestore();
const auth = getAuth();

// ── cast ─────────────────────────────────────────────────────────────────────

const COMMUNITY = {
  nickname: "almatybooks",
  name: "Almaty Readers",
  isPrivate: false,
};

const PEOPLE = [
  { key: "admin",  nickname: "aigerim", firstName: "Айгерім", lastName: "Сәрсенова", role: "admin" },
  { key: "dana",   nickname: "dana",    firstName: "Дана",    lastName: "Қасымова" },
  { key: "timur",  nickname: "timur",   firstName: "Тимур",   lastName: "Абенов" },
  { key: "aisha",  nickname: "aisha",   firstName: "Айша",    lastName: "Нұрланова" },
];

// `owner` and `age` drive the interesting part. `age` is days before now, and
// anything under 10 lands in the "new books" rail (NEW_BOOK_WINDOW_DAYS).
const BOOKS = [
  { name: "Абай жолы",              author: "Мұхтар Әуезов",   genres: ["classic", "history"],       year: 1942, maxDays: 21, owner: "admin", age: 2 },
  { name: "Көшпенділер",            author: "Ілияс Есенберлин", genres: ["history", "classic"],      year: 1969, maxDays: 21, owner: "admin", age: 3 },
  { name: "Sapiens",                author: "Yuval Noah Harari", genres: ["nonfiction", "history"],  year: 2011, maxDays: 14, owner: "dana",  age: 4 },
  { name: "Thinking, Fast and Slow", author: "Daniel Kahneman", genres: ["psychology", "science"],   year: 2011, maxDays: 14, owner: "dana",  age: 6 },
  { name: "Дюна",                   author: "Фрэнк Герберт",   genres: ["scifi", "adventure"],       year: 1965, maxDays: 14, owner: "timur", age: 8 },
  { name: "Атомные привычки",       author: "Джеймс Клир",     genres: ["selfhelp", "psychology"],   year: 2018, maxDays: 10, owner: "aisha", age: 9 },
  { name: "Мастер и Маргарита",     author: "Михаил Булгаков", genres: ["classic", "fantasy"],       year: 1967, maxDays: 21, owner: "admin", age: 24 },
  { name: "The Hobbit",             author: "J. R. R. Tolkien", genres: ["fantasy", "adventure"],    year: 1937, maxDays: 14, owner: "dana",  age: 41 },
  { name: "Убийство в Восточном экспрессе", author: "Агата Кристи", genres: ["mystery", "thriller"], year: 1934, maxDays: 10, owner: "timur", age: 58 },
  { name: "Zero to One",            author: "Peter Thiel",     genres: ["business", "nonfiction"],   year: 2014, maxDays: 14, owner: "timur", age: 73 },
  { name: "Ұлы дала әңгімелері",    author: "Оралхан Бөкей",   genres: ["fiction", "poetry"],        year: 1985, maxDays: 21, owner: "aisha", age: 96 },
  { name: "A Brief History of Time", author: "Stephen Hawking", genres: ["science", "nonfiction"],   year: 1988, maxDays: 14, owner: "aisha", age: 120 },
];

// Who has what right now. Each entry is an active loan: the book goes
// "unavailable", the holder moves, and a borrowing document opens.
const LOANS = [
  { book: "Sapiens",            to: "timur", startedDaysAgo: 3, days: 14 },
  { book: "Дюна",               to: "dana",  startedDaysAgo: 5, days: 14 },
  { book: "Мастер и Маргарита", to: "aisha", startedDaysAgo: 9, days: 21 },
];

// Books somebody finished and still has on their shelf — available to request,
// but not with their owner. This is the state the `holderId` / `ownerId` split
// exists for, so the seed had better produce some of it.
const FINISHED = [
  { book: "The Hobbit", by: "timur", finishedDaysAgo: 6, days: 14 },
  { book: "Zero to One", by: "aisha", finishedDaysAgo: 12, days: 14 },
];

// The app only lets you rate a book you have finished (hasUserCompletedBook).
// These are seeded without that history — they exist so the list screens have
// something other than the "not rated yet" default to draw.
const RATINGS = [
  { book: "The Hobbit", by: "timur", value: 5, review: "Тамаша! Бір демде оқып шықтым." },
  { book: "Zero to One", by: "aisha", value: 4, review: "Много спорного, но заставляет думать." },
  { book: "Абай жолы", by: "dana", value: 5, review: "Классика. Әр қазақ оқуы керек." },
  { book: "Абай жолы", by: "timur", value: 4, review: "" },
  { book: "Атомные привычки", by: "dana", value: 3, review: "Одна идея, растянутая на книгу." },
  { book: "Sapiens", by: "aisha", value: 5, review: "" },
];

// ── helpers ──────────────────────────────────────────────────────────────────

const ago = (days) => Timestamp.fromMillis(Date.now() - days * DAY);
const millisAgo = (days) => Date.now() - days * DAY;

/** Delete every document in a collection, in batches. */
async function wipe(name) {
  let removed = 0;
  for (;;) {
    const snap = await db.collection(name).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
  }
  return removed;
}

/** Every Auth account, deleted a page at a time. */
async function wipeAuthUsers() {
  let removed = 0;
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    const uids = page.users.map((u) => u.uid);
    if (uids.length) {
      const result = await auth.deleteUsers(uids);
      removed += result.successCount;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return removed;
}

async function assertEmpty() {
  const nonEmpty = [];
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).limit(1).get();
    if (!snap.empty) nonEmpty.push(name);
  }
  if (nonEmpty.length) {
    console.error(
      `\nRefusing to seed: these collections already hold documents —\n` +
      `  ${nonEmpty.join(", ")}\n\n` +
      `Re-run with --force to delete them (and every Auth account) first.\n`
    );
    process.exit(1);
  }
}

/**
 * Write a document the way createOne does — the caller's fields plus a
 * `createdAt` the caller never supplies. The only difference is that the stamp
 * is backdated here instead of being serverTimestamp().
 */
async function create(collection, id, fields, createdAt) {
  const ref = id ? db.collection(collection).doc(id) : db.collection(collection).doc();
  await ref.set({ ...fields, createdAt });
  return ref.id;
}

// ── seed ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nProject: ${credential.project_id}\n`);

  if (FORCE) {
    for (const name of COLLECTIONS) {
      const n = await wipe(name);
      console.log(`  wiped ${String(n).padStart(4)} × ${name}`);
    }
    console.log(`  wiped ${String(await wipeAuthUsers()).padStart(4)} × auth accounts`);
    console.log("");
  } else {
    await assertEmpty();
  }

  // ── people ────────────────────────────────────────────────────────────────
  // Auth account first: the user document's id has to be the uid, because the
  // security rules resolve the caller's profile at users/{request.auth.uid}.
  const uid = {};
  for (const person of PEOPLE) {
    const email = `${person.nickname}@oqunet.test`;
    const account = await auth.createUser({
      email,
      password: SEED_PASSWORD,
      emailVerified: true,
      displayName: `${person.firstName} ${person.lastName}`,
    });
    uid[person.key] = account.uid;

    // Registration state, exactly as the app writes it: role "user", no
    // community. Membership is a separate write, below.
    await create("users", account.uid, normalizeNewUser({
      id: account.uid,
      email,
      nickname: person.nickname,
      firstName: person.firstName,
      lastName: person.lastName,
      phone: "+7 700 000 00 00",
      address: "Алматы, Абай даңғылы 1",
    }), ago(150));

    await create("usernames", person.nickname, { uid: account.uid, email }, ago(150));
    console.log(`  user     ${person.nickname.padEnd(9)} ${account.uid}`);
  }

  // ── community ─────────────────────────────────────────────────────────────
  const adminUid = uid.admin;
  const communityId = await create("communities", null, normalizeNewCommunity({
    ...COMMUNITY,
    ownerId: adminUid,
  }), ago(140));
  console.log(`\n  community ${COMMUNITY.nickname} → ${communityId}`);

  // Founding a community is what promotes you; everyone else simply joins.
  for (const person of PEOPLE) {
    await db.collection("users").doc(uid[person.key]).update(
      normalizeUserMembership({
        communityId,
        role: person.role === "admin" ? "admin" : undefined,
      })
    );
  }

  // ── books ─────────────────────────────────────────────────────────────────
  const bookId = {};
  for (const book of BOOKS) {
    const id = await create("books", null, normalizeNewBook({
      ...book,
      ownerId: uid[book.owner],
      communityId,
    }), ago(book.age));
    bookId[book.name] = id;
  }
  console.log(`  books     ${BOOKS.length} (${BOOKS.filter((b) => b.age < 10).length} within the new-books window)`);

  // ── active loans ──────────────────────────────────────────────────────────
  // The app's own sequence (transferBookHolder): open the loan, then move the
  // holder. `ownerId` is not in the patch — a handoff never touches it.
  for (const loan of LOANS) {
    const id = bookId[loan.book];
    const book = BOOKS.find((b) => b.name === loan.book);
    const borrower = uid[loan.to];

    await create("borrowings", null, normalizeNewBorrowing({
      bookId: id,
      borrowerId: borrower,
      ownerId: uid[book.owner],
      bookName: loan.book,
      communityId,
      startDate: millisAgo(loan.startedDaysAgo),
      returnDate: millisAgo(loan.startedDaysAgo - loan.days),
    }), ago(loan.startedDaysAgo));

    await db.collection("books").doc(id).update(normalizeBookPatch({
      status: "unavailable",
      borrowerId: borrower,
      holderId: borrower,
    }));
  }
  console.log(`  loans     ${LOANS.length} active`);

  // ── finished reads ────────────────────────────────────────────────────────
  // Closed loan, book back to "available" — but the holder stays the reader.
  // The copy is on their shelf until somebody comes to collect it.
  for (const done of FINISHED) {
    const id = bookId[done.book];
    const book = BOOKS.find((b) => b.name === done.book);
    const reader = uid[done.by];
    const startedDaysAgo = done.finishedDaysAgo + done.days;

    const borrowingId = await create("borrowings", null, normalizeNewBorrowing({
      bookId: id,
      borrowerId: reader,
      ownerId: uid[book.owner],
      bookName: done.book,
      communityId,
      startDate: millisAgo(startedDaysAgo),
      returnDate: millisAgo(done.finishedDaysAgo),
    }), ago(startedDaysAgo));

    await db.collection("borrowings").doc(borrowingId).update({
      status: "completed",
      returnDate: millisAgo(done.finishedDaysAgo),
    });

    await db.collection("books").doc(id).update(normalizeBookPatch({
      status: "available",
      borrowerId: null,
      holderId: reader,
    }));
  }
  console.log(`  finished  ${FINISHED.length} (held by a past reader, not the owner)`);

  // ── ratings ───────────────────────────────────────────────────────────────
  // Deterministic id per (book, user), then the same rollup recalcBookRating
  // performs — so the denormalised counters on the book are real, not invented.
  const rated = new Map();
  for (const entry of RATINGS) {
    const id = bookId[entry.book];
    const document = normalizeRating({
      bookId: id,
      userId: uid[entry.by],
      value: entry.value,
      review: entry.review,
      authorName: PEOPLE.find((p) => p.key === entry.by).firstName,
    });
    await create("ratings", `${id}__${uid[entry.by]}`, document, ago(3));
    rated.set(id, [...(rated.get(id) || []), document]);
  }

  for (const [id, documents] of rated) {
    const summary = aggregateFromRatings(documents);
    await db.collection("books").doc(id).update(normalizeBookPatch({
      rating: summary.average,
      ratingSum: summary.sum,
      ratingCount: summary.count,
    }));
  }
  console.log(`  ratings   ${RATINGS.length} across ${rated.size} books`);

  console.log(
    `\nDone. Sign in as any of: ` +
    PEOPLE.map((p) => `${p.nickname}@oqunet.test`).join(", ") +
    `\nPassword for all of them: ${SEED_PASSWORD}\n`
  );
}

main().catch((err) => {
  console.error("\nSeed failed:", err?.message || err);
  if (err?.collection) console.error(`  collection: ${err.collection}  field: ${err.field ?? "—"}`);
  process.exit(1);
});
