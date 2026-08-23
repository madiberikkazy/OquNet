// Centralised input validation + sanitisation helpers.
// Every public form should run user input through one of these so the rest
// of the app can trust what it receives.

import { clampPages, isPageBand, loanDaysForPages } from "./bookPages.js";
// i18n is a leaf — the dictionaries import nothing — so this is a safe edge and
// not a cycle, the same reason utils/time.js may import it.
import { BOOK_LANGUAGES } from "./i18n.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NICK_RE = /^[a-z0-9_]{2,24}$/;
// Allow letters from any script, spaces, hyphens, apostrophes — 1..60 chars.
const NAME_RE = /^[\p{L}\p{M}'\- ]{1,60}$/u;
const PHONE_RE = /^\+?[\d\s\-()]{5,20}$/;

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

export const LIMITS = Object.freeze({
  NAME_MAX: 120,
  AUTHOR_MAX: 120,
  ADDRESS_MAX: 160,
  DESCRIPTION_MAX: 2000,
  REVIEW_MAX: 2000,
  // One chat message. Long enough for a paragraph nobody wanted to split in
  // two, short enough that a single document stays a message rather than an
  // attachment — the chat list carries a preview of every one of these.
  MESSAGE_MAX: 2000,
  PASSWORD_MIN: 6,
  PASSWORD_MAX: 128,
  YEAR_MIN: 1450,
  YEAR_MAX: new Date().getFullYear() + 1,
  // A loan is no longer typed in — it is derived from the book's length, one
  // day per fifty pages (utils/bookPages.js). The floor is 1 because the
  // shortest band earns exactly one day; the ceiling stays at 30, above the 20
  // the bands can produce, so books priced by hand under the old form remain
  // valid to read and to edit.
  LOAN_DAYS_MIN: 1,
  LOAN_DAYS_MAX: 30,
});

export function isEmail(s) {
  return typeof s === "string" && EMAIL_RE.test(s.trim());
}

export function normalizeEmail(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

export function isNickname(s) {
  return typeof s === "string" && NICK_RE.test(s);
}

export function normalizeNickname(s) {
  if (typeof s !== "string") return "";
  return s.trim().toLowerCase().replace(/\s+/g, "").slice(0, 24);
}

export function isName(s) {
  return typeof s === "string" && NAME_RE.test(s.trim());
}

export function isPhone(s) {
  return typeof s === "string" && PHONE_RE.test(s.trim());
}

/**
 * A number in the one format an SMS gateway will accept: E.164, `+` and digits.
 *
 * `isPhone` above is a *shape* check for a field someone is still typing into.
 * This is the conversion that has to happen before the number leaves the app,
 * and it is stricter on purpose: everything stored and verified from now on is
 * the E.164 form, because that is what Firebase sends the code to and what it
 * writes back into the ID token — and a profile that says "+7 (777) 123-45-67"
 * while the token says "+77771234567" is a profile the security rules would
 * refuse for a number the person genuinely proved.
 *
 * Kazakhstan is the default country, so the two ways people write a local
 * number here both land in the same place:
 *
 *   8 777 123 45 67   →  +77771234567
 *   777 123 45 67     →  +77771234567
 *
 * Anything already carrying a `+` is taken at its word — a member abroad is
 * expected to type their own country code, and guessing one for them would send
 * the code to a stranger.
 *
 * @returns the E.164 string, or null when it cannot be one.
 */
export function toE164(raw, { defaultCallingCode = "7", nationalLength = 10 } = {}) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const international = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (!international) {
    // A trunk prefix — the 8 people dial before a Kazakh number — is not part
    // of the number itself, and E.164 has no room for it.
    if (digits.length === nationalLength + 1 && digits.startsWith("8")) {
      digits = defaultCallingCode + digits.slice(1);
    } else if (digits.length === nationalLength) {
      digits = defaultCallingCode + digits;
    }
  }

  // The standard's own bounds: at least a country code and a subscriber number,
  // at most fifteen digits in total.
  if (digits.length < 8 || digits.length > 15) return null;
  return "+" + digits;
}

/** True for a string that is already exactly an E.164 number. */
export function isE164(s) {
  return typeof s === "string" && /^\+[1-9]\d{7,14}$/.test(s);
}

/**
 * A postal address is free-form across the countries we serve, so the only
 * thing worth asserting is that someone typed something a courier could act on.
 */
export function isAddress(s) {
  return typeof s === "string" && s.trim().length >= 5;
}

export function isYear(n) {
  const y = Number(n);
  return Number.isInteger(y) && y >= LIMITS.YEAR_MIN && y <= LIMITS.YEAR_MAX;
}

/**
 * True when `value` names one of the languages a book may be written in.
 *
 * Checked against the list rather than merely required to be a non-empty
 * string, which is what `genres` settles for. The difference is what the field
 * is *for*: a genre is read back as a label, so an unknown value renders as
 * itself and looks odd at worst, while a language is read back as a filter
 * predicate — one book stored as "kaz" instead of "kk" is a book that vanishes
 * from every language filter including its own, and nothing on screen says so.
 */
export function isBookLanguage(value) {
  return BOOK_LANGUAGES.some((l) => l.value === value);
}

export function isLoanDays(n) {
  const d = Number(n);
  return Number.isInteger(d) && d >= LIMITS.LOAN_DAYS_MIN && d <= LIMITS.LOAN_DAYS_MAX;
}

export function clampLoanDays(n) {
  const d = Number(n);
  if (!Number.isFinite(d)) return LIMITS.LOAN_DAYS_MIN;
  return Math.min(LIMITS.LOAN_DAYS_MAX, Math.max(LIMITS.LOAN_DAYS_MIN, Math.round(d)));
}

/**
 * Validate an image / cover URL.
 * Blocks `javascript:`, `data:` (except images), and other dangerous schemes
 * that could otherwise be smuggled into <img src> or <a href>.
 *
 * Returns the canonical URL if safe, or `""` otherwise.
 */
export function safeImageUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Allow base64 data: URIs for images only.
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(trimmed)) {
    return trimmed;
  }

  try {
    const u = new URL(trimmed);
    if (!SAFE_URL_PROTOCOLS.has(u.protocol)) return "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Validate any user-supplied external link (terms-of-use, etc.).
 * Same as safeImageUrl but doesn't allow data: URIs.
 */
export function safeHref(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Permit same-origin relative paths.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const u = new URL(trimmed);
    return SAFE_URL_PROTOCOLS.has(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Trim + cap a free-text string to a safe length. Useful for descriptions
 * and reviews where users can type arbitrary text.
 */
export function clampText(s, max) {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  if (typeof max !== "number" || max <= 0) return trimmed;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Validate the full Add-Book payload at once. Returns either
 * `{ ok: true, value }` with the normalised payload, or
 * `{ ok: false, errorKey }` pointing to an i18n key.
 */
export function validateBookPayload(form) {
  const name = clampText(form?.name, LIMITS.NAME_MAX);
  const author = clampText(form?.author, LIMITS.AUTHOR_MAX);
  const description = clampText(form?.description, LIMITS.DESCRIPTION_MAX);
  const coverUrl = safeImageUrl(form?.coverUrl);

  if (!name || !author) return { ok: false, errorKey: "addBookErrName" };
  if (!Array.isArray(form?.genres) || form.genres.length < 1) {
    return { ok: false, errorKey: "addBookErrGenre" };
  }
  if (!isPageBand(form?.pages)) {
    return { ok: false, errorKey: "addBookErrPages" };
  }
  if (form?.year && !isYear(form.year)) {
    return { ok: false, errorKey: "addBookErrYear" };
  }
  // Required, like the genre and the page band, because the shelf now filters
  // on it. An optional field that the filter treats as a hard equality is the
  // worst of both: the book is invisible under every language including its
  // own, and the person who added it has no idea why.
  if (!isBookLanguage(form?.language)) {
    return { ok: false, errorKey: "addBookErrLanguage" };
  }

  const pages = clampPages(form.pages);

  return {
    ok: true,
    value: {
      name,
      author,
      description,
      coverUrl,
      genres: form.genres.slice(0, 3),
      pages,
      // Derived, never asked for: the length of the book is the input, and the
      // loan is what follows from it. Stored alongside so every screen that
      // already reads `maxDays` — the countdown, the progress bar, the pickup —
      // keeps reading one number rather than re-deriving the rule.
      maxDays: loanDaysForPages(pages),
      year: form?.year ? Number(form.year) : "",
      language: String(form.language),
      ownerId: form?.ownerId || "",
    },
  };
}
