import { t } from "../utils/i18n.js";

/**
 * The heart on a post, with its total beside it.
 *
 * Stateless on purpose: the screen that owns the feed owns the optimistic
 * state, exactly as BookCard's save button leaves the saved set to its list.
 */
export default function LikeButton({ liked, count = 0, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); }}
      disabled={disabled}
      aria-pressed={Boolean(liked)}
      aria-label={t.like}
      className={
        "inline-flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-lg transition active:scale-95 " +
        (liked ? "text-bad" : "text-ink-500") +
        (disabled ? " opacity-60" : "")
      }
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"}>
        <path
          d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
      {count > 0 ? <span className="text-[13px] font-medium tabular-nums">{count}</span> : null}
    </button>
  );
}
