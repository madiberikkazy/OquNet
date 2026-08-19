import { useMemo, useState } from "react";
import { FALLBACK_COVER } from "./BookCard.jsx";
import { GENRES, genreLabel, t } from "../utils/i18n.js";

/**
 * The shelf seen from above: one tile per genre, each a fan of the covers filed
 * under it.
 *
 * A stack rather than a grid of thumbnails because a stack says two things at
 * once that a count cannot — what this genre *looks* like, and that there is
 * more behind the one in front. Six is the most that reads as a stack; past
 * that the slivers are thinner than the gap between them and it turns into
 * texture.
 *
 * The covers are a sample, not the genre. They come from one page of the shelf
 * (see `GENRE_SAMPLE` in the Books screen), so a genre with two hundred books
 * shows six of whichever came back — while the count beside the name is the
 * count of that sample too, and says so by being the number of books the tile
 * could actually reach. Opening a genre re-queries it properly, filtered and
 * paged, which is where an exact answer belongs.
 */

const MAX_IN_STACK = 6;

export default function GenreShelves({ books, onOpen }) {
  // Genre order comes from the canonical list rather than from the data, so the
  // grid does not reshuffle itself every time a book is added — a tile that
  // moves between visits is a tile nobody learns the position of. Empty genres
  // simply do not appear.
  const shelves = useMemo(() => {
    const byGenre = new Map();
    for (const book of books) {
      const key = book.genre || "other";
      if (!byGenre.has(key)) byGenre.set(key, []);
      byGenre.get(key).push(book);
    }
    return GENRES
      .map((g) => ({ value: g.value, books: byGenre.get(g.value) || [] }))
      .filter((s) => s.books.length > 0);
  }, [books]);

  if (!shelves.length) return null;

  return (
    <div className="px-4 pt-1 pb-6 grid grid-cols-2 gap-x-4 gap-y-5">
      {shelves.map((shelf) => (
        <button
          key={shelf.value}
          type="button"
          onClick={() => onOpen?.(shelf.value)}
          className="text-left active:opacity-80 transition-opacity"
        >
          <GenreStack books={shelf.books} />
          <p className="mt-2 text-[14px] font-semibold text-ink-900 truncate">
            {genreLabel(shelf.value)}
          </p>
          <p className="text-[12px] text-ink-500 tabular-nums">
            {shelf.books.length} {t.booksCountShort}
          </p>
        </button>
      ))}
    </div>
  );
}

/**
 * One fan. The front cover sits upright against the right edge and every cover
 * behind it steps left, shrinks and turns a little further away, so the stack
 * reads back-to-front the way a shelf does when you tilt the front book
 * forward to see what is behind it.
 *
 * Laid out back-to-front in the DOM so that paint order alone gives the
 * overlap; the z-index is stated anyway because the rotation puts these in a
 * 3D context, where document order stops being the tie-breaker.
 */
function GenreStack({ books }) {
  const stack = books.slice(0, MAX_IN_STACK);
  const depth = stack.length;

  return (
    <div
      className="relative w-full rounded-2xl bg-ink-100 overflow-hidden"
      style={{ height: 150, perspective: "700px" }}
    >
      {stack.map((book, i) => {
        // 0 is the cover in front; larger d is further back and further left.
        const d = depth - 1 - i;
        return (
          <StackCover
            key={book.id}
            book={book}
            depth={d}
            style={{ zIndex: depth - d }}
          />
        );
      })}
    </div>
  );
}

function StackCover({ book, depth, style }) {
  const [broken, setBroken] = useState(false);
  const cover = (!broken && book.coverUrl) || FALLBACK_COVER;

  return (
    <div
      className="absolute top-1/2"
      style={{
        ...style,
        // Anchored to the right edge: the front cover is the one you are meant
        // to read, so it is the one that gets the whole width it needs.
        right: `${8 + depth * 13}px`,
        height: `${86 - depth * 3}%`,
        aspectRatio: "2 / 3",
        transform: `translateY(-50%) rotateY(${depth * 5}deg)`,
        transformOrigin: "right center",
      }}
    >
      <img
        src={cover}
        alt=""
        aria-hidden={depth > 0}
        loading="lazy"
        onError={() => setBroken(true)}
        className="w-full h-full object-cover rounded-md shadow-soft"
        style={{
          // The stack recedes into the tile rather than lying flat on it. A
          // plain opacity fade would wash the covers into the tile's own
          // background; darkening keeps them looking like paper in shadow.
          filter: depth ? `brightness(${(1 - depth * 0.07).toFixed(2)})` : "none",
        }}
      />
    </div>
  );
}
