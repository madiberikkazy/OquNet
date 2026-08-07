// One way to read a timestamp, for the whole app.

/**
 * Milliseconds since the epoch, from whatever shape a timestamp arrived in.
 *
 * The same field is a Firestore `Timestamp` when read from the server, a plain
 * number in the localStorage fallback, and — after a round trip through the
 * IndexedDB query cache, which structured-clones the class away — a bare
 * `{ seconds, nanoseconds }`. One helper handles all of them so no caller has
 * to know which mode it is in. This used to be six inline copies of
 * `x?.createdAt?.toMillis?.() ?? x?.createdAt ?? 0`, none of which agreed on
 * what a missing value meant.
 *
 * @param fallback what to return when there is no usable value. Sorting wants
 *   `0`; code that has to tell "not set yet" apart from "the epoch" — an
 *   unresolved `serverTimestamp()`, say — passes `null` and checks for it.
 */
/**
 * The date on a post — day, month, year, and deliberately no clock.
 *
 * A noticeboard entry is read days after it was written, where "23:53" says
 * nothing a reader needs and only makes two posts from the same afternoon look
 * like they belong to different moments. The locale follows the interface
 * language rather than the device, so the date reads the same way as the text
 * around it.
 *
 * Returns "" for a timestamp that has not resolved yet — a post written on this
 * device before its `serverTimestamp()` lands — so a caller can leave the line
 * out rather than print the epoch.
 */
export function formatPostDate(value, lang = "kz") {
  const ms = toMillis(value, null);
  if (!ms) return "";
  const locale = lang === "ru" ? "ru-RU" : lang === "en" ? "en-GB" : "kk-KZ";
  try {
    return new Date(ms).toLocaleDateString(locale, {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

export function toMillis(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  }
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}
