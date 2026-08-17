import { useState } from "react";
import { Link } from "react-router-dom";
import { FALLBACK_COVER } from "./BookCard.jsx";
import { formatRating, ratingSummary } from "../utils/rating.js";
import { toMillis } from "../utils/time.js";
import { t } from "../utils/i18n.js";

const DAY = 86_400_000;
const DEFAULT_LOAN_DAYS = 14;

/**
 * How far through the loan the reader is: elapsed days over the days they were
 * given. Clamped to 0–100 — a loan kept past its return date is at 100%, not at
 * 130%, because the bar is a bar and cannot mean more than full.
 *
 * This is the borrowing period, not pages: nothing in the data model knows how
 * far into a book somebody has actually read, and inventing a number for it
 * would be worse than reporting a real one about the loan. `maxDays` is the
 * allowance the admin set on the book; a book without one falls back to the
 * two weeks the rest of the app treats as normal.
 */
export function loanProgress(borrowing, book) {
  const startedAt = toMillis(borrowing?.createdAt, 0);
  if (!startedAt) return null;

  const days = Number(book?.maxDays) > 0 ? Number(book.maxDays) : DEFAULT_LOAN_DAYS;
  const elapsed = Date.now() - startedAt;
  const percent = Math.min(100, Math.max(0, Math.round((elapsed / (days * DAY)) * 100)));
  const daysLeft = Math.max(0, Math.ceil((startedAt + days * DAY - Date.now()) / DAY));
  return { percent, daysLeft, days };
}

/**
 * The book on the reader's desk right now — cover, title, score, and how much of
 * the loan is used up.
 *
 * The whole card is one link. A reader who taps anywhere on the thing they are
 * reading means "open it", and the cover being the only hit target was the
 * mistake the old two-column layout made.
 */
export default function CurrentBookCard({
  borrowing,
  book,
  emptyAction,
  // The empty state is the one part of this card that cannot be shared as-is
  // between a reader's own profile and somebody else's: "open the library and
  // borrow a book" is an instruction, and on a member profile it is addressed
  // to a person who is not the one reading it. The card itself is identical.
  emptyTitle = t.noReadingBook,
  emptyHint = t.openLibraryHint,
}) {
  const [broken, setBroken] = useState(false);

  if (!borrowing) {
    return (
      <div className="card px-4 py-5 text-center">
        <p className="text-[14px] font-medium">{emptyTitle}</p>
        {emptyHint ? <p className="text-[13px] text-ink-500 mt-1">{emptyHint}</p> : null}
        {emptyAction}
      </div>
    );
  }

  const rating = ratingSummary(book);
  const progress = loanProgress(borrowing, book);
  const cover = (!broken && book?.coverUrl) || FALLBACK_COVER;

  return (
    <Link
      to={`/books/${borrowing.bookId}`}
      className="flex gap-3 items-stretch active:scale-[0.99] transition"
    >
      <img
        src={cover}
        alt=""
        onError={() => setBroken(true)}
        className="w-[76px] h-[110px] rounded-xl object-cover bg-ink-100 shrink-0 shadow-soft"
      />

      <div className="flex-1 min-w-0 rounded-2xl bg-tint px-3 py-2.5 flex flex-col">
        <p className="text-[13px] font-bold text-tintInk text-center">{t.readingNow}</p>

        <p className="text-[15px] font-medium mt-1.5 truncate">
          {borrowing.bookName || book?.name || t.book}
        </p>
        {book?.author ? (
          <p className="text-[11px] text-ink-500 truncate">{book.author}</p>
        ) : null}

        <div className="flex items-center justify-end gap-1 mt-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#F59E0B">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          <span className="text-[13px] font-medium">{formatRating(rating.average)}</span>
          <span className="text-[11px] text-ink-500">({rating.count})</span>
        </div>

        {progress ? (
          <div
            className="mt-auto h-8 rounded-full bg-ink-100 overflow-hidden relative"
            title={`${t.remainingDays}: ${progress.daysLeft}`}
          >
            <div
              className="h-full bg-brand-500 rounded-full transition-all flex items-center justify-end pr-2.5"
              // A sliver of a bar cannot hold its own label, so below a tenth
              // the percentage moves outside it rather than being clipped.
              style={{ width: `${Math.max(progress.percent, 8)}%` }}
            >
              <span className="text-[12px] font-semibold text-white">{progress.percent}%</span>
            </div>
          </div>
        ) : null}
      </div>
    </Link>
  );
}
