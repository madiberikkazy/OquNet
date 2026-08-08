import { useMemo } from "react";
import {
  DAILY_GOAL_SECONDS, buildReadingWeek, formatDuration, readerLevel, roundHours,
} from "../utils/readingProgress.js";
import { t, weekdayShort } from "../utils/i18n.js";

/**
 * ReadingWeek — the trailing seven days, as a level and as seven bars.
 *
 * Two readings of the same window, side by side. The left column says where the
 * reader stands and how far the next rung is; the right column says how they got
 * there. Both come from one `buildReadingWeek` call, so the bars and the total
 * can never be describing different weeks.
 *
 * Each bar is that day against a one-hour goal, capped at 100% — a day is scored
 * on its own rather than against the reader's best day, so a quiet week looks
 * like a quiet week instead of being rescaled until it looks busy.
 */
export default function ReadingWeek({ readingDays, today }) {
  const week = useMemo(() => buildReadingWeek(readingDays, { today }), [readingDays, today]);
  const level = readerLevel(week.totalSeconds);

  // Below the first rung there is no level held yet, and saying so is more
  // honest than promoting somebody to "beginner" for reading twenty minutes.
  const levelName = level.level ? t[level.level.key] : t.levelNone;

  return (
    <div className="card px-3.5 py-3.5">
      <div className="flex gap-4">
        {/* ── Standing ─────────────────────────────────────────────────────── */}
        <div className="w-[40%] min-w-0 flex flex-col">
          <p className="text-[11px] text-ink-500">{t.levelWeekLabel}</p>
          <p className="text-[13px] font-bold mt-0.5 leading-tight">{levelName}</p>

          <div className="mt-2 h-5 rounded-full bg-ink-100 overflow-hidden relative">
            <div
              className="h-full bg-brand-500 rounded-full transition-all flex items-center justify-end pr-1.5"
              // Same reason as the loan bar: a nearly-empty bar cannot carry its
              // own label, so it keeps a floor wide enough to hold one.
              style={{ width: `${Math.max(level.progress * 100, 36)}%` }}
            >
              {/* Hours read, not the target. A number riding the fill edge reads
                  as "this is where you are"; putting the goal there made a 22%
                  bar look like fifteen hours already done. */}
              <span className="text-[10px] font-semibold text-white whitespace-nowrap">
                {roundHours(week.totalSeconds)} {t.hoursShort}
              </span>
            </div>
          </div>
          {/* What the bar is filling toward. At the top of the ladder there is
              nothing above, so this says that instead of naming a rung. */}
          <p className="text-[10px] text-ink-500 mt-1 leading-tight line-clamp-2">
            {level.next
              ? `${t.nextLevelLabel} ${t[level.next.key]} · ${roundHours(level.targetSeconds)} ${t.hoursShort}`
              : t.levelTopReached}
          </p>

          <p className="text-[11px] text-ink-500 mt-2.5">{t.readTimeLabel}</p>
          <p className="text-[19px] font-bold tabular-nums leading-tight">
            {formatDuration(week.totalSeconds)}
          </p>
        </div>

        {/* ── The week ─────────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex items-end gap-1" style={{ height: 128 }}>
          {week.days.map((day) => (
            <DayBar key={day.key} day={day} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One day. The percentage is printed above the bar rather than inside it: at
 * seven bars across a phone there is no room for a legible label within the fill,
 * and a day at 4% has no fill to put one in.
 */
function DayBar({ day }) {
  return (
    <div className="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1">
      {/* 8px and tightened: seven "100%" labels across a phone touch at 9px, and
          a column of run-together numbers is worse than a small one. */}
      <span className="text-[8px] leading-none text-ink-500 tabular-nums tracking-tighter">
        {day.percent > 0 ? `${day.percent}%` : ""}
      </span>
      {/* The track is what gives the bar something to be a fraction *of*; the
          fill is positioned from the bottom so a short day grows upward. */}
      <div
        className="w-full max-w-[14px] flex-1 rounded-full bg-ink-100 relative overflow-hidden"
        title={`${day.key} · ${formatDuration(day.seconds)} / ${formatDuration(DAILY_GOAL_SECONDS)}`}
      >
        <div
          className="absolute bottom-0 left-0 right-0 rounded-full bg-brand-500 transition-all"
          // A day with no reading gets no sliver at all — an empty track already
          // says "nothing here", and a 2px stub reads as a rounding error.
          style={{ height: day.percent > 0 ? `${Math.max(day.percent, 6)}%` : 0 }}
        />
      </div>
      <span
        className={
          "text-[10px] leading-none " +
          (day.isToday ? "font-bold text-brand-600" : "text-ink-500")
        }
      >
        {weekdayShort(day.weekdayIndex)}
      </span>
    </div>
  );
}
