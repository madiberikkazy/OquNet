// How long a book may be kept, decided by how long the book is.
//
// The admin used to type a number of days straight into the Add-Book form,
// which asked them to price a loan and left every book on the shelf priced by a
// different instinct. They now pick the one thing they can read off the back
// cover — roughly how many pages it has — and the loan period follows from it:
// one day per fifty pages, up to a thousand pages and twenty days.
//
// `pages` is stored as the *upper bound* of the band the admin picked, which is
// the whole band: 50 means "0–50", 100 means "50–100". One number carries both
// the label and the allowance, so nothing has to be kept in step with anything.

/** Pages per band, and per day of loan — the constant the whole rule turns on. */
export const PAGE_STEP = 50;

/** The longest book the picker offers. Twenty bands, so twenty days at most. */
export const PAGES_MAX = 1000;

/** Every band the admin may choose, shortest first. */
export const PAGE_BANDS = Object.freeze(
  Array.from({ length: PAGES_MAX / PAGE_STEP }, (_, i) => {
    const pages = (i + 1) * PAGE_STEP;
    return Object.freeze({ pages, from: pages - PAGE_STEP, days: i + 1 });
  })
);

/** The loan a book of this length earns, in days. */
export function loanDaysForPages(value) {
  const pages = clampPages(value);
  return pages / PAGE_STEP;
}

/** "50–100" — the band as the admin picked it and the reader reads it. */
export function pagesRangeLabel(value) {
  const pages = clampPages(value);
  return `${pages - PAGE_STEP}–${pages}`;
}

/** True when `value` names one of the bands above, and not something between. */
export function isPageBand(value) {
  const pages = Number(value);
  return (
    Number.isInteger(pages) &&
    pages >= PAGE_STEP &&
    pages <= PAGES_MAX &&
    pages % PAGE_STEP === 0
  );
}

/** The nearest real band, for a number that came from outside the picker. */
export function clampPages(value) {
  const pages = Number(value);
  if (!Number.isFinite(pages)) return PAGE_STEP;
  const rounded = Math.ceil(pages / PAGE_STEP) * PAGE_STEP;
  return Math.min(PAGES_MAX, Math.max(PAGE_STEP, rounded));
}

/**
 * The band a book already on the shelf belongs to.
 *
 * Books added before this rule existed carry `maxDays` and no `pages`. Their
 * allowance is the only thing that was ever true about them, so the band is
 * read back out of it — an edit form opens on the band that matches the loan
 * the book already grants, rather than on a blank the admin has to guess at.
 */
export function pagesForBook(book) {
  if (isPageBand(book?.pages)) return Number(book.pages);
  const days = Number(book?.maxDays);
  if (Number.isFinite(days) && days > 0) return clampPages(days * PAGE_STEP);
  return PAGE_STEP;
}
