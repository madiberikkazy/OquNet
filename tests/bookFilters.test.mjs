// The six filters behind the Books filter screen — src/utils/bookFilters.js.
//
// Two things here are genuinely easy to get wrong and cheap to pin down, and
// neither is visible from the screen until a reader complains that a book they
// can see is missing from a filter that should match it:
//
//   · the page band. A book stores the *upper bound* of its band, so a "300"
//     is the range 250–300. Comparing that one number against a slider's two
//     is off by a whole band at each end depending which way you lean, which is
//     exactly the class of bug that looks like a rounding preference until you
//     hold two examples next to each other;
//   · the URL round trip. The filter screen and the shelf are separate routes
//     and the state travels between them as a query string, so anything that
//     does not survive `write → read` is a filter that silently resets the
//     moment it is applied.
//
// The rest — a missing field excluding a book rather than keeping it — is a
// judgement call the module documents, and it is tested because it is a
// judgement call: a future change that flips it should have to say so here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_FILTERS, LANGUAGE_UNSET, PAGES_MAX, PAGES_MIN, YEAR_MAX, YEAR_MIN,
  activeFilterCount, hasClientFilters, matchesFilters, readFilters, writeFilters,
} from "../src/utils/bookFilters.js";

/** A book that passes every filter, so each test can spoil exactly one field. */
const book = (patch = {}) => ({
  name: "Abai jolyn", author: "Mukhtar Auezov",
  language: "kk", pages: 300, year: 1969,
  ...patch,
});

const filters = (patch = {}) => ({ ...EMPTY_FILTERS, ...patch });
const roundTrip = (f) => readFilters(new URLSearchParams(writeFilters(f).toString()));

describe("page band matching", () => {
  it("keeps a band that overlaps the selection", () => {
    // 300 means 250–300, and the reader asked for 100–400.
    assert.equal(matchesFilters(book({ pages: 300 }), filters({ pages: [100, 400] })), true);
  });

  it("keeps a band that only partly overlaps at either end", () => {
    // 150 is 100–150 and the window starts at 120: they share 120–150.
    assert.equal(matchesFilters(book({ pages: 150 }), filters({ pages: [120, 400] })), true);
    // 400 is 350–400 against a window ending at 380: they share 350–380.
    assert.equal(matchesFilters(book({ pages: 400 }), filters({ pages: [100, 380] })), true);
  });

  it("drops a band that only touches the boundary", () => {
    // 100 is 50–100. A window starting *at* 100 contains no part of it — the
    // book is at most 100 pages and the reader asked for more than that.
    assert.equal(matchesFilters(book({ pages: 100 }), filters({ pages: [100, 400] })), false);
    // 400 is 350–400, and a window ending at 350 stops where the book starts.
    assert.equal(matchesFilters(book({ pages: 400 }), filters({ pages: [100, 350] })), false);
  });

  it("drops a book with no page band once the slider is narrowed", () => {
    assert.equal(matchesFilters(book({ pages: undefined }), filters({ pages: [100, 400] })), false);
  });

  it("keeps a book with no page band while the slider is untouched", () => {
    assert.equal(matchesFilters(book({ pages: undefined }), filters()), true);
  });
});

describe("language matching", () => {
  it("matches the book's own language", () => {
    assert.equal(matchesFilters(book({ language: "ru" }), filters({ languages: ["ru"] })), true);
    assert.equal(matchesFilters(book({ language: "ru" }), filters({ languages: ["kk"] })), false);
  });

  it("treats a book from before the field as unset, not as a wildcard", () => {
    const old = book({ language: undefined });
    assert.equal(matchesFilters(old, filters({ languages: ["kk"] })), false);
    assert.equal(matchesFilters(old, filters({ languages: [LANGUAGE_UNSET] })), true);
  });
});

describe("author and year", () => {
  it("matches an author on a case-insensitive substring", () => {
    assert.equal(matchesFilters(book(), filters({ author: "auezov" })), true);
    assert.equal(matchesFilters(book(), filters({ author: "AUEZ" })), true);
    assert.equal(matchesFilters(book(), filters({ author: "tolstoy" })), false);
  });

  it("keeps a year inside the range and drops one outside it", () => {
    assert.equal(matchesFilters(book({ year: 1969 }), filters({ years: [1960, 1980] })), true);
    assert.equal(matchesFilters(book({ year: 1959 }), filters({ years: [1960, 1980] })), false);
  });

  it("drops a book with no year once the range is narrowed", () => {
    assert.equal(matchesFilters(book({ year: "" }), filters({ years: [1960, 1980] })), false);
    assert.equal(matchesFilters(book({ year: "" }), filters()), true);
  });
});

describe("the URL round trip", () => {
  it("writes nothing at all when nothing is set", () => {
    assert.equal(writeFilters(filters()).toString(), "");
    assert.deepEqual(readFilters(new URLSearchParams("")), EMPTY_FILTERS);
  });

  it("carries every filter through unchanged", () => {
    const f = filters({
      status: "available",
      genres: ["history", "classic"],
      languages: ["kk", LANGUAGE_UNSET],
      author: "Auezov",
      pages: [100, 400],
      years: [1960, 1980],
    });
    assert.deepEqual(roundTrip(f), f);
  });

  it("omits a range that still covers everything", () => {
    const written = writeFilters(filters({ pages: [PAGES_MIN, PAGES_MAX], years: [YEAR_MIN, YEAR_MAX] }));
    assert.equal(written.has("pages"), false);
    assert.equal(written.has("years"), false);
  });

  it("reads a junk URL as no filter rather than throwing", () => {
    const f = readFilters(new URLSearchParams("status=banana&pages=abc-def&years=-"));
    assert.deepEqual(f, EMPTY_FILTERS);
  });

  it("clamps a range that arrives out of bounds or backwards", () => {
    const f = readFilters(new URLSearchParams(`pages=900-100&years=${YEAR_MIN - 500}-${YEAR_MAX + 500}`));
    assert.deepEqual(f.pages, [100, 900]);
    assert.deepEqual(f.years, [YEAR_MIN, YEAR_MAX]);
  });
});

describe("counting what is on", () => {
  it("counts each narrowed filter once", () => {
    assert.equal(activeFilterCount(filters()), 0);
    assert.equal(activeFilterCount(filters({ status: "available" })), 1);
    assert.equal(
      activeFilterCount(filters({ status: "available", author: "x", pages: [100, 400] })),
      3
    );
  });

  it("separates the filters the query can carry from the ones it cannot", () => {
    // status and genres go to Firestore, so they are not a client-side scan.
    assert.equal(hasClientFilters(filters({ status: "available", genres: ["history"] })), false);
    assert.equal(hasClientFilters(filters({ languages: ["kk"] })), true);
    assert.equal(hasClientFilters(filters({ years: [1960, YEAR_MAX] })), true);
  });
});
