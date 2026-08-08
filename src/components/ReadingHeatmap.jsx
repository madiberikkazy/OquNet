import { useMemo } from "react";
import { buildHeatmap, HEATMAP_WEEKS, splitMinutes, totalReadingMinutes } from "../utils/readingProgress.js";
import { monthShort, t, weekdaysNarrow } from "../utils/i18n.js";

/**
 * ReadingHeatmap — a contribution grid of minutes read per day.
 *
 * Columns are weeks and rows are weekdays, Monday at the top, with the current
 * week last. The whole grid is one CSS grid rather than seven rows of squares,
 * so the column track is shared with the month labels above it and a label can
 * never drift away from the week it names.
 *
 * Sizing is fractional (`minmax(0, 1fr)`), not fixed: eighteen 12-pixel squares
 * do not fit a 320-pixel phone, and a grid that overflows its card is worse than
 * one whose squares are a pixel smaller than they were drawn.
 */
export default function ReadingHeatmap({ readingDays, weeks = HEATMAP_WEEKS, today }) {
  const { columns, monthMarkers } = useMemo(
    () => buildHeatmap(readingDays, { weeks, today }),
    [readingDays, weeks, today]
  );

  const weekdayLabels = weekdaysNarrow();

  const monthLabels = useMemo(() => (
    // A month is labelled only when it owns at least two columns: a label over
    // a single week sits half outside the grid and reads as belonging to the
    // month beside it.
    monthMarkers
      .filter((marker, i) => {
        const next = monthMarkers[i + 1];
        return (next ? next.column : columns.length) - marker.column >= 2;
      })
      .map((marker) => ({ column: marker.column, label: monthShort(marker.date.getMonth()) }))
  ), [monthMarkers, columns.length]);

  const total = totalReadingMinutes(readingDays);
  const { hours, minutes } = splitMinutes(total);

  const gridColumns = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` };

  return (
    <div className="card px-3 py-3">
      {/* Month axis. Same column track as the grid below, so a label lands
          exactly over the week its month starts in. */}
      <div className="flex gap-1.5">
        <div className="w-4 shrink-0" aria-hidden="true" />
        <div className="grid flex-1 text-[10px] leading-none text-ink-500" style={gridColumns}>
          {monthLabels.map((m) => (
            // Deliberately allowed to overflow its column: a month name is
            // wider than the one week it is anchored to, and clipping it to
            // that width leaves an axis of ellipses.
            <span key={m.column} className="whitespace-nowrap" style={{ gridColumnStart: m.column + 1 }}>
              {m.label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex gap-1.5 mt-1.5">
        {/* Weekday axis. Every other initial, as in the design — seven stacked
            letters beside 10-pixel squares is illegible at this size. */}
        <div
          className="grid w-4 shrink-0 gap-[3px] text-[9px] leading-none text-ink-500"
          style={{ gridTemplateRows: "repeat(7, minmax(0, 1fr))" }}
          aria-hidden="true"
        >
          {weekdayLabels.map((label, row) => (
            <span key={row} className="flex items-center justify-end">
              {row % 2 === 0 ? label : ""}
            </span>
          ))}
        </div>

        <div
          className="grid flex-1 gap-[3px]"
          style={{ ...gridColumns, gridTemplateRows: "repeat(7, minmax(0, 1fr))", gridAutoFlow: "column" }}
          role="img"
          aria-label={`${t.readingHeatmapTitle}: ${t.readingTotalLabel} ${formatTotal(hours, minutes)}`}
        >
          {columns.map((column) =>
            column.cells.map((cell) => (
              <div
                key={cell.key}
                // A future day is a hole in the grid, not an empty day — drawing
                // it would claim the reader failed to read tomorrow.
                className={
                  "aspect-square rounded-[2px] " +
                  (cell.future ? "opacity-0" : HEAT_CLASS[cell.level]) +
                  (cell.isToday ? " ring-1 ring-brand-500 ring-offset-0" : "")
                }
                title={cell.future ? undefined : `${cell.key} · ${cell.minutes} ${t.minutesShort}`}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2.5">
        <p className="text-[12px] font-medium text-ink-700 truncate">
          {t.readingHeatmapTitle}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-ink-500">{t.heatmapLess}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={"w-2.5 h-2.5 rounded-[2px] " + HEAT_CLASS[level]} />
          ))}
          <span className="text-[10px] text-ink-500">{t.heatmapMore}</span>
        </div>
      </div>
    </div>
  );
}

// Written out rather than interpolated: Tailwind scans source text for class
// names, and `bg-heat-${level}` is a class it would never see and never emit.
const HEAT_CLASS = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4"];

function formatTotal(hours, minutes) {
  return hours ? `${hours} ${t.hoursShort} ${minutes} ${t.minutesShort}` : `${minutes} ${t.minutesShort}`;
}
