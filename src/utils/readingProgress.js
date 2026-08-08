// Reading time: how it is stored, how it is read back, and how it becomes a grid.
//
// ── Two representations, on purpose ──────────────────────────────────────────
// A finished timer run is written twice. Once as a document in `readingSessions`
// — the durable log, one row per sitting, which is what any later recount or
// correction has to be rebuilt from. And once, folded, into two denormalised
// fields on the reader's own user document:
//
//   readingDays    { "2026-08-08": 45, ... }  minutes per LOCAL calendar day
//   readingMinutes 1234                       the sum of that map
//
// The fold is what makes the profile cheap. A heatmap of someone else's year is
// a single document read — the same read the screen already makes to learn
// their name — instead of a query over hundreds of session rows, and a
// community leaderboard is one `listUsersByCommunity` instead of a query per
// member. Neither of those would fit in a client-only app without it.
//
// The cost is that the fold is a client-side read-modify-write, so two devices
// finishing a session in the same second can lose one of them from the map. The
// session rows still hold both, so the map is recoverable; it is an aggregate,
// not the record. Making it exact needs a Cloud Function on `readingSessions`
// writes, which is the right home for it once this project has a backend.
//
// ── Local days, deliberately ─────────────────────────────────────────────────
// A day key is the reader's own calendar day, not UTC. Somebody reading at
// 01:00 in Astana would otherwise have it land on the previous square, which is
// exactly the kind of off-by-one a contribution grid makes obvious.

/** Weeks the profile heatmap shows — roughly four months, as in the design. */
export const HEATMAP_WEEKS = 18;

/**
 * How much history the day map keeps. Comfortably more than the grid shows, so
 * widening the grid later does not need a migration, and bounded so the map
 * cannot grow without limit inside a document that has a 1 MiB ceiling.
 */
export const READING_HISTORY_DAYS = 400;

/** A single sitting cannot sensibly exceed this; the security rules agree. */
export const MAX_SESSION_MINUTES = 600;

/** The lengths the profile's timer launcher steps between. */
export const READING_MINUTE_STEP = 5;
export const READING_MINUTES_MIN = 5;
export const READING_MINUTES_MAX = 240;
export const READING_MINUTES_DEFAULT = 30;

/**
 * Shade thresholds, in minutes, for the four filled levels.
 *
 * Fixed rather than relative to the reader's own maximum. A relative scale
 * would repaint the whole grid the moment somebody has one long Sunday, and
 * would make two people's grids mean different things — which is the one thing
 * a grid put side by side with a leaderboard must not do.
 */
const LEVEL_THRESHOLDS = [15, 30, 60, 120];

/** 0 for an empty day, else 1–4. */
export function readingLevel(minutes) {
  const m = Number(minutes) || 0;
  if (m <= 0) return 0;
  let level = 1;
  for (const threshold of LEVEL_THRESHOLDS) {
    if (m >= threshold) level += 1;
  }
  return Math.min(4, level);
}

/** `YYYY-MM-DD` in the reader's own timezone. */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Date a `YYYY-MM-DD` key names, at local midnight. */
export function dayKeyToDate(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Only whole positive minutes, capped — anything else is not a session. */
export function clampSessionMinutes(value) {
  const m = Math.round(Number(value) || 0);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.min(MAX_SESSION_MINUTES, m);
}

/** A `readingDays` map with only well-formed, positive, in-window entries. */
export function sanitizeReadingDays(readingDays, { today = new Date(), days = READING_HISTORY_DAYS } = {}) {
  if (!readingDays || typeof readingDays !== "object" || Array.isArray(readingDays)) return {};
  const floor = new Date(today);
  floor.setHours(0, 0, 0, 0);
  floor.setDate(floor.getDate() - (days - 1));
  const floorKey = dayKey(floor);

  const clean = {};
  for (const [key, value] of Object.entries(readingDays)) {
    // String comparison is date comparison for `YYYY-MM-DD`, which is the whole
    // reason the key is written zero-padded.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < floorKey) continue;
    const minutes = Math.round(Number(value) || 0);
    if (minutes > 0) clean[key] = minutes;
  }
  return clean;
}

/**
 * `readingDays` with one day's minutes added. Pure: the caller writes the
 * result, so the same function serves the app and the seed script.
 */
export function addReadingMinutes(readingDays, key, minutes, { today = new Date() } = {}) {
  const added = clampSessionMinutes(minutes);
  const clean = sanitizeReadingDays(readingDays, { today });
  if (!added || !key) return clean;
  return { ...clean, [key]: (clean[key] || 0) + added };
}

export function totalReadingMinutes(readingDays) {
  if (!readingDays || typeof readingDays !== "object") return 0;
  return Object.values(readingDays).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Consecutive days ending today (or yesterday, if today has not started yet —
 * a streak should not look broken at 09:00 for someone who reads at night).
 */
export function readingStreak(readingDays, { today = new Date() } = {}) {
  if (!readingDays) return 0;
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);
  if (!readingDays[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (readingDays[dayKey(cursor)] > 0) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * The grid the heatmap draws: one column per week, Monday at the top.
 *
 * Columns end on the week containing `today`, so the newest square is always in
 * the last column — the reader's most recent day sits where their eye lands.
 * Days after today are still emitted, flagged `future`, because dropping them
 * would leave a ragged last column that reads as missing data rather than as a
 * week that has not happened yet.
 *
 * `monthMarkers` names the column each month starts in, so the caller can label
 * the axis without re-deriving the calendar. Formatting the month is left to
 * the caller: this module has no opinion about language.
 */
export function buildHeatmap(readingDays, { weeks = HEATMAP_WEEKS, today = new Date() } = {}) {
  const days = readingDays && typeof readingDays === "object" ? readingDays : {};

  // Monday of the current week. getDay() is 0 for Sunday, so Sunday is 6 days
  // into its week rather than the start of the next one.
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  const mondayOffset = (end.getDay() + 6) % 7;
  const lastMonday = new Date(end);
  lastMonday.setDate(lastMonday.getDate() - mondayOffset);

  const firstMonday = new Date(lastMonday);
  firstMonday.setDate(firstMonday.getDate() - (weeks - 1) * 7);

  const todayKey = dayKey(today);
  const columns = [];
  const monthMarkers = [];
  let lastMonth = null;

  for (let w = 0; w < weeks; w += 1) {
    const cells = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(firstMonday);
      date.setDate(date.getDate() + w * 7 + d);
      const key = dayKey(date);
      const minutes = Number(days[key]) || 0;
      cells.push({
        key,
        date,
        minutes,
        level: readingLevel(minutes),
        future: key > todayKey,
        isToday: key === todayKey,
      });
    }
    columns.push({ key: cells[0].key, cells });

    // A column belongs to the month its Monday falls in — the same convention
    // the labels above the grid have to use for them to line up.
    const month = cells[0].date.getMonth();
    if (month !== lastMonth) {
      monthMarkers.push({ column: w, date: cells[0].date });
      lastMonth = month;
    }
  }

  return { columns, monthMarkers, weeks };
}

/**
 * Standing inside a community, by total reading time.
 *
 * Competition ranking: equal totals share a place and the next distinct total
 * skips the places they consumed, so two people tied at the top are both first
 * and nobody is third. Members who have never run the timer are still ranked —
 * last — because "unranked" and "0 minutes" are the same fact here, and hiding
 * it would only make the badge disappear for exactly the people it is meant to
 * nudge.
 */
export function rankByReadingMinutes(members, userId) {
  const rows = (members || [])
    .map((m) => ({ id: m?.id, minutes: Number(m?.readingMinutes) || 0 }))
    .filter((m) => m.id)
    .sort((a, b) => b.minutes - a.minutes || String(a.id).localeCompare(String(b.id)));

  if (!rows.length) return null;

  let place = 0;
  let seen = 0;
  let previous = null;
  for (const row of rows) {
    seen += 1;
    if (row.minutes !== previous) {
      place = seen;
      previous = row.minutes;
    }
    if (row.id === userId) {
      return { place, total: rows.length, minutes: row.minutes };
    }
  }
  return null;
}

/** `1 сағ 20 мин` style parts — the caller supplies the words. */
export function splitMinutes(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return { hours: Math.floor(m / 60), minutes: m % 60 };
}
