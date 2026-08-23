import { useCallback, useId } from "react";

/**
 * A two-handled range: pick a low end and a high end on one track.
 *
 * Built from two native `<input type="range">` stacked on the same track
 * rather than from pointer events on a div. That is the whole design decision
 * and it buys three things a hand-rolled slider has to re-earn: the handles are
 * real focusable controls, so arrow keys and Home/End work and a screen reader
 * announces a value rather than a shape; the platform's own touch target and
 * momentum apply, which on a phone is the difference between a control you can
 * use with a thumb and one you fight; and there is no drag-state machine to get
 * wrong when a gesture ends off-screen.
 *
 * The cost is that two stacked inputs both want the whole track, so the one on
 * top would swallow every click. `pointer-events` is switched off on the inputs
 * and back on for their thumbs only — which is why the two `::-webkit-slider-thumb`
 * rules in index.css are load-bearing rather than decoration.
 *
 * The handles are allowed to meet but not to cross: each clamps against the
 * other, so a range is always `[low, high]` and never a pair the caller has to
 * sort. A crossed range is not a state worth representing — it is the same
 * selection said backwards, and letting it exist means every reader of the
 * value has to normalise it.
 */
export default function RangeSlider({
  min,
  max,
  step = 1,
  value,          // [low, high]
  onChange,
  /** Renders one end's value — units, a band label, whatever the caller means. */
  format = (n) => String(n),
  label,
  /** Shown instead of the numbers while the range covers everything. */
  anyLabel,
  /** How each handle names itself to a screen reader — "from" / "to". */
  fromLabel = "from",
  toLabel = "to",
}) {
  const id = useId();
  const [low, high] = value;
  const span = max - min || 1;
  const isFullRange = low <= min && high >= max;

  const setLow = useCallback(
    (n) => onChange([Math.min(Number(n), high), high]),
    [high, onChange]
  );
  const setHigh = useCallback(
    (n) => onChange([low, Math.max(Number(n), low)]),
    [low, onChange]
  );

  // Percentages of the track, for the filled segment between the handles.
  const leftPct = ((low - min) / span) * 100;
  const rightPct = ((high - min) / span) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-[13px] text-ink-500">{label}</span>
        <span className="text-[13px] font-semibold text-ink-900 tabular-nums">
          {isFullRange && anyLabel ? anyLabel : `${format(low)} — ${format(high)}`}
        </span>
      </div>

      <div className="relative h-6 flex items-center">
        {/* The track and the selected segment are plain divs under the inputs:
            the native track is styled differently by every engine, and two of
            them stacked would show through each other. */}
        <div className="absolute inset-x-0 h-1 rounded-full bg-ink-100" />
        <div
          className="absolute h-1 rounded-full bg-brand-500"
          style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
        />

        <input
          type="range"
          className="range-thumb absolute inset-x-0 w-full"
          min={min}
          max={max}
          step={step}
          value={low}
          onChange={(e) => setLow(e.target.value)}
          // Two handles on one track need two different names, or a screen
          // reader announces the same control twice and the second one is
          // unreachable in practice.
          aria-label={`${label}, ${fromLabel}`}
          aria-describedby={`${id}-low`}
        />
        <input
          type="range"
          className="range-thumb absolute inset-x-0 w-full"
          min={min}
          max={max}
          step={step}
          value={high}
          onChange={(e) => setHigh(e.target.value)}
          aria-label={`${label}, ${toLabel}`}
          aria-describedby={`${id}-high`}
        />
      </div>

      {/* Read out for assistive tech, which cannot see the number above. */}
      <span id={`${id}-low`} className="sr-only">{format(low)}</span>
      <span id={`${id}-high`} className="sr-only">{format(high)}</span>
    </div>
  );
}
