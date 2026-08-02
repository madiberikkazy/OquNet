// Rating rules, in one place so the list, the detail page and the write path
// can never disagree about what a book's score is.
//
//   score = sum(stars) / count(stars)
//
// A book nobody has rated yet has no score at all — we show DEFAULT_RATING for
// it instead of 0.0, because a fresh book is not a bad book. `isDefault` on the
// summary lets the UI say so out loud.

import { getCurrentLang } from "./i18n.js";

export const DEFAULT_RATING = 5;
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** Coerce anything into a whole 1..5 star value. Returns 0 when unusable. */
export function clampStars(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < RATING_MIN) return 0;
  return Math.min(n, RATING_MAX);
}

/**
 * Fold raw rating documents into { count, sum, average }.
 * `value` is the canonical field; `stars` is read as a fallback for documents
 * written before the two were unified.
 */
export function aggregateFromRatings(ratings = []) {
  const stars = ratings
    .map((r) => clampStars(r?.value ?? r?.stars))
    .filter(Boolean);
  const count = stars.length;
  const sum = stars.reduce((a, b) => a + b, 0);
  return { count, sum, average: count ? sum / count : 0 };
}

/**
 * Read a display summary off anything carrying the denormalised counters —
 * a book document, or the { rating, ratingCount } shape the list pages build.
 */
export function ratingSummary(source) {
  const count = Math.max(0, Math.trunc(Number(source?.ratingCount)) || 0);
  if (count === 0) {
    return { count: 0, average: DEFAULT_RATING, isDefault: true };
  }
  const sum = Number(source?.ratingSum);
  const average = Number.isFinite(sum) && sum > 0 ? sum / count : Number(source?.rating) || 0;
  return { count, average, isDefault: false };
}

/**
 * The review feed for a book: every rating that carries text, newest first.
 * A review is not a separate record — it is the optional note on a rating.
 */
export function reviewsFromRatings(ratings = []) {
  const millis = (r) => r?.createdAt?.toMillis?.() ?? r?.createdAt ?? 0;
  return ratings
    .filter((r) => String(r?.review || "").trim())
    .sort((a, b) => millis(b) - millis(a));
}

/** "4.4" in English, "4,4" in Kazakh/Russian — matches the rest of the UI. */
export function formatRating(value) {
  const fixed = (Number(value) || 0).toFixed(1);
  return getCurrentLang() === "en" ? fixed : fixed.replace(".", ",");
}
