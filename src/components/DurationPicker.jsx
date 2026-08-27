import { useEffect, useRef, useState } from "react";
import Modal from "./Modal.jsx";
import {
  READING_MINUTES_MAX, READING_MINUTES_MIN,
} from "../utils/readingProgress.js";
import { t } from "../utils/i18n.js";

/**
 * A length of time, set the way a phone's clock app sets one.
 *
 * Two wheels — hours and minutes — rather than a row of preset chips. Presets
 * are faster for the four lengths somebody thought of in advance and useless
 * for the fifth, and "twenty-five minutes" is a perfectly ordinary thing to
 * want to read for. This asks for a number instead of offering a menu.
 *
 * ── Why the wheels are scroll containers ─────────────────────────────────────
 * The wheel is a list with CSS scroll snapping, not a drag gesture reimplemented
 * in JavaScript. That is what makes it feel native on a phone: the momentum,
 * the rubber-banding at the ends and the snap are the platform's own, tuned by
 * the platform, and a hand-rolled version of them is uncanny on every device it
 * was not tuned against. The component's whole job is to read back which row
 * ended up in the middle.
 *
 * The value is only pushed into the wheels once, when the sheet opens. After
 * that the wheels are the source of truth and the state follows them — writing
 * `scrollTop` on every state change would fight the finger mid-flick.
 */

/** Row height, in px. Everything else is derived from it. */
const ROW = 44;
/** How many rows the window is tall. Odd, so one row is centred. */
const ROWS = 5;
const WINDOW_H = ROW * ROWS;
/** Blank rows above and below, so the first and last values reach the middle. */
const PAD = (WINDOW_H - ROW) / 2;

/**
 * The top of the hours wheel. One below the ceiling's whole hours, so that no
 * pair of rows can add up past `READING_MINUTES_MAX`: with 4 available, 4 h and
 * any minutes would have to be clamped, and a wheel that shows 4:30 while the
 * value underneath says 4:00 is a wheel that lies.
 */
const HOUR_MAX = Math.floor((READING_MINUTES_MAX - 1) / 60);

export default function DurationPicker({ open, minutes, onCancel, onSave }) {
  return (
    <Modal open={open} onClose={onCancel} title={t.coReadPickDuration}>
      {/* The body is a component of its own, and the sheet's contents are
          unmounted while it is closed, so every opening mounts fresh wheels
          holding the caller's current value. Keeping the draft out here instead
          and syncing it in an effect looked equivalent and was not: the wheels
          set their scroll position as they mount, which happens before an
          effect can correct the draft, so a sheet reopened after a Cancel came
          back showing the value that was cancelled. */}
      <Sheet minutes={minutes} onCancel={onCancel} onSave={onSave} />
    </Modal>
  );
}

function Sheet({ minutes, onCancel, onSave }) {
  // The draft. Cancelling has to leave the caller's value alone, so nothing is
  // handed back until Save — the wheels move a copy.
  const [draft, setDraft] = useState(() => clamp(minutes));

  const hours = Math.floor(draft / 60);
  const mins = draft % 60;

  // Out of range only while the wheels are between two legal values — 0:00 on
  // the way to 0:30, say. The reader is told rather than blocked mid-scroll,
  // and Save is what refuses.
  const tooShort = draft < READING_MINUTES_MIN;

  function setParts(h, m) {
    setDraft(Math.min(READING_MINUTES_MAX, h * 60 + m));
  }

  return (
    <>
      <div className="relative flex items-stretch justify-center gap-2">
        {/* The band across the middle marks the row that counts. Behind the
            wheels and inert, so it cannot eat a flick aimed at either one. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-xl bg-tint"
          style={{ height: ROW }}
        />

        <Wheel
          label={t.hoursShort}
          value={hours}
          count={HOUR_MAX + 1}
          onChange={(h) => setParts(h, mins)}
        />
        <Wheel
          label={t.minutesShort}
          value={mins}
          count={60}
          onChange={(m) => setParts(hours, m)}
        />
      </div>

      {tooShort ? (
        <p className="mt-3 text-center text-[12px] text-ink-500 tabular-nums">
          {READING_MINUTES_MIN} {t.minutesShort}+
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary flex-1">
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={() => onSave?.(clamp(draft))}
          disabled={tooShort}
          className="btn-primary flex-1 disabled:opacity-50"
        >
          {t.save}
        </button>
      </div>
    </>
  );
}

/**
 * One column of numbers, snapping to the middle.
 *
 * `value` is written to `scrollTop` on mount only — see the note on the sheet.
 * Reading it back waits for the scrolling to stop: a value taken mid-flick is
 * whichever row happened to be passing. `scrollend` would say that exactly, but
 * React 18 has no synthetic event for it, so a short debounce says it instead.
 */
function Wheel({ label, value, count, onChange }) {
  const ref = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    const box = ref.current;
    if (box) box.scrollTop = value * ROW;
    // Mount only, on purpose: this is the starting position, not a binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  function settle() {
    const box = ref.current;
    if (!box) return;
    const index = Math.max(0, Math.min(count - 1, Math.round(box.scrollTop / ROW)));
    onChange(index);
    // Snapping is the platform's job and it does it for a finger, but a scroll
    // the wheel did not ask for — something on the page calling `scrollIntoView`
    // on a row, say — can leave it stopped between two rows, showing one number
    // while the value underneath is the other. Land it on the row it settled
    // nearest to. The correction is itself a scroll, and the settle it triggers
    // finds the wheel already there and stops.
    if (Math.abs(box.scrollTop - index * ROW) > 1) {
      box.scrollTo({ top: index * ROW, behavior: "smooth" });
    }
  }

  function onScroll() {
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, 90);
  }

  return (
    // `relative`, so the numbers paint above the band across the middle rather
    // than under it: a positioned element outranks its static siblings in the
    // painting order regardless of source order, and the band is positioned.
    <div className="relative flex items-center gap-1.5">
      <div
        ref={ref}
        onScroll={onScroll}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        className="no-scrollbar overflow-y-auto snap-y snap-mandatory text-center"
        style={{ height: WINDOW_H, width: 64, scrollPaddingTop: PAD }}
      >
        <div style={{ height: PAD }} />
        {Array.from({ length: count }, (_, n) => (
          <div
            key={n}
            role="option"
            aria-selected={n === value}
            className={
              "snap-center flex items-center justify-center tabular-nums transition-colors " +
              (n === value ? "text-[22px] font-bold" : "text-[19px] text-ink-500")
            }
            style={{ height: ROW }}
          >
            {n}
          </div>
        ))}
        <div style={{ height: PAD }} />
      </div>
      <span className="text-[13px] text-ink-500 shrink-0">{label}</span>
    </div>
  );
}

function clamp(value) {
  const n = Math.round(Number(value) || 0);
  return Math.min(READING_MINUTES_MAX, Math.max(READING_MINUTES_MIN, n));
}

/** How the trigger reports its value: `45 мин`, `1 сағ`, `1 сағ 30 мин`. */
export function formatMinutes(totalMinutes) {
  const n = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} ${t.minutesShort}`;
  if (!m) return `${h} ${t.hoursShort}`;
  return `${h} ${t.hoursShort} ${m} ${t.minutesShort}`;
}
