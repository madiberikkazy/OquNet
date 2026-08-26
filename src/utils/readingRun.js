import { safeGet, safeSet, safeRemove } from "./safeStorage.js";
import { logger } from "./logger.js";

const KEY = "oqunet:reading-run";

/**
 * The reading run that is currently going, stored outside the screen that draws
 * it.
 *
 * A run used to live entirely in ReadingTimer's own state, which meant Back
 * ended it: the seconds already read were banked on the way out — that part was
 * never lost — but the clock stopped, and coming back offered a fresh start
 * rather than the sitting still in progress. That is not what a timer is. A
 * reader who checks the book's page, answers a message, or glances at their
 * shelf mid-chapter has not stopped reading, and the app should not decide that
 * they have.
 *
 * So the run is written here and the screen becomes a view of it. Which is
 * cheap, because of how the clock already worked: elapsed time is derived from
 * `Date.now()` against the moment the stretch began, never accumulated tick by
 * tick, so a run whose screen is not mounted keeps perfectly good time on its
 * own. Nothing has to tick in the background — there is nothing to tick.
 *
 * The stored shape:
 *
 *   userId            whose run this is. A run left behind by the previous
 *                     account is not offered to the next one.
 *   minutes, bookId   what was asked for — the length, and the book the time
 *                     goes to. Held here rather than re-read from the URL,
 *                     because a resume arrives without one.
 *   runStartedAt      when the whole run began, across every pause.
 *   segmentStartedAt  where the next unwritten stretch starts.
 *   committedMs       how much of the run has already been written down.
 *   bankedMs          completed stretches before the current one.
 *   startedAt         when the current stretch began, or null while paused.
 *   finished          whether it reached its length.
 */

/** The run in progress for this reader, or null. */
export function readActiveRun(userId) {
  const raw = safeGet(KEY, null);
  if (!raw) return null;
  try {
    const run = JSON.parse(raw);
    if (!run || typeof run !== "object") return null;
    // A run with no beginning is not a run — it is a half-written record, and
    // resuming from one would start the clock from nowhere.
    if (!Number.isFinite(run.runStartedAt)) return null;
    if (userId && run.userId && run.userId !== userId) return null;
    return run;
  } catch (err) {
    logger.warn("readingRun.read", err?.message);
    return null;
  }
}

/** Start recording a run, replacing whatever was there. */
export function writeRun(run) {
  safeSet(KEY, JSON.stringify(run));
}

/**
 * Move part of the run on, leaving the rest as it is.
 *
 * A patch rather than a whole write because the screen changes these fields
 * from several places at once — a commit moves the written-down total while a
 * pause moves the clock — and each of those knows its own fields and not the
 * others'. Writing the whole object from any one of them means writing the
 * others from a closure that may be a render behind.
 *
 * A no-op when there is no run: nothing here creates one.
 */
export function mergeRun(patch) {
  const raw = safeGet(KEY, null);
  if (!raw) return;
  try {
    const run = JSON.parse(raw);
    if (!run || typeof run !== "object") return;
    safeSet(KEY, JSON.stringify({ ...run, ...patch }));
  } catch (err) {
    logger.warn("readingRun.merge", err?.message);
  }
}

/** The run is over — stopped, reset, or finished and left. */
export function clearRun() {
  safeRemove(KEY);
}
