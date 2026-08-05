// Prefix search, and its limits, in one place.
//
// Firestore has no substring index and no full-text search, and no amount of
// index configuration will give it one. What it does have is `array-contains`
// against an indexed array — a single *equality* clause, which is the only kind
// that composes freely with other filters and with an `orderBy`. That is what
// makes it the right primitive here: a search stays one indexed lookup no
// matter what else is narrowing the list.
//
// So each book carries the set of word prefixes of its title and author, and a
// search asks "does this book's prefix set contain what was typed". Typing
// "tol" finds "Tolstoy"; typing "peace" finds "War and Peace".
//
// ── What this is not ─────────────────────────────────────────────────────────
// These limits are real and none of them are small:
//
//   * Prefix from a word boundary, only. "olstoy" finds nothing.
//   * No fuzziness. A typo finds nothing — "Tolstoi" does not reach "Tolstoy".
//   * No stemming, no synonyms, no relevance ranking. Results come back newest
//     first because that is the order the index is in, not because they are the
//     best matches.
//   * Only the first PREFIX_MAX characters of a word are indexed, so a longer
//     query term is truncated and matches more broadly than it appears to.
//   * Multi-word queries are reduced to one word (see `searchTerm`).
//
// The real answer is an external search index — Algolia or Typesense, fed from
// the same write path that maintains these arrays — and this is the piece to
// replace when search matters enough to pay for. It is a findability aid, not
// full-text search, and it should not be described as one.
//
// ── Cost ─────────────────────────────────────────────────────────────────────
// Every entry in the array is an index entry per composite index that contains
// the field. A title and author capped at MAX_WORDS words of PREFIX_MAX
// characters yields at most MAX_PREFIXES strings, so a book costs at most a few
// hundred index entries against Firestore's 40,000-per-document ceiling.

/** Longest word prefix stored, and therefore the longest query that is exact. */
export const SEARCH_PREFIX_MAX = 12;

/** Words taken from a document. Past this, a long subtitle stops contributing. */
const MAX_WORDS = 12;

/** Hard ceiling on the stored array, whatever the input. */
const MAX_PREFIXES = 120;

// Split on anything that is not a letter or a digit, in any script — the app is
// trilingual, so Cyrillic and Kazakh-specific letters have to survive this.
const SEPARATORS = /[^\p{L}\p{N}]+/u;

function words(text) {
  return String(text ?? "").toLowerCase().split(SEPARATORS).filter(Boolean);
}

/**
 * The prefix set for one or more pieces of text — everything a user could type
 * that should match this document.
 *
 * Pure and free of the Firebase SDK, like the rest of the schema layer, so the
 * app, the seed script and the backfill script all derive the same array from
 * the same input.
 */
export function searchPrefixes(...texts) {
  const out = new Set();
  for (const word of words(texts.join(" ")).slice(0, MAX_WORDS)) {
    const chars = [...word].slice(0, SEARCH_PREFIX_MAX);
    for (let i = 1; i <= chars.length; i += 1) {
      out.add(chars.slice(0, i).join(""));
      if (out.size >= MAX_PREFIXES) return [...out];
    }
  }
  return [...out];
}

/**
 * The single term to query with, from whatever the user typed.
 *
 * `array-contains` takes one value, so a multi-word query is reduced to its
 * most selective word — the longest one, since a longer prefix matches fewer
 * documents. The other words are dropped rather than applied as a second pass
 * over the results: filtering a fetched page in JavaScript is precisely the bug
 * this module exists to remove, and "war peace" returning everything matching
 * "peace" is a wider result set, not a wrong one.
 *
 * Returns "" when there is nothing searchable, which callers read as "no search
 * filter" rather than "search for nothing".
 */
export function searchTerm(input) {
  const parts = words(input);
  if (!parts.length) return "";
  let best = parts[0];
  for (const word of parts) if (word.length > best.length) best = word;
  return [...best].slice(0, SEARCH_PREFIX_MAX).join("");
}
