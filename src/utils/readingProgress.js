// Reading time: how it is stored, how it is read back, and what it adds up to.
//
// ── Two representations, on purpose ──────────────────────────────────────────
// A finished timer run is written twice. Once as a document in `readingSessions`
// — the durable log, one row per sitting, which is what any later recount or
// correction has to be rebuilt from. And once, folded, into two denormalised
// fields on the reader's own user document:
//
//   readingDays    { "2026-08-08": 2700, ... }  SECONDS per local calendar day
//   readingSeconds 45231                        the sum of that map
//
// The fold is what makes the profile cheap. A week of someone else's reading is
// a single document read — the same read the screen already makes to learn
// their name — instead of a query over session rows, and a community
// leaderboard is one `listUsersByCommunity` instead of a query per member.
//
// The cost is that the fold is a client-side read-modify-write, so two devices
// finishing a session in the same second can lose one of them from the map. The
// session rows still hold both, so the map is recoverable; it is an aggregate,
// not the record. Making it exact needs a Cloud Function on `readingSessions`
// writes, which is the right home for it once this project has a backend.
//
// ── Seconds, not minutes ─────────────────────────────────────────────────────
// The profile reports the week as `11:05:56`, so seconds are the stored unit.
// Rounding each sitting to whole minutes would make that last field decorative
// and would silently drop every run shorter than thirty seconds.
//
// ── Local days, deliberately ─────────────────────────────────────────────────
// A day key is the reader's own calendar day, not UTC. Somebody reading at
// 01:00 in Astana would otherwise have it land on the previous day, which is
// exactly the kind of off-by-one a seven-bar chart makes obvious.

/** The window the profile reports on: seven days ending today. */
export const WEEK_DAYS = 7;

/**
 * How much history the day map keeps. Far more than the week the profile shows,
 * so a longer view can be added later without a migration, and bounded so the
 * map cannot grow without limit inside a document with a 1 MiB ceiling.
 */
export const READING_HISTORY_DAYS = 400;

/** A single sitting cannot sensibly exceed this; the security rules agree. */
export const MAX_SESSION_SECONDS = 36_000; // 10 hours

/** Below this a "session" is a mis-tap, not reading. */
export const MIN_SESSION_SECONDS = 30;

/**
 * What a full day looks like on the daily chart: one hour of reading is 100%.
 *
 * Fixed rather than derived from the reader's level. A goal that moved as the
 * reader improved would make yesterday's bar change height overnight, and two
 * people's charts would stop meaning the same thing — which is the one property
 * a chart shown next to a leaderboard has to keep. Seven full days at this goal
 * is 7 hours, which is `Тұрақты` on the ladder below.
 */
export const DAILY_GOAL_SECONDS = 3600;

/** The lengths the profile's timer launcher steps between, in minutes. */
export const READING_MINUTE_STEP = 5;
export const READING_MINUTES_MIN = 5;
export const READING_MINUTES_MAX = 240;
export const READING_MINUTES_DEFAULT = 30;

/**
 * The lengths a co-reading sitting may be set to, in minutes.
 *
 * A short list rather than the free stepper the solo timer uses: this choice is
 * made in a bottom bar with a thumb, one tap before joining, and a control that
 * needs several taps to travel from 5 to 60 would be a control people leave on
 * whatever it opened at. Every value sits inside the MIN/MAX bounds above, and
 * the default is one of them so the picker always opens with something chosen.
 */
export const COREAD_MINUTE_OPTIONS = Object.freeze([15, 30, 45, 60]);

/**
 * The reader ladder, by hours read in the trailing week.
 *
 * `key` is an i18n key rather than a name: the ladder is the same in every
 * language and the label is not this module's business. Ordered ascending, and
 * read from the top down — the level someone holds is the highest rung they
 * have cleared.
 */
export const READER_LEVELS = Object.freeze([
  { key: "levelBeginner", hours: 3 },
  { key: "levelCasual",   hours: 5 },
  { key: "levelSteady",   hours: 7 },
  { key: "levelActive",   hours: 10 },
  { key: "levelAdvanced", hours: 15 },
].map((l) => Object.freeze({ ...l, seconds: l.hours * 3600 })));

/**
 * Where a week's reading sits on the ladder.
 *
 * `index` is -1 for a week that has not cleared the first rung — which is a
 * real state and not an error, so it gets a shape of its own rather than a null:
 * `level` is null, `next` is the first rung, and `progress` measures from zero.
 * The top of the ladder has no `next` and sits at progress 1.
 */
export function readerLevel(weekSeconds) {
  const seconds = Math.max(0, Number(weekSeconds) || 0);

  let index = -1;
  for (let i = READER_LEVELS.length - 1; i >= 0; i -= 1) {
    if (seconds >= READER_LEVELS[i].seconds) { index = i; break; }
  }

  const level = index >= 0 ? READER_LEVELS[index] : null;
  const next = READER_LEVELS[index + 1] ?? null;
  const floor = level ? level.seconds : 0;
  const ceiling = next ? next.seconds : floor;
  const span = ceiling - floor;

  return {
    index,
    level,
    next,
    seconds,
    // At the top there is nothing left to fill toward, so the bar is full.
    progress: span > 0 ? Math.min(1, Math.max(0, (seconds - floor) / span)) : 1,
    // What the bar is filling toward — the label that belongs beside it.
    targetSeconds: next ? next.seconds : floor,
  };
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

/** Only whole positive seconds, capped — anything else is not a session. */
export function clampSessionSeconds(value) {
  const s = Math.round(Number(value) || 0);
  if (!Number.isFinite(s) || s < MIN_SESSION_SECONDS) return 0;
  return Math.min(MAX_SESSION_SECONDS, s);
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
    const seconds = Math.round(Number(value) || 0);
    if (seconds > 0) clean[key] = seconds;
  }
  return clean;
}

/**
 * `readingDays` with one day's seconds added. Pure: the caller writes the
 * result, so the same function serves the app and the seed script.
 */
export function addReadingSeconds(readingDays, key, seconds, { today = new Date() } = {}) {
  const added = clampSessionSeconds(seconds);
  const clean = sanitizeReadingDays(readingDays, { today });
  if (!added || !key) return clean;
  return { ...clean, [key]: (clean[key] || 0) + added };
}

export function totalReadingSeconds(readingDays) {
  if (!readingDays || typeof readingDays !== "object") return 0;
  return Object.values(readingDays).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * The seven days the profile reports on: today last, six days of history before
 * it, oldest first.
 *
 * A trailing window rather than a calendar week. A Monday-anchored week is one
 * bar tall every Monday morning and says nothing about how much somebody has
 * been reading — which is the question the chart is there to answer. So "this
 * week" always means the last seven days, and every day of it has happened.
 *
 * `percent` is that day against `DAILY_GOAL_SECONDS`, capped at 100: a day is
 * scored on its own, not against the reader's best day or the week's total.
 */
export function buildReadingWeek(readingDays, { today = new Date(), days = WEEK_DAYS } = {}) {
  const map = readingDays && typeof readingDays === "object" ? readingDays : {};
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);

  const cells = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    const seconds = Math.max(0, Number(map[key]) || 0);
    cells.push({
      key,
      date,
      seconds,
      percent: dayPercent(seconds),
      // Monday-first index, so a caller can pull a weekday label without
      // re-deriving `getDay()`'s Sunday-first convention.
      weekdayIndex: (date.getDay() + 6) % 7,
      isToday: i === 0,
    });
  }

  const totalSeconds = cells.reduce((sum, c) => sum + c.seconds, 0);
  return {
    days: cells,
    totalSeconds,
    startKey: cells[0]?.key ?? "",
    endKey: cells[cells.length - 1]?.key ?? "",
    // The week as a share of seven full days — the one number that summarises
    // the whole chart.
    percent: dayPercent(totalSeconds / days),
    activeDays: cells.filter((c) => c.seconds > 0).length,
  };
}

/** One day against the daily goal, 0–100. */
export function dayPercent(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  return Math.min(100, Math.round((s / DAILY_GOAL_SECONDS) * 100));
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

/** The windows the leaderboard offers, in days. `null` means the whole map. */
export const RANK_WINDOWS = Object.freeze({ week: WEEK_DAYS, month: 30, all: null });

/**
 * Reading time inside a trailing window, in seconds.
 *
 * A trailing window rather than a calendar one, for the same reason the chart
 * uses trailing days: "this month" anchored to the 1st says almost nothing on
 * the 2nd. `days: null` sums the whole map, which is as close to all-time as
 * this data goes — `sanitizeReadingDays` keeps 400 days of it.
 */
export function windowReadingSeconds(readingDays, { today = new Date(), days = WEEK_DAYS } = {}) {
  if (!days) return totalReadingSeconds(readingDays);
  const map = readingDays && typeof readingDays === "object" ? readingDays : {};
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);

  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    total += Math.max(0, Number(map[dayKey(date)]) || 0);
  }
  return total;
}

/**
 * The whole community, ordered by reading time in a window — the leaderboard.
 *
 * Computed from the member list the screen already has: every reader's day map
 * is denormalised onto their profile, so a full ranking costs the one query
 * that fetched the members and nothing more.
 *
 * Competition ranking, the same as the badge: equal totals share a place and
 * the next distinct total skips the places they consumed. Members who have not
 * read in the window still appear, last, because a leaderboard that hides them
 * hides exactly the people it exists to nudge.
 */
export function rankMembersByReading(members, { today = new Date(), days = WEEK_DAYS } = {}) {
  const rows = (members || [])
    .filter((m) => m?.id)
    .map((m) => ({ member: m, seconds: windowReadingSeconds(m.readingDays, { today, days }) }))
    .sort((a, b) => b.seconds - a.seconds || String(a.member.id).localeCompare(String(b.member.id)));

  let place = 0;
  let seen = 0;
  let previous = null;
  return rows.map((row) => {
    seen += 1;
    if (row.seconds !== previous) {
      place = seen;
      previous = row.seconds;
    }
    return { ...row, place };
  });
}

/**
 * Standing inside a community, by reading time in the trailing week.
 *
 * Scored on the same window the profile shows, so the badge and the chart
 * beside it are talking about the same thing — an all-time total would rank by
 * how long somebody has had the app installed.
 *
 * Competition ranking: equal totals share a place and the next distinct total
 * skips the places they consumed, so two people tied at the top are both first
 * and nobody is third. Members who have not read this week are still ranked —
 * last — because "unranked" and "0 seconds" are the same fact here, and hiding
 * it would only make the badge disappear for exactly the people it is meant to
 * nudge.
 */
export function rankByWeeklyReading(members, userId, { today = new Date() } = {}) {
  const rows = rankMembersByReading(members, { today, days: WEEK_DAYS });
  const mine = rows.find((r) => r.member.id === userId);
  if (!mine) return null;
  return { place: mine.place, total: rows.length, seconds: mine.seconds };
}

/** `HH:MM:SS` — the profile's "Оқылған уақыт" readout. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Whole hours and the leftover minutes — for "1 сағ 20 мин" style labels. */
export function splitDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) };
}

/** Hours, rounded for a label that has no room for minutes ("15 сағ"). */
export function roundHours(totalSeconds) {
  return Math.round((Math.max(0, Number(totalSeconds) || 0) / 3600) * 10) / 10;
}
