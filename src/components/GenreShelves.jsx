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
 * shows four of whichever came back — while the count beside the name is the
 * count of that sample too, and says so by being the number of books the tile
 * could actually reach. Opening a genre re-queries it properly, filtered and
 * paged, which is where an exact answer belongs.
 */

// Four. The fan has to fit *inside* the tile now — see `layoutFor` — so every
// book added past this one buys its place by making all of them narrower, and
// four covers at a readable size is a better tile than six at slivers.
const MAX_IN_STACK = 4;

// All as percentages of the tile. The pane covers the lower half so the books
// stand a clear head above it — under about 40% it stops reading as a holder
// and starts reading as a caption bar.
const PANE_HEIGHT = 44;

// A cover is 2/3, and the tile is 8/7, so this width puts the cover at ~79% of
// the tile's height: tall enough that a third of it clears the pane, short
// enough that the book at the back of the fan — lifted three steps — still has
// its top inside the tile.
const COVER_WIDTH = 46;

// How far each book behind the front one steps right, and how far it rides up.
const STEP_X = 11;
const STEP_Y = 2.5;

// Degrees between one book and the next. Small on purpose: the fan is centred,
// so the outermost book leans by `TILT * (n-1) / 2`, and every degree of lean
// swings its top corner sideways by the cover's whole height — which is what
// used to push the front book out through the left edge of the tile.
const TILT = 4;

// The one fixed measurement: a screw is hardware, and hardware is the same size
// on a big shelf as on a small one. Scaled with the tile it would read as four
// different-sized screws across a grid of two columns.
const SCREW = 11;

/**
 * Where one book sits, given how many are in the holder with it.
 *
 * Centred as a group rather than anchored to an edge. Anchoring was what broke
 * this: a fixed left inset plus a fixed step means the width the fan needs
 * grows with the number of books, and past three the ones at the back ran off
 * the right edge while the front one — leaning left — ran off the left. Here
 * the group's total spread is computed first and the leftovers are split
 * evenly, so a fan of four and a fan of one are both inside the tile with the
 * same margin.
 *
 * The tilt is symmetric around the middle of the fan for the same reason, and
 * it has a second effect worth having: with one book the middle *is* that
 * book, so it comes out at zero degrees and stands straight. A lone cover
 * leaning over looks like a mistake rather than a stack.
 */
function layoutFor(depth, count) {
  const spread = COVER_WIDTH + (count - 1) * STEP_X;
  return {
    left: `${((100 - spread) / 2 + depth * STEP_X).toFixed(2)}%`,
    bottom: `${(6 + depth * STEP_Y).toFixed(2)}%`,
    rotate: (depth - (count - 1) / 2) * TILT,
  };
}

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
    <div className="relative w-full aspect-[8/7] overflow-hidden">
      {stack.map((book, i) => {
        // 0 is the cover in front and lowest; larger d sits further right and
        // higher — the way the books at the back of a bin fan out from the one
        // you are holding forward.
        const d = depth - 1 - i;
        return (
          <StackCover
            key={book.id}
            book={book}
            depth={d}
            layout={layoutFor(d, depth)}
            style={{ zIndex: depth - d }}
          />
        );
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

function StackCover({ book, depth, layout, style }) {
  const [broken, setBroken] = useState(false);
  const cover = (!broken && book.coverUrl) || FALLBACK_COVER;

  return (
    <div
      className="absolute"
      style={{
        ...style,
        width: `${COVER_WIDTH}%`,
        aspectRatio: "2 / 3",
        left: layout.left,
        bottom: layout.bottom,
        // About the bottom edge, because that is where the books are resting.
        // Rotating about the centre would swing the feet out from under them
        // and the fan would look like it was floating.
        transformOrigin: "50% 100%",
        transform: `rotate(${layout.rotate.toFixed(2)}deg) scale(${(1 - depth * 0.03).toFixed(3)})`,
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
