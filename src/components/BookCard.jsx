import { Link } from "react-router-dom";
import BookStatusBadge from "./BookStatusBadge.jsx";
import SaveButton from "./SaveButton.jsx";
import { genreLabel } from "../utils/i18n.js";
import { ratingSummary, formatRating } from "../utils/rating.js";

export const FALLBACK_COVER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 90'><rect width='60' height='90' fill='#dde5ee'/><text x='50%' y='52%' text-anchor='middle' fill='#5b6573' font-family='Inter' font-size='9'>OquNet</text></svg>`
  );

/**
 * Row layout, top to bottom on the right of the cover:
 *   title  ............................  save button
 *   author
 *   status badge + genres  ...........  ★ rating (count)
 *
 * The last row is a single baseline: badges grow from the left, the rating
 * stays pinned right and never wraps.
 */
export default function BookCard({ book, onSaveToggle, saved, showRating = true }) {
  const status = book.status || "available";
  const rating = ratingSummary(book);

  return (
    <Link
      to={`/books/${book.id}`}
      className="flex gap-3 px-4 py-3 border-b border-ink-100 last:border-b-0 active:bg-ink-100/40 transition"
    >
      <img
        src={book.coverUrl || FALLBACK_COVER}
        alt={book.name}
        className="w-[68px] h-[88px] rounded-md object-cover bg-ink-100 shrink-0"
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-[15px] text-ink-900 truncate">{book.name}</h3>
          <SaveButton
            saved={Boolean(saved)}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSaveToggle?.(book); }}
          />
        </div>
        <p className="text-[13px] text-ink-500 truncate">{book.author}</p>

        <div className="mt-auto pt-1.5 flex items-end justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <BookStatusBadge status={status} daysLeft={book.daysLeft} />
            {book.genre ? (
              <span className="px-2 py-0.5 rounded-full bg-ink-100 text-ink-500 text-[11px] font-medium">
                {genreLabel(book.genre)}
              </span>
            ) : null}
          </div>

          {showRating ? (
            <div className="flex items-center gap-1 shrink-0 text-[13px] text-ink-700">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#F5B100">
                <path d="M12 2.5l2.9 6 6.6.9-4.8 4.5 1.2 6.6L12 17.4 6.1 20.5l1.2-6.6L2.5 9.4l6.6-.9L12 2.5z" />
              </svg>
              <span className="font-medium">{formatRating(rating.average)}</span>
              <span className="text-ink-400">({rating.count})</span>
            </div>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
