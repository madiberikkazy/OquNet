import { useState } from "react";
import { Link } from "react-router-dom";
import { FALLBACK_COVER } from "./BookCard.jsx";
import { t } from "../utils/i18n.js";

/**
 * The "new books" rail above the main list.
 *
 * Covers come in every aspect ratio, so a card can't just crop to fit without
 * slicing the artwork. Instead the same image is drawn twice: blurred and
 * cropped as a backdrop, then whole and sharp on top of it. Every card ends up
 * the same size with the cover intact and a colour field that belongs to it.
 *
 * These books are also in the list below — the rail is a shortcut, not a
 * separate shelf.
 */
export default function NewBooksRail({ books }) {
  if (!books?.length) return null;

  return (
    <section className="pt-1 pb-3">
      <h2 className="px-4 pb-2 text-[19px] font-bold text-ink-900">{t.newBooks}</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 snap-x snap-mandatory">
        {books.map((b) => (
          <NewBookCard key={b.id} book={b} />
        ))}
      </div>
    </section>
  );
}

function NewBookCard({ book }) {
  // A stored URL can be dead — the host went away, the file was removed, the
  // link was mistyped. Without this the card is a blank grey rectangle and the
  // book looks broken rather than simply unillustrated.
  const [broken, setBroken] = useState(false);
  const cover = (!broken && book.coverUrl) || FALLBACK_COVER;

  return (
    <Link to={`/books/${book.id}`} className="shrink-0 w-[136px] snap-start active:opacity-80 transition">
      <div className="relative w-full h-[186px] rounded-2xl overflow-hidden bg-ink-100">
        <img
          src={cover}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover scale-125 blur-xl"
        />
        <div className="absolute inset-0 flex items-center justify-center p-3">
          {/* `w-full h-full` + object-contain, NOT max-w/max-h: the max-*
              variants only ever shrink an image, so anything smaller than the
              card — or an SVG with no intrinsic size — drew at its own tiny
              size or vanished entirely. Contain still keeps the aspect ratio. */}
          <img
            src={cover}
            alt={book.name}
            onError={() => setBroken(true)}
            className="w-full h-full object-contain rounded-md shadow-soft"
          />
        </div>
      </div>
      <p className="mt-2 text-[14px] font-medium text-ink-900 truncate">{book.name}</p>
      <p className="text-[12px] text-ink-500 truncate">{book.author}</p>
    </Link>
  );
}
