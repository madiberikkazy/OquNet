import { Link } from "react-router-dom";
import { coReadAvatarSrc } from "../utils/icons.js";
import AppIcon from "./AppIcon.jsx";
import { t } from "../utils/i18n.js";

/**
 * All-time reading, as one number against a goal, plus the way into a room.
 *
 * The card the profile used to open with reported the trailing week as a level
 * and seven bars. That is still there below; this sits above it and answers a
 * different question — not "how was your week" but "how far have you got",
 * which is the one a number counting toward five thousand can actually answer.
 * A weekly figure cannot: it resets, so it can never be *progress*.
 *
 * Minutes rather than the `HH:MM:SS` the week uses. Five thousand minutes is a
 * number a reader can hold; the same span written as 83:20:00 is a stopwatch
 * reading, and nobody sets a goal in stopwatch readings.
 *
 * The bottom half is the co-reading room: a few faces of whoever is in it, how
 * many, and the way in. It is part of this card rather than a section of its
 * own because it is the same subject seen from the other side — the number
 * above is reading alone, the row below is reading with other people.
 */
export default function ReadingProgressCard({
  readingSeconds = 0,
  goalMinutes = 5000,
  rank = null,
  readers = [],
  to = "/reading/together",
  /**
   * The room row under the bar. Off on somebody else's profile: the progress
   * above it is *theirs* and belongs there, but "read together" starts a
   * sitting for whoever taps it, and a button that acts on you sitting under a
   * stranger's name is a button in the wrong place. Their minutes read the same
   * either way, which is the half that was asked to match.
   */
  showRoom = true,
}) {
  const minutes = Math.floor(Math.max(0, Number(readingSeconds) || 0) / 60);
  const goal = Math.max(1, Math.round(goalMinutes));
  // Capped, because the bar is a bar: past the goal it is full, and a reader who
  // sails past five thousand should see a finished bar rather than an overflowing
  // one. The number above it keeps counting and says the true total.
  const progress = Math.min(1, minutes / goal);

  const faces = readers.slice(0, 3);
  const overflow = Math.max(0, readers.length - faces.length);

  return (
    <div className="card overflow-hidden">
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-ink-500">{t.coReadMinutesRead}</p>
            <p className="mt-0.5 leading-none">
              <span className="text-[30px] font-bold tabular-nums">{minutes.toLocaleString()}</span>
              <span className="text-[15px] text-ink-500 tabular-nums"> /{goal.toLocaleString()}</span>
            </p>
          </div>

          {/* Standing, when there is one. It rides in this card rather than in a
              chip of its own: a place in a community is a fact about the same
              minutes the bar is measuring. */}
          {rank?.place ? (
            <span className="inline-flex items-center gap-1 shrink-0 pt-1">
              <span className="text-[13px] font-semibold text-ink-700 tabular-nums">
                {rank.place} {t.placeShort}
              </span>
              <AppIcon name="cup" size={15} />
            </span>
          ) : null}
        </div>

        <div className="mt-2.5 h-2 rounded-full bg-ink-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-brand-500 transition-all duration-500"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* The room. A tint rather than a divider, so the two halves read as one
          card with a floor rather than as two stacked ones. */}
      {showRoom ? (
      <div className="bg-tint px-3 py-2.5 flex items-center gap-2.5">
        {faces.length > 0 ? (
          <span className="flex items-center shrink-0">
            {faces.map((r, i) => (
              <img
                key={r.id ?? r.userId ?? i}
                src={coReadAvatarSrc(r.avatar)}
                alt=""
                aria-hidden="true"
                width={26}
                height={26}
                style={{ width: 26, height: 26, marginLeft: i === 0 ? 0 : -9 }}
                className="rounded-full ring-2 ring-base bg-ink-100 object-cover select-none"
                draggable={false}
              />
            ))}
            {overflow > 0 ? (
              <span
                style={{ marginLeft: -9 }}
                className="w-[26px] h-[26px] rounded-full ring-2 ring-base bg-ink-300 text-white text-[10px] font-bold inline-flex items-center justify-center tabular-nums"
              >
                +{overflow}
              </span>
            ) : null}
          </span>
        ) : null}

        <span className="flex-1 min-w-0 text-[12px] text-ink-500 truncate">
          {readers.length > 0 ? t.coReadReadingNow : t.coReadNobody}
        </span>

        <Link
          to={to}
          className="shrink-0 rounded-full bg-brand-500 text-white text-[13px] font-semibold px-4 py-2 active:scale-95 transition"
        >
          {t.coReadTitle}
        </Link>
      </div>
      ) : null}
    </div>
  );
}
