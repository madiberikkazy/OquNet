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
 * The date on a post — `27.05.25`, and deliberately no clock.
 *
 * A noticeboard entry is read days after it was written, where "23:53" says
 * nothing a reader needs and only makes two posts from the same afternoon look
 * like they belong to different moments. Numeric and fixed-width rather than
 * localised month names, because it sits in the corner of every row and a
 * three-letter month in one language and a six-letter one in another would
 * shift the column about.
 *
 * Returns "" for a timestamp that has not resolved yet — a post written on this
 * device before its `serverTimestamp()` lands — so a caller can leave the line
 * out rather than print the epoch.
 */
export function formatPostDate(value) {
  const ms = toMillis(value, null);
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`;
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
