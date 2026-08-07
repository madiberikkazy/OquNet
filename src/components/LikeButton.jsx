import { t } from "../utils/i18n.js";

/**
 * The heart on a post, with its total beside it.
 *
 * Stateless on purpose: the screen that owns the feed owns the optimistic
 * state, exactly as BookCard's save button leaves the saved set to its list.
 */
export default function LikeButton({ liked, count = 0, onClick, disabled = false, size = 24 }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); }}
      disabled={disabled}
      aria-pressed={Boolean(liked)}
      aria-label={t.like}
      className={
        "inline-flex flex-col items-center gap-0.5 text-brand-500 transition active:scale-90 " +
        (disabled ? "opacity-60" : "")
      }
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={liked ? "currentColor" : "none"}
      >
        <path
          d="M12 20.5s-7.5-4.7-7.5-10.4a4.3 4.3 0 0 1 7.5-2.85 4.3 4.3 0 0 1 7.5 2.85c0 5.7-7.5 10.4-7.5 10.4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {count > 0 ? (
        <span className="text-[11px] font-medium tabular-nums leading-none">{count}</span>
      ) : null}
    </button>
  );
}
