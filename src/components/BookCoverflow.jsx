import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FALLBACK_COVER } from "./BookCard.jsx";
import BookStatusBadge from "./BookStatusBadge.jsx";
import SaveButton from "./SaveButton.jsx";
import { genreLabel, t } from "../utils/i18n.js";
import { ratingSummary, formatRating } from "../utils/rating.js";

/**
 * The shelf as a coverflow — the same books as the list, stood up and turned
 * edge-on so the whole shelf is visible at once.
 *
 * Driven by the scroll position and nothing else. There are no arrows and no
 * active-index state feeding the animation: a card's angle is a pure function
 * of how far its centre sits from the middle of the viewport, so a half-swipe
 * is a half-turn and letting go mid-gesture leaves the shelf exactly where the
 * finger left it. That is what a spring animation keyed off a click cannot do,
 * and it is why this is native overflow rather than a transform track — the
 * momentum, the rubber-banding at the ends and the snap all come from the
 * compositor, on the platform's own curve.
 *
 * The transforms are written straight to the DOM inside a rAF rather than
 * through state. A scroll event fires far more often than React can usefully
 * re-render, and re-rendering a shelf of cards per frame is exactly the stutter
 * this view exists to avoid. React is told only when the *centred book*
 * changes, which is once per card rather than once per frame.
 */

const CARD_W = 208;   // px — the cover plate, not the slot
const GAP = 14;
const SLOT = CARD_W + GAP;

// How far the geometry keeps developing before it settles. Past this many
// cards from centre everything is pinned, so a long shelf costs no more than a
// short one to look at.
const FALLOFF = 2.4;

const MAX_ROT_Y = 52;   // deg — the flip, the reference's rotateY
const MAX_ROT_Z = 7;    // deg — the tilt. The reference used 90, which stands a
                        // photo fully on its side; a book reads as fallen over.
const MAX_DEPTH = 110;  // px pushed back along z
const MIN_SCALE = 0.74;
const MIN_OPACITY = 0.45;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export default function BookCoverflow({
  books,
  saved,
  onSaveToggle,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  /**
   * The genre this shelf is being read under, when it is being read under one.
   * A book carries up to three and the chip can only show one, so it shows the
   * one you came in through — otherwise a shelf opened at "History" is a row of
   * cards all labelled "Fiction", which reads as a filter that is not working
   * rather than as a book that is filed under both.
   */
  activeGenre = null,
}) {
  const scrollerRef = useRef(null);
  const cardRefs = useRef([]);
  const frameRef = useRef(0);
  const activeRef = useRef(0);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  const [active, setActive] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return undefined;
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  /**
   * One frame of geometry. Reads the scroll position once and writes every
   * card's transform from it — no per-card measurement, so this stays O(cards)
   * with no layout reads in the loop to force a reflow.
   */
  const paint = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;

    // Every slot is the same width and the end padding is exactly half a
    // viewport minus half a card, so a card's distance from the centre is pure
    // arithmetic: card i sits at `clientWidth/2 + i*SLOT` in scroll
    // coordinates, the centre sits at `scrollLeft + clientWidth/2`, and the two
    // halves cancel. No `offsetLeft`, no `getBoundingClientRect()` — which
    // matters twice over. It is a layout read per card per frame that we do not
    // pay, and it was also *wrong*: `offsetLeft` is measured from whichever
    // ancestor happens to be positioned, and the 3D wrapper here is one, so it
    // excluded the scroller's own padding and reported a book three slots away
    // as the centred one.
    const progress = el.scrollLeft / SLOT;
    const cards = cardRefs.current;
    const nearest = clamp(Math.round(progress), 0, Math.max(0, cards.length - 1));

    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      if (!card) continue;

      const raw = i - progress;
      const dist = Math.abs(raw);
      const inner = card.firstElementChild;
      if (!inner) continue;

      card.style.zIndex = String(1000 - Math.round(dist * 10));

      if (reduced) {
        inner.style.transform = "";
        inner.style.opacity = dist > FALLOFF ? String(MIN_OPACITY) : "1";
        continue;
      }

      // Signed for the rotations (they mirror around the centre), unsigned for
      // everything that only cares how far away the card is.
      const norm = clamp(raw / FALLOFF, -1, 1);
      const away = Math.min(dist / FALLOFF, 1);
      // Eased so the centred card holds its shape through the middle of the
      // gesture instead of shearing the moment the shelf moves.
      const eased = away * away * (3 - 2 * away);

      const rotY = -norm * MAX_ROT_Y;
      const rotZ = -norm * MAX_ROT_Z;
      const depth = -eased * MAX_DEPTH;
      const scale = 1 - eased * (1 - MIN_SCALE);
      const opacity = 1 - eased * (1 - MIN_OPACITY);

      inner.style.transform =
        `translate3d(0,0,${depth.toFixed(2)}px) ` +
        `rotateY(${rotY.toFixed(2)}deg) rotateZ(${rotZ.toFixed(2)}deg) ` +
        `scale(${scale.toFixed(4)})`;
      inner.style.opacity = opacity.toFixed(3);
    }

    if (nearest !== activeRef.current) {
      activeRef.current = nearest;
      setActive(nearest);
    }

    // Prefetch on approach, not on arrival: the shelf keeps moving under the
    // finger, and a page that starts loading only at the last card arrives
    // after the scroll has already stopped there.
    if (hasMore && !loadingMore) {
      const remaining = el.scrollWidth - (el.scrollLeft + el.clientWidth);
      if (remaining < SLOT * 3) loadMoreRef.current?.();
    }
  }, [reduced, hasMore, loadingMore]);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      paint();
    });
  }, [paint]);

  // Repaint when the shelf itself changes — a new page appended, the reduced
  // motion preference flipping, or the window resizing under a fixed scroll
  // position. Without this a freshly appended card renders flat.
  useEffect(() => {
    paint();
    const onResize = () => paint();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [paint, books.length]);

  if (!books.length) return null;

  const current = books[Math.min(active, books.length - 1)];

  return (
    <div className="pb-4">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="no-scrollbar overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain"
        style={{
          // Load-bearing, not cosmetic: `offsetLeft` below is measured from the
          // nearest *positioned* ancestor. Without this the cards report
          // page coordinates while `scrollLeft` reports scroller coordinates,
          // and every card is judged against a centre it does not share — the
          // shelf lights up the wrong book and turns the cards around it.
          position: "relative",
          // The whole point of the effect: without a perspective on the
          // scrolling box a rotateY is an affine squash, not a turn. Tailwind 3
          // has no utility for it.
          perspective: "1100px",
          perspectiveOrigin: "50% 45%",
          // Half a viewport of padding at each end is what lets the first and
          // last book reach the centre. A percentage resolves against this very
          // box, so it stays correct on every screen without measuring.
          paddingInline: `calc(50% - ${CARD_W / 2}px)`,
          scrollPaddingInline: `calc(50% - ${CARD_W / 2}px)`,
        }}
      >
        <div className="flex items-center" style={{ gap: `${GAP}px`, transformStyle: "preserve-3d" }}>
          {books.map((book, i) => (
            <div
              key={book.id}
              ref={(node) => { cardRefs.current[i] = node; }}
              className="shrink-0 snap-center"
              style={{ width: `${CARD_W}px`, transformStyle: "preserve-3d" }}
            >
              <CoverPlate
                book={book}
                saved={saved.has(book.id)}
                onSaveToggle={onSaveToggle}
                activeGenre={activeGenre}
              />
            </div>
          ))}

          {hasMore ? (
            <div className="shrink-0 flex items-center justify-center" style={{ width: `${CARD_W}px`, height: 292 }}>
              <p className="text-[13px] text-ink-500">{loadingMore ? t.loading : "···"}</p>
            </div>
          ) : null}
        </div>
      </div>

      {/* The caption sits still while the shelf moves. Reading a title off a
          card that is turning away is the one thing the effect makes harder,
          so the centred book says its name down here instead. */}
      <div className="px-6 pt-4 text-center">
        <h3 className="text-[16px] font-semibold text-ink-900 truncate">{current.name}</h3>
        <p className="text-[13px] text-ink-500 truncate mt-0.5">{current.author}</p>
        <p className="text-[12px] text-ink-500 mt-2 tabular-nums">
          {Math.min(active + 1, books.length)} / {books.length}
        </p>
      </div>
    </div>
  );
}

/**
 * One book, drawn the way the rail draws them: the cover blurred and cropped as
 * a backdrop, then whole and sharp on top, so every plate is the same shape
 * whatever aspect ratio the artwork came in.
 */
function CoverPlate({ book, saved, onSaveToggle, activeGenre }) {
  const [broken, setBroken] = useState(false);
  const cover = (!broken && book.coverUrl) || FALLBACK_COVER;
  const rating = ratingSummary(book);
  // Only honour the shelf's genre if this book actually claims it; a stale
  // prop must never make a card say something the book does not.
  const claimed = Array.isArray(book.genres) && book.genres.length
    ? book.genres
    : [book.genre].filter(Boolean);
  const shownGenre =
    activeGenre && claimed.includes(activeGenre) ? activeGenre : book.genre;

  return (
    <div
      className="will-change-transform"
      style={{ transformOrigin: "50% 50%", backfaceVisibility: "hidden" }}
    >
      <Link to={`/books/${book.id}`} className="block active:opacity-90 transition-opacity">
        <div className="relative w-full rounded-2xl overflow-hidden bg-ink-100 shadow-soft" style={{ height: 268 }}>
          <img
            src={cover}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-125 blur-xl"
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <img
              src={cover}
              alt={book.name}
              onError={() => setBroken(true)}
              loading="lazy"
              className="w-full h-full object-contain rounded-lg shadow-soft"
            />
          </div>

          <div className="absolute top-2 left-2">
            <BookStatusBadge status={book.status || "available"} daysLeft={book.daysLeft} />
          </div>

          <div className="absolute top-1.5 right-1.5">
            <SaveButton
              saved={Boolean(saved)}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSaveToggle?.(book); }}
            />
          </div>

          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 px-2.5 py-2 bg-gradient-to-t from-black/55 to-transparent">
            {shownGenre ? (
              // Not an ink token: this chip sits on artwork, not on a surface,
              // so a colour that flips with the theme flips against a
              // background that does not. `ink-700` on white went from dark on
              // light to light on light the moment the app went dark. White on
              // a scrim reads over any cover, in either theme — which is what
              // the rating beside it already does.
              <span className="px-2 py-0.5 rounded-full bg-black/55 text-white text-[11px] font-medium truncate">
                {genreLabel(shownGenre)}
              </span>
            ) : <span />}
            <span className="flex items-center gap-1 text-[12px] font-medium text-white shrink-0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#F5B100">
                <path d="M12 2.5l2.9 6 6.6.9-4.8 4.5 1.2 6.6L12 17.4 6.1 20.5l1.2-6.6L2.5 9.4l6.6-.9L12 2.5z" />
              </svg>
              {formatRating(rating.average)}
            </span>
          </div>
        </div>
      </Link>
    </div>
  );
}
