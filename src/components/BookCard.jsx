import { useState } from "react";
import { Link } from "react-router-dom";
import BookStatusBadge from "./BookStatusBadge.jsx";
import SaveButton from "./SaveButton.jsx";
import { genreLabel } from "../utils/i18n.js";
import { ratingSummary, formatRating } from "../utils/rating.js";
import { useBookPrefetch } from "../utils/prefetch.js";

// `width`/`height` are not decoration: an SVG with only a viewBox has no
// intrinsic size, and an <img> sized by `max-width`/`max-height` alone then has
// nothing to scale *from* and collapses to nothing. Every box this is dropped
// into is a different shape, so it keeps the aspect ratio and lets CSS fit it.
export const FALLBACK_COVER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='90' viewBox='0 0 60 90'><rect width='60' height='90' fill='#dde5ee'/><text x='50%' y='52%' text-anchor='middle' fill='#5b6573' font-family='Inter' font-size='9'>OquNet</text></svg>`
  );

/**
 * The rendered height of one row, in pixels, border included.
 *
 * Exported because the shelf virtualises itself once it gets long (see
 * Books.jsx) and a virtualiser has to know the row height before it renders
 * the row. Two copies of this number would drift the first time the padding
 * changes, and the symptom of a drifted one is a list that scrolls to the
 * wrong place — so there is one copy, here, next to the classes that produce
 * it: `py-3` (12 + 12) around an 88px cover, plus the 1px bottom border.
 *
 * The Link below is given this height explicitly rather than being left to
 * size itself, and the badge row below it is `flex-nowrap`. Both are needed,
 * and the second is the one that is easy to miss: measured at four viewport
 * widths, the badge row used to wrap onto a second line at 320px and 360px —
 * both extremely common phone widths — which made the row 139px there and
 * 113px on anything wider. In a plain list that is invisible. In a virtualised
 * one it is a list that scrolls to the wrong place, and with a forced height
 * it would be a clipped badge. Not wrapping fixes it at the source: the genre
 * pill truncates instead, and the row is 113px at every width.
 */
export const BOOK_ROW_HEIGHT = 113;

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
  // Same reason as the rail: a dead URL should fall back to the placeholder
  // rather than leaving the browser's broken-image glyph in the row.
  const [broken, setBroken] = useState(false);

  // A finger landing on the row is the earliest honest signal that this book
  // is the one being opened, and the gap between touchstart and the tap that
  // follows is most of a Firestore round trip. Nothing is rendered from this —
  // it only fills the cache entry the detail screen is about to read, and the
  // detail screen behaves identically if it never fired.
  const prefetchProps = useBookPrefetch()(book.id);

  return (
    <Link
      to={`/books/${book.id}`}
      {...prefetchProps}
      style={{ height: BOOK_ROW_HEIGHT }}
      className="flex gap-3 px-4 py-3 border-b border-ink-100 last:border-b-0 active:bg-ink-100/40 transition box-border overflow-hidden"
    >
      <img
        src={(!broken && book.coverUrl) || FALLBACK_COVER}
        alt={book.name}
        onError={() => setBroken(true)}
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
          {/* `flex-nowrap`, and the status badge does not shrink: it is the
              fact about this copy that the row exists to state, so when there
              is not enough width for both it is the genre that gives way. See
              BOOK_ROW_HEIGHT above for why wrapping is not an option here. */}
          <div className="flex items-center gap-2 flex-nowrap min-w-0">
            <span className="shrink-0">
              <BookStatusBadge status={status} daysLeft={book.daysLeft} />
            </span>
            {book.genre ? (
              <span className="px-2 py-0.5 rounded-full bg-ink-100 text-ink-500 text-[11px] font-medium truncate">
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
