// What the shelf is narrowed by, in one place.
//
// The filter screen writes these, the Books screen reads them, and both go
// through this module rather than each knowing the shape — the two screens are
// separate routes now, so the filter state lives in the URL between them and a
// disagreement about how it is spelled would be a filter that silently resets
// when you come back from picking it.
//
// ── Why some of these run on the client ──────────────────────────────────────
//
// Firestore serves a query from an index, and a composite index has to exist
// for each *combination* of filtered fields. Six filters is sixty-four
// combinations; nobody is going to maintain that file, and Firestore charges
// write amplification for every index whether or not a query uses it.
//
// So the split is drawn where the indexes already are. `status` and `genres`
// go to the server because listBooks has always sent them and the indexes are
// in firestore.indexes.json. Language, author, page band and year are applied
// here, over the pages the shelf has already fetched.
//
// The cost is honest and worth stating: a narrow filter over a large shelf
// reads more documents than it shows, because the scan keeps pulling pages
// until it finds matches or runs out. That is why Books raises its page size
// while a client-side filter is on — the same number of round trips brings back
// more candidates — and why "no matches" is only said once the shelf is
// exhausted rather than the moment a page comes back empty.

import { PAGE_STEP, PAGES_MAX } from "./bookPages.js";
import { LIMITS } from "./validators.js";

export const YEAR_MIN = LIMITS.YEAR_MIN;
export const YEAR_MAX = LIMITS.YEAR_MAX;

/** The page slider runs from 0 so the shortest band ("0–50") has a low end. */
export const PAGES_MIN = 0;
export { PAGES_MAX, PAGE_STEP };

/**
 * Books added before the language field existed have none, and there are
 * whole shelves of them. Offering "not set" as a filter value is what makes
 * that fixable: an admin can list exactly the books still missing a language
 * instead of hunting for them one at a time.
 */
export const LANGUAGE_UNSET = "none";

export const EMPTY_FILTERS = Object.freeze({
  status: null,
  genres: [],
  languages: [],
  author: "",
  pages: [PAGES_MIN, PAGES_MAX],
  years: [YEAR_MIN, YEAR_MAX],
});

const STATUSES = ["available", "soon", "unavailable"];

function clampInt(value, lo, hi, fallback) {
  // The empty string has to be rejected before Number sees it: `Number("")` is
  // 0, not NaN, so a half-written param like `years=-` would otherwise clamp
  // both ends to the low bound and read as "published in 1450", which matches
  // nothing and looks like the filter is broken rather than absent.
  if (typeof value !== "number" && !String(value ?? "").trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** A `[low, high]` pair from two params, ordered and inside the bounds. */
function readRange(params, key, lo, hi) {
  const raw = params.get(key);
  if (!raw) return [lo, hi];
  const [a, b] = raw.split("-");
  const low = clampInt(a, lo, hi, lo);
  const high = clampInt(b, lo, hi, hi);
  return low <= high ? [low, high] : [high, low];
}

/** Read the filter state out of a URL. Anything unparseable reads as unset. */
export function readFilters(params) {
  const status = params.get("status");
  return {
    status: STATUSES.includes(status) ? status : null,
    genres: (params.get("genres") || "").split(",").filter(Boolean),
    languages: (params.get("langs") || "").split(",").filter(Boolean),
    author: (params.get("author") || "").trim(),
    pages: readRange(params, "pages", PAGES_MIN, PAGES_MAX),
    years: readRange(params, "years", YEAR_MIN, YEAR_MAX),
  };
}

/**
 * The other direction. Only what is actually set is written, so a URL with no
 * filters is a bare `/books` rather than a line of defaults — which matters
 * because that URL is what the back button and a shared link carry.
 */
export function writeFilters(filters) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.genres.length) params.set("genres", filters.genres.join(","));
  if (filters.languages.length) params.set("langs", filters.languages.join(","));
  if (filters.author) params.set("author", filters.author);
  if (filters.pages[0] > PAGES_MIN || filters.pages[1] < PAGES_MAX) {
    params.set("pages", `${filters.pages[0]}-${filters.pages[1]}`);
  }
  if (filters.years[0] > YEAR_MIN || filters.years[1] < YEAR_MAX) {
    params.set("years", `${filters.years[0]}-${filters.years[1]}`);
  }
  return params;
}

/** How many of the six are narrowing anything — the number on the filter dot. */
export function activeFilterCount(f) {
  let n = 0;
  if (f.status) n += 1;
  if (f.genres.length) n += 1;
  if (f.languages.length) n += 1;
  if (f.author) n += 1;
  if (f.pages[0] > PAGES_MIN || f.pages[1] < PAGES_MAX) n += 1;
  if (f.years[0] > YEAR_MIN || f.years[1] < YEAR_MAX) n += 1;
  return n;
}

/**
 * True when any filter has to be applied here rather than by the query.
 *
 * Books asks this to decide how hard to scan: with none of these on, a page of
 * results is a page of rows the reader will see, and the shelf can page
 * normally. With one on, a page is a page of *candidates*.
 */
export function hasClientFilters(f) {
  return Boolean(
    f.languages.length ||
    f.author ||
    f.pages[0] > PAGES_MIN || f.pages[1] < PAGES_MAX ||
    f.years[0] > YEAR_MIN || f.years[1] < YEAR_MAX
  );
}

/**
 * Does this book survive the filters that the query could not apply?
 *
 * A book missing the field a filter names is excluded rather than kept. Both
 * readings are defensible for one book, but not for a shelf: "books in English"
 * that quietly includes every book whose language nobody recorded is a filter
 * that appears not to work, and the reader has no way to tell the two cases
 * apart. `LANGUAGE_UNSET` exists so the excluded pile is still reachable.
 */
export function matchesFilters(book, f) {
  if (f.languages.length) {
    const language = book.language || LANGUAGE_UNSET;
    if (!f.languages.includes(language)) return false;
  }

  if (f.author) {
    const author = String(book.author || "").toLowerCase();
    if (!author.includes(f.author.toLowerCase())) return false;
  }

  const [pageLow, pageHigh] = f.pages;
  if (pageLow > PAGES_MIN || pageHigh < PAGES_MAX) {
    const band = Number(book.pages);
    if (!Number.isFinite(band) || band <= 0) return false;
    // A stored band is its upper bound, so the book spans (band-50, band]. It
    // survives when that span overlaps the selection — comparing the single
    // stored number against the range would drop a 100-page book from a
    // "0–100" filter or keep it in a "100–200" one, depending which end you
    // picked, and neither is what the slider says.
    if (band <= pageLow || band - PAGE_STEP >= pageHigh) return false;
  }

  const [yearLow, yearHigh] = f.years;
  if (yearLow > YEAR_MIN || yearHigh < YEAR_MAX) {
    const year = Number(book.year);
    if (!Number.isFinite(year) || !year) return false;
    if (year < yearLow || year > yearHigh) return false;
  }

  return true;
}
