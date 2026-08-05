#!/usr/bin/env node
//
// Give every existing book the `searchPrefixes` array the search query needs.
//
//   node scripts/backfill-search.mjs --dry-run   # report, write nothing
//   node scripts/backfill-search.mjs             # write the missing arrays
//   node scripts/backfill-search.mjs --all       # rewrite every book's array
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Book search is an indexed `array-contains` against `searchPrefixes`. A book
// written before that field existed has no array, and `array-contains` does not
// match a missing field — so such a book is not "ranked lower", it is
// unfindable by name. `normalizeNewBook` covers everything written from now on;
// this covers everything written before.
//
// Run it once, after `firebase deploy --only firestore:indexes` has finished
// building. Order matters only in that searching against a half-built index
// fails loudly (FAILED_PRECONDITION) rather than quietly, so there is no way to
// get a wrong answer out of doing it the other way round — just an error.
//
// `--all` is for after a change to the prefix rules in src/utils/search.js:
// documents that already have an array are correct only with respect to the
// version of that file they were written under.
//
// Credentials work exactly as in seed.mjs — `serviceAccount.json` at the repo
// root, or a path in GOOGLE_APPLICATION_CREDENTIALS. This runs as the Admin
// SDK, so the security rules do not apply; it needs that, because a backfill is
// nobody's community admin.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { bookSearchFields } from "../src/firebase/schema.js";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DRY_RUN = process.argv.includes("--dry-run");
const REWRITE_ALL = process.argv.includes("--all");

// Firestore caps a batched write at 500 operations.
const BATCH_LIMIT = 400;

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

/** True when the stored array differs from what the current rules produce. */
function needsWrite(book, next) {
  const current = book.searchPrefixes;
  if (!Array.isArray(current)) return true;
  if (!REWRITE_ALL) return false;
  return current.length !== next.length || current.some((v, i) => v !== next[i]);
}

async function main() {
  const snap = await db.collection("books").get();
  console.log(`${snap.size} book(s) in the collection.`);

  let batch = db.batch();
  let pending = 0;
  let written = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const book = doc.data();
    const fields = bookSearchFields(book);

    if (!needsWrite(book, fields.searchPrefixes)) {
      skipped += 1;
      continue;
    }

    // A book with no title and no author produces an empty array, which is a
    // book that matches nothing. Say so rather than writing it silently — it
    // means the document is malformed, not that the backfill has a bug.
    if (fields.searchPrefixes.length === 0) {
      console.warn(`  ! ${doc.id}: no searchable text (name=${JSON.stringify(book.name)}, author=${JSON.stringify(book.author)})`);
    }

    written += 1;
    if (DRY_RUN) continue;

    batch.update(doc.ref, fields);
    pending += 1;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (!DRY_RUN && pending > 0) await batch.commit();

  console.log(
    DRY_RUN
      ? `Dry run: ${written} book(s) would be updated, ${skipped} left alone.`
      : `Updated ${written} book(s); ${skipped} already current.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
