import { useMemo, useState } from "react";
import { FALLBACK_COVER } from "./BookCard.jsx";
import { GENRES, genreLabel, t } from "../utils/i18n.js";

/**
 * The library seen as its shelves: one display holder per genre, the books of
 * that genre stood up in it behind an acrylic pane.
 *
 * A fan of real covers rather than a grid of thumbnails or a labelled box,
 * because a fan says two things at once that a count cannot — what this genre
 * *looks* like, and that there is more behind the one in front.
 *
 * The covers are a sample, not the genre. They come from one page of the shelf
 * (see `GENRE_SAMPLE` in the Books screen), so a genre with two hundred books
 * shows five of whichever came back — while the count beside the name is the
 * count of that sample too, and says so by being the number of books the tile
 * could actually reach. Opening a genre re-queries it properly, filtered and
 * paged, which is where an exact answer belongs.
 */

// Five is what the holder takes before the ones at the back are further off
// the right edge than they are visible. Past that the fan stops reading as
// depth and starts reading as clipping.
const MAX_IN_STACK = 5;

// All as percentages of the tile. The pane covers the lower half so the books
// stand a clear head above it — under about 40% it stops reading as a holder
// and starts reading as a caption bar.
const PANE_HEIGHT = 48;

// 58 is not a look, it is the number that makes the fan fit. A cover is 2/3, so
// this width fixes the height at ~75% of a 6/7 tile — which is exactly what the
// backmost book has left once it has been lifted four steps up the fan. Widen
// the covers and the back of the fan grows out through the top of the tile.
const COVER_WIDTH = 58;

// How far each book behind the front one steps right, and how far it rides up.
// The step is wide enough that a cover shows a readable strip of itself rather
// than a sliver — under about 15 the fan collapses into one cover with coloured
// edges — and wide enough that the last of five is mostly past the right edge,
// which is the point: the fan should look like it continues past the tile.
const STEP_X = 20;
const STEP_Y = 2.5;

// The one fixed measurement: a screw is hardware, and hardware is the same size
// on a big shelf as on a small one. Scaled with the tile it would read as four
// different-sized screws across a grid of two columns.
const SCREW = 11;

export default function GenreShelves({ books, onOpen }) {
  // Genre order comes from the canonical list rather than from the data, so the
  // grid does not reshuffle itself every time a book is added — a tile that
  // moves between visits is a tile nobody learns the position of. Empty genres
  // simply do not appear.
  const shelves = useMemo(() => {
    const byGenre = new Map();
    for (const book of books) {
      // A book is filed under every genre it claims, not just the first one.
      // `genre` is only ever `genres[0]` (see firebase/schema.js) — it exists
      // because the security rules and the older queries need a single-valued
      // field, not because a book has one genre. Filing by it would hide a
      // history book that happened to be entered as fiction first from the
      // history tile entirely.
      const claimed = Array.isArray(book.genres) && book.genres.length
        ? book.genres
        : [book.genre || "other"];

      // Deduped per book: a document that somehow lists a genre twice must
      // still only appear once on that tile, and only count once.
      for (const key of new Set(claimed.filter(Boolean))) {
        if (!byGenre.has(key)) byGenre.set(key, []);
        byGenre.get(key).push(book);
      }
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
          {/* Name and count on one line, centred under the stack: the count is
              a property of the name, not a second fact about the tile, and two
              stacked lines made the caption taller than the gap between rows —
              which read as the count belonging to the tile below it. */}
          <p className="mt-2 text-center text-[14px] text-ink-500 truncate">
            <span className="font-semibold text-ink-900">{genreLabel(shelf.value)}</span>
            {" · "}
            <span className="tabular-nums">{shelf.books.length} {t.booksCountShort}</span>
          </p>
        </button>
      ))}
    </div>
  );
}

/**
 * One genre, as a display holder: the books stood up in a loose fan and an
 * acrylic pane screwed across the front of them.
 *
 * The pane is what makes it a holder rather than a pile. Books behind glass
 * are *filed* — they read as a place things are kept, which is what a genre is
 * — and the sheet gives the tile one clean rectangle at the bottom for the
 * name to sit under while the covers above it stay ragged and various. A fan
 * with nothing across it is just an untidy stack.
 *
 * The fan is flat, rotated in the plane rather than turned in 3D. These are
 * books leaning against each other in a bin, not a coverflow; a perspective
 * turn here would compete with the shelf view that already does that, and at
 * tile size a rotateY reads as a squash rather than a turn.
 *
 * Every measurement is a percentage of the tile, so the same numbers hold at
 * every column width — 171px on a phone, ~320 at the desktop max-width.
 */
function GenreStack({ books }) {
  const stack = books.slice(0, MAX_IN_STACK);
  const depth = stack.length;

  return (
    <div className="relative w-full aspect-[6/7] overflow-hidden">
      {stack.map((book, i) => {
        // 0 is the cover in front and lowest; larger d leans further right,
        // sits higher, and turns further clockwise — the way the books at the
        // back of a bin fan out from the one you are holding forward.
        const d = depth - 1 - i;
        return <StackCover key={book.id} book={book} depth={d} style={{ zIndex: depth - d }} />;
      })}

      {/* Above every cover, so it frosts all of them equally — the covers are
          laid out to be looked *through* it, not around it. The z-index is
          load-bearing and not decoration: the covers each carry one, and a
          later sibling at `auto` loses to an earlier one at 5, so without a
          number here the pane paints *behind* the whole fan and the tile is
          just an untidy stack with a smudge under it. */}
      <div
        className="shelf-glass absolute inset-x-0 bottom-0 rounded-xl"
        style={{ height: `${PANE_HEIGHT}%`, zIndex: MAX_IN_STACK + 1 }}
      >
        <Screw className="left-[6%] top-[9%]" />
        <Screw className="right-[6%] top-[9%]" />
        <Screw className="left-[6%] bottom-[9%]" />
        <Screw className="right-[6%] bottom-[9%]" />
      </div>
    </div>
  );
}

/**
 * One fixing. Round-headed and slotted, lit from the top left like everything
 * else on the page — it is the detail that says the pane is a separate object
 * fastened over the books rather than a gradient painted on them.
 */
function Screw({ className }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute rounded-full ${className}`}
      style={{
        width: SCREW,
        height: SCREW,
        background: "radial-gradient(circle at 32% 28%, #fdfdfe, #c3c9d2 62%, #8f97a4)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
      }}
    >
      <span
        className="absolute left-1/2 top-1/2"
        style={{
          width: "58%",
          height: 1,
          transform: "translate(-50%,-50%) rotate(-32deg)",
          background: "rgba(80, 88, 100, 0.75)",
        }}
      />
    </span>
  );
}

function StackCover({ book, depth, style }) {
  const [broken, setBroken] = useState(false);
  const cover = (!broken && book.coverUrl) || FALLBACK_COVER;

  return (
    <div
      className="absolute"
      style={{
        ...style,
        width: `${COVER_WIDTH}%`,
        aspectRatio: "2 / 3",
        left: `${3 + depth * STEP_X}%`,
        bottom: `${8 + depth * STEP_Y}%`,
        // About the bottom edge, because that is where the books are resting.
        // Rotating about the centre would swing the feet out from under them
        // and the fan would look like it was floating.
        transformOrigin: "50% 100%",
        // Front book tipped slightly the other way, so the fan opens from a
        // book that is leaning against the rest rather than from a neat edge.
        transform: `rotate(${-5 + depth * 4.5}deg) scale(${(1 - depth * 0.03).toFixed(3)})`,
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
          // The fan recedes rather than fading. A plain opacity drop would
          // wash the back covers into the page behind them; darkening keeps
          // them looking like paper in the shade of the one in front.
          filter: depth ? `brightness(${(1 - depth * 0.08).toFixed(2)})` : "none",
        }}
      />
    </div>
  );
}
