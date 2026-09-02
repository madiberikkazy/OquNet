import { useState } from "react";
import { genderGifSrc } from "../utils/icons.js";

/**
 * The figure for one answer to the gender question — the meet-up picker's
 * cards, and the rows of the settings screen that changes it.
 *
 * The artwork is a GIF under public/drawable, on the same arrangement as every
 * other drawable in this app: `male.gif` and `female.gif`, and re-skinning both
 * screens is overwriting two files with no code change anywhere.
 *
 * The fallback is the interesting part. Those files are artwork, and artwork can
 * be missing — so this draws the symbol itself rather than a broken-image icon,
 * and the two fall back to *different* symbols. A single generic silhouette
 * would leave the picker as two identical cards distinguishable only by a word
 * underneath, which is exactly the failure the illustrations are there to
 * prevent.
 */
export default function GenderFigure({ value, size = 92, className = "" }) {
  const [broken, setBroken] = useState(false);
  const src = genderGifSrc(value);

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
        draggable={false}
        className={"shrink-0 select-none object-contain " + className}
      />
    );
  }

  // Mars and Venus, drawn on the same 24-unit grid and with the same stroke, so
  // the two cards weigh the same whichever one is being looked at.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={"shrink-0 text-ink-300 " + className}
    >
      {value === "female" ? (
        <>
          <circle cx="12" cy="9" r="5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M12 14v7M9 18h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="10" cy="14" r="5" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M14 10 20.5 3.5M15.5 3.5h5v5"
            stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
