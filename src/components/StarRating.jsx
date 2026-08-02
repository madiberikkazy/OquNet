// One star row for the whole app. Read-only by default (supports half-lit
// stars so a 4.4 average actually looks like 4.4); pass `onChange` to turn it
// into a picker with hover preview and keyboard support.

import { useId, useState } from "react";
import { RATING_MAX } from "../utils/rating.js";

const STAR_PATH =
  "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z";

function Star({ size, fillRatio, gradientId }) {
  const clipped = fillRatio > 0 && fillRatio < 1;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {clipped && (
        <defs>
          <linearGradient id={gradientId}>
            <stop offset={`${fillRatio * 100}%`} stopColor="#F5B100" />
            <stop offset={`${fillRatio * 100}%`} stopColor="transparent" />
          </linearGradient>
        </defs>
      )}
      <path
        d={STAR_PATH}
        fill={fillRatio >= 1 ? "#F5B100" : clipped ? `url(#${gradientId})` : "none"}
        stroke={fillRatio > 0 ? "#F5B100" : "currentColor"}
        strokeWidth="1.6"
        strokeLinejoin="round"
        className={fillRatio > 0 ? "" : "text-ink-300"}
      />
    </svg>
  );
}

export default function StarRating({ value = 0, onChange, size = 20, label }) {
  const [hovered, setHovered] = useState(0);
  const gradientPrefix = useId();
  const interactive = typeof onChange === "function";
  const shown = interactive && hovered ? hovered : value;

  const stars = Array.from({ length: RATING_MAX }, (_, i) => {
    const index = i + 1;
    return { index, fillRatio: Math.max(0, Math.min(1, shown - i)) };
  });

  if (!interactive) {
    return (
      <span
        className="inline-flex items-center gap-0.5"
        role="img"
        aria-label={label ?? `${value} / ${RATING_MAX}`}
      >
        {stars.map((s) => (
          <Star key={s.index} size={size} fillRatio={s.fillRatio} gradientId={`${gradientPrefix}-${s.index}`} />
        ))}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1" role="radiogroup" aria-label={label}>
      {stars.map((s) => (
        <button
          key={s.index}
          type="button"
          role="radio"
          aria-checked={value === s.index}
          aria-label={`${s.index}`}
          onClick={() => onChange(s.index)}
          onMouseEnter={() => setHovered(s.index)}
          onMouseLeave={() => setHovered(0)}
          onFocus={() => setHovered(s.index)}
          onBlur={() => setHovered(0)}
          className="transition active:scale-90 p-0.5"
        >
          <Star size={size} fillRatio={s.fillRatio} gradientId={`${gradientPrefix}-${s.index}`} />
        </button>
      ))}
    </div>
  );
}
