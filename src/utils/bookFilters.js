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

/**
 * The orders the shelf can be read in.
 *
 * `dir` is the direction that option opens on, and it is a per-option default
 * rather than one global one because the useful end differs: the highest rating
 * and the newest year are what people look for, while A comes before B and a
 * short book is the one somebody with an evening free is after.
 *
 * `shelf` is the app's own order — pages in the order Firestore returns them,
 * shuffled per page — and it is deliberately first and default. Every other
 * option here costs a full scan (see sortNeedsFullScan), so the order that
 * costs nothing is the one the screen opens on.
 */
export const SORTS = Object.freeze([
  { value: "shelf",  dir: "desc", labelKey: "sortShelf" },
  { value: "rating", dir: "desc", labelKey: "sortRating" },
  { value: "reads",  dir: "desc", labelKey: "sortReads" },
  { value: "year",   dir: "desc", labelKey: "sortYear" },
  { value: "pages",  dir: "asc",  labelKey: "sortPages" },
  { value: "letter", dir: "asc",  labelKey: "sortLetter" },
]);

export const DEFAULT_SORT = Object.freeze({ by: "shelf", dir: "desc" });

export const EMPTY_FILTERS = Object.freeze({
  status: null,
  genres: [],
  languages: [],
  author: "",
  pages: [PAGES_MIN, PAGES_MAX],
  years: [YEAR_MIN, YEAR_MAX],
  sort: DEFAULT_SORT,
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
    sort: readSort(params),
  };
}

function readSort(params) {
  const by = params.get("sort");
  const option = SORTS.find((s) => s.value === by);
  if (!option) return DEFAULT_SORT;
  const dir = params.get("dir");
  return { by: option.value, dir: dir === "asc" || dir === "desc" ? dir : option.dir };
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
  // The default order writes nothing, so an unsorted, unfiltered shelf is a
  // bare `/books` — and a link that carries a sort carries its direction with
  // it, even when that direction is the option's own default, so following the
  // link cannot land on a different order than the one that was shared.
  const sort = filters.sort || DEFAULT_SORT;
  if (sort.by && sort.by !== DEFAULT_SORT.by) {
    params.set("sort", sort.by);
    params.set("dir", sort.dir);
  }
  return params;
}

/** True when the order is anything other than the shelf's own. */
export function isSorted(filters) {
  return (filters.sort?.by || DEFAULT_SORT.by) !== DEFAULT_SORT.by;
}

/**
 * Sorting needs every book, not the page that happens to be loaded.
 *
 * This is the honest cost of ordering on the client. "The highest rated books"
 * computed over the first twenty-five rows is not a wrong order, it is an
 * answer to a different question — and the reader has no way to tell, because
 * a sorted list of the wrong books looks exactly like a sorted list of the
 * right ones. So Books scans the shelf to the end before it shows an order.
 */
export function sortNeedsFullScan(filters) {
  return isSorted(filters);
}

/** Nulls last in every order, so "unknown" never wins a "highest" question. */
function compareBy(field, a, b) {
  const av = a[field];
  const bv = b[field];
  const aMissing = av == null || av === "" || Number.isNaN(av);
  const bMissing = bv == null || bv === "" || Number.isNaN(bv);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return 0;
}

const NUMERIC = {
  rating: (b) => (Number(b.ratingCount) > 0 ? Number(b.ratingSum) / Number(b.ratingCount) : null),
  reads: (b) => Math.trunc(Number(b.readCount) || 0),
  year: (b) => (Number(b.year) > 0 ? Number(b.year) : null),
  pages: (b) => (Number(b.pages) > 0 ? Number(b.pages) : null),
};

/**
 * The shelf in the requested order.
 *
 * Returns a new array — the caller's list is memoised from the query cache and
 * sorting it in place would reorder the cache itself, which shows up as the
 * rail above the list quietly changing order too.
 *
 * Titles are compared with `localeCompare` and the reader's own locale, because
 * "letter" is not one alphabet: Ә sorts after А in Kazakh and nowhere at all in
 * a codepoint comparison, which would file every Kazakh title starting with a
 * non-ASCII letter after every Latin one.
 *
 * `lang` is the app's own language code, and the mapping below is why this
 * takes it rather than a locale. The app spells Kazakh "kz"; the language tag
 * for Kazakh is "kk". "kz" is *structurally* valid, so Intl does not complain —
 * it quietly resolves to the default locale and sorts Kazakh titles with
 * English rules. A silent wrong answer, which is the kind worth converting into
 * a table.
 */
const COLLATION_LOCALES = { kz: "kk", ru: "ru", en: "en" };

export function sortBooks(books, sort, lang) {
  const locale = COLLATION_LOCALES[lang] || "en";
  const by = sort?.by || DEFAULT_SORT.by;
  if (by === DEFAULT_SORT.by) return books;
  const sign = sort?.dir === "asc" ? 1 : -1;

  const sorted = [...books];

  if (by === "letter") {
    sorted.sort((a, b) => {
      const missing = compareBy("name", a, b);
      if (missing) return missing;
      return sign * String(a.name).localeCompare(String(b.name), locale, { sensitivity: "base" });
    });
    return sorted;
  }

  const read = NUMERIC[by];
  if (!read) return books;

  sorted.sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    if (av == null && bv == null) return 0;
    // Missing values sink regardless of direction: a book with no year is not
    // the oldest book, it is a book whose year nobody wrote down.
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
  return sorted;
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
