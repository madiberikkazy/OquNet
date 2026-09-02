import { t } from "../utils/i18n.js";

/**
 * The bookmark — the one control that appears at three sizes.
 *
 * A card in a grid carries the small one; the book's own page carries it in the
 * sticky bar at the top, where it is the page's second action and has to weigh
 * the same as the back arrow beside it. Hence `className`: the shape is the
 * caller's, the glyph and the two states are this component's.
 */
export default function SaveButton({
  saved,
  onClick,
  size = 22,
  className = "w-8 h-8 rounded-lg",
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Localised, like every other label in the app. It used to say "Save" and
      // "Unsave" in English on a Kazakh screen — invisible to everyone except
      // the readers who have only this to go on.
      aria-label={saved ? t.unsaveBook : t.saveBtn}
      aria-pressed={!!saved}
      className={
        "inline-flex items-center justify-center transition active:scale-95 " +
        className + " " +
        (saved ? "bg-ink-100 text-ink-900" : "text-ink-500 hover:bg-ink-100")
      }
    >
      <svg width={size - 4} height={size - 4} viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"}>
        <path
          d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5v16.25a.5.5 0 0 1-.8.4L12 17l-5.2 4.15a.5.5 0 0 1-.8-.4V4.5Z"
          stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
