import { t } from "../utils/i18n.js";

/**
 * The heart on a post, with its total beside it.
 *
 * Stateless on purpose: the screen that owns the feed owns the optimistic
 * state, exactly as BookCard's save button leaves the saved set to its list.
 *
 * The total is always shown, zero included. It used to be hidden below one,
 * which read as "this post has no likes" and "this post's likes are unknown" at
 * the same time — and made the first like look like a number appearing out of
 * nowhere rather than a count going up. A post everybody can see should say
 * exactly how many likes it has to everybody who can see it.
 */
export default function LikeButton({ liked, count = 0, onClick, disabled = false, size = 24 }) {
  // The caller may hand over an optimistic total that a rollback has taken
  // under zero for a frame; a feed never shows a negative like count.
  const total = Math.max(0, Math.round(Number(count) || 0));

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); }}
      disabled={disabled}
      aria-pressed={Boolean(liked)}
      aria-label={`${t.like} (${total})`}
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
      <span className="text-[11px] font-medium tabular-nums leading-none">{total}</span>
    </button>
  );
}
