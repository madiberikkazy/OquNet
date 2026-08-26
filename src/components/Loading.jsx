import { loadingIcon } from "../utils/icons.js";
import { t } from "../utils/i18n.js";

/**
 * What a screen shows while it has nothing to show.
 *
 * One component rather than the paragraph of grey text that each of twenty
 * screens wrote for itself: they had already drifted into four different
 * spellings of the same idea — `px-6 py-12 text-ink-500`, `mt-10 text-ink-400
 * text-[14px]`, and two more — so the app's answer to "wait a moment" depended
 * on which screen you happened to be waiting on.
 *
 * The word has not gone away, it has stopped being the *picture*. `t.loading`
 * is the accessible name on the live region, so a screen reader still says
 * "жүктелуде" and still announces it when it appears; what a sighted reader
 * gets instead is the artwork, which is a file anybody can overwrite without
 * touching code — same arrangement as every other drawable.
 *
 * The GIF is transparent and animates by *size* rather than by fading, which is
 * what makes one file work on both themes: GIF has a single transparent index
 * and no alpha channel, so a dot that dimmed toward its background would have
 * to pick a background to dim toward, and would be wrong on the other one.
 *
 * Not a replacement for the skeletons. Where a screen knows the shape of what
 * is coming — a feed of posts, a grid of book covers — a skeleton in that shape
 * is better than any spinner, and those stay as they are. This is for the
 * screens that know nothing yet.
 */
export default function Loading({ size = 96, className = "py-12" }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t.loading}
      className={"w-full flex items-center justify-center " + className}
    >
      <img
        src={loadingIcon}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: size, height: size }}
        className="select-none pointer-events-none"
      />
    </div>
  );
}
