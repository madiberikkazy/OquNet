#!/usr/bin/env node
//
// Give every existing post the `isPublic` flag the Home discovery feed reads.
//
//   node scripts/backfill-post-visibility.mjs --dry-run   # report, write nothing
//   node scripts/backfill-post-visibility.mjs             # stamp the missing flags
//   node scripts/backfill-post-visibility.mjs --all       # re-stamp every post
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The Home feed shows posts from every public community, and the security rule
// decides that per document: `isPublic == true`. The flag lives on the post
// rather than being read from its community because a rule that had to `get()`
// the community would spend a document read per row returned.
//
// A post written before the flag existed has no `isPublic`, which reads as
// false — so it is not "ranked lower" in discovery, it is absent from it. Its
// own community's members still see it, because the second half of the read
// rule matches on `communityId`. `createPost` covers everything written from
// now on; this covers everything written before.
//
// The value is derived from the owning community: public community → true.
// A community with no document left is treated as private and skipped loudly —
// guessing "public" for a post whose community is gone is the one mistake here
// that cannot be taken back.
//
// Run it once, after `firebase deploy --only firestore:indexes,firestore:rules`.
//
// `--all` re-derives every post, for after a bulk privacy change made outside
// the app (the app itself re-stamps through `syncPostVisibility`).
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

async function main() {
  const [posts, communities] = await Promise.all([
    db.collection("posts").get(),
    db.collection("communities").get(),
  ]);

  // One read of the whole community list beats one read per post: a project has
  // orders of magnitude more posts than communities.
  const isPublicById = new Map(
    communities.docs.map((d) => [d.id, d.data().isPrivate !== true])
  );
  console.log(`${posts.size} post(s), ${communities.size} community(ies).`);

  let batch = db.batch();
  let pending = 0;
  let written = 0;
  let skipped = 0;
  let orphaned = 0;

  for (const doc of posts.docs) {
    const post = doc.data();
    const known = isPublicById.has(post.communityId);

    if (!known) {
      // No community document to derive from. Left alone rather than guessed:
      // its members can still read it, and nobody else gains access.
      console.warn(`  ! ${doc.id}: unknown communityId ${JSON.stringify(post.communityId)} — left as is`);
      orphaned += 1;
      continue;
    }

    const next = isPublicById.get(post.communityId);
    const current = post.isPublic;
    const stale = typeof current !== "boolean" || (REWRITE_ALL && current !== next);
    if (!stale) {
      skipped += 1;
      continue;
    }

    written += 1;
    if (DRY_RUN) continue;

    batch.update(doc.ref, { isPublic: next });
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
      ? `Dry run: ${written} post(s) would be stamped, ${skipped} already current, ${orphaned} orphaned.`
      : `Stamped ${written} post(s); ${skipped} already current, ${orphaned} orphaned.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
