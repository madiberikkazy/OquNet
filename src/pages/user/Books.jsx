import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import BookCard, { BOOK_ROW_HEIGHT } from "../../components/BookCard.jsx";
import { WindowVirtualList } from "../../components/VirtualList.jsx";
import GenreBar from "../../components/GenreBar.jsx";
import NewBooksRail from "../../components/NewBooksRail.jsx";
import BookCoverflow from "../../components/BookCoverflow.jsx";
import GenreShelves from "../../components/GenreShelves.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { SkeletonList, BookCardSkeleton, GenreTileSkeleton } from "../../components/Skeleton.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBooks, listNewBooks, updateUser } from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";
import { useInfiniteScroll } from "../../utils/useIntersectionHooks.js";
import { newFeedSeed, shuffleStable } from "../../utils/feedOrder.js";
import { safeGet, safeSet } from "../../utils/safeStorage.js";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../lib/queryKeys.js";
import {
  DEFAULT_SORT, EMPTY_FILTERS, SORTS,
  activeFilterCount, hasClientFilters, isSorted, matchesFilters,
  readFilters, sortBooks, sortNeedsFullScan, writeFilters,
} from "../../utils/bookFilters.js";
import Modal from "../../components/Modal.jsx";

const PAGE_SIZE = 25;

// The page size while a client-side filter is on. Those filters run over rows
// that have already been fetched (see utils/bookFilters.js), so a page is a
// page of *candidates* rather than of results — asking for more of them per
// round trip is what keeps a narrow filter from turning into twenty requests.
const SCAN_PAGE_SIZE = 100;

// The ceiling on a scan, in pages. A sort is only honest over the whole shelf,
// but "the whole shelf" has to have a limit or one tap on a large community
// bills a thousand reads. Ten pages is a thousand books, which is far past any
// community this is built for — and past it the order is over the thousand
// most recently added rather than over everything, which is the tradeoff being
// made rather than a bug to find later.
const MAX_SCAN_PAGES = 10;

const VIEW = { LIST: "list", CARD: "card" };
const VIEW_KEY = "oqunet.books.view";

// One page of the shelf, grouped client-side into the genre tiles. Deliberately
// a sample and not a census: an exact per-genre count needs one aggregate query
// per genre, and the tiles are a way in rather than a report. Opening a tile
// re-queries that genre properly — filtered, paged, and complete.
const GENRE_SAMPLE = 120;

// Above this many rows the shelf stops rendering the whole list and windows it.
//
// A threshold rather than always-on, because virtualising is not free: it adds
// a scroll listener, a measurement per frame, and a slice recomputation, and
// below a couple of hundred nodes the browser was never the bottleneck. Four
// pages of results is where the DOM starts costing more than the machinery to
// avoid it — a reader who has scrolled that far is going to keep scrolling,
// which is exactly when a list of eight hundred `<li>`s starts to stutter.
const VIRTUALIZE_ABOVE = 100;

// The search text updates every keystroke, but we don't want to refire the
// query on every character — this delays the value used as a query key until
// typing pauses.
function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return v;
}

export default function Books() {
  const { user, refresh } = useAuth();
  const { community } = useCommunity();
  const { lang } = useLang();
  const queryClient = useQueryClient();

  const navigate = useNavigate();

  // The filters live in the URL, because the screen that sets them is a route
  // of its own now: component state would not survive the trip there and back.
  // It also means the back button undoes a narrowing, and a filtered shelf is
  // a link.
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const { status, genres } = filters;

  const [search, setSearch] = useState("");
  const [sortOpen, setSortOpen] = useState(false);

  // How the shelf is drawn. Remembered across sessions: which of the two a
  // person reads a shelf in is a preference about their own eyes, not about
  // this visit, and re-picking it on every launch is the kind of small friction
  // that makes a setting feel like it did not take.
  const [view, setView] = useState(() =>
    safeGet(VIEW_KEY, VIEW.LIST) === VIEW.CARD ? VIEW.CARD : VIEW.LIST
  );

  // Which genre tile is open, in card view. `null` is the grid itself.
  const [openGenre, setOpenGenre] = useState(null);

  function toggleView() {
    setView((prev) => {
      const next = prev === VIEW.LIST ? VIEW.CARD : VIEW.LIST;
      safeSet(VIEW_KEY, next);
      return next;
    });
    // Leaving card view closes the genre with it: coming back to a list that is
    // silently filtered by a tile tapped minutes ago is a filter nobody set.
    setOpenGenre(null);
  }

  // The dot on the filter icon now speaks for all six, since none of them are
  // visible on this screen any more.
  const activeCount = activeFilterCount(filters);
  const isFilterActive = activeCount > 0;
  const debouncedSearch = useDebounced(search, 300);

  /** Replace one filter without disturbing the other five. */
  const setFilters = useCallback(
    (patch) => setParams(writeFilters({ ...filters, ...patch }), { replace: true }),
    [filters, setParams]
  );

  // An opened tile *is* the genre filter while it is open — it replaces the
  // chips rather than intersecting them, so a tile always shows the whole
  // genre and never the empty intersection of two of them.
  // Card view has two screens behind one toggle: the grid of genres, and one
  // genre opened as a shelf. Declared up here because it gates the queries as
  // well as the markup.
  const inCardGrid = view === VIEW.CARD && !openGenre;

  const activeGenres = useMemo(
    () => (openGenre ? [openGenre] : genres),
    [openGenre, genres]
  );

  // Only the part the *query* can carry. Language, author, page band and year
  // are absent on purpose — Firestore would need a composite index per
  // combination, and utils/bookFilters.js explains where that line is drawn.
  const queryFilters = useMemo(
    () => ({ search: debouncedSearch, status, genres: activeGenres }),
    [debouncedSearch, status, activeGenres]
  );

  // With a client-side filter on, each page is a page of candidates, so the
  // scan asks for more per round trip. It is part of the key: changing the page
  // size changes the cursors, and two different sizes under one key would
  // interleave pages that do not line up.
  // Two different reasons to read past the first page. A filter scans until it
  // finds enough; a sort has to reach the end before it can claim an order at
  // all, because "the highest rated" over a quarter of the shelf is an answer
  // to a question nobody asked.
  const filtering = hasClientFilters(filters);
  const fullScan = sortNeedsFullScan(filters);
  const scanning = filtering || fullScan;
  const pageSize = scanning ? SCAN_PAGE_SIZE : PAGE_SIZE;

  const listQuery = useInfiniteQuery({
    queryKey: qk.books.list(community?.id, { ...queryFilters, pageSize }),
    // The grid does not render this list, and asking for a page nobody is
    // going to see is a billed read per visit to the genre screen. The tile
    // that opens turns it back on with the genre already in `filters`.
    enabled: !!community?.id && !inCardGrid,
    queryFn: async ({ pageParam }) => {
      const result = await listBooks({
        communityId: community.id,
        ...queryFilters,
        pageSize,
        cursor: pageParam ?? null,
      });

      // Every book carries its own `ratingSum` / `ratingCount`, and BookCard
      // folds them with ratingSummary — so a page of books already knows its
      // own scores and there is nothing further to fetch.
      return {
        items: result.items || [],
        nextCursor: result.nextCursor ?? null,
        hasMore: !!result.hasMore,
      };
    },
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
  });

  // One seed per visit to the shelf. In state rather than computed inline: the
  // order has to hold still while the reader scrolls, and a seed made during
  // render is a new order on every render.
  const [shelfSeed] = useState(newFeedSeed);

  /**
   * The shelf, in an order that is not "newest first".
   *
   * Firestore cannot sort randomly, and a shelf ordered by `createdAt` shows
   * every reader the same handful of books at the top for as long as nobody
   * adds one — the rest of the community's library is three screens down and
   * effectively invisible.
   *
   * So each *page* is shuffled where it lands, and the pages themselves keep
   * arriving in the database's own order. That is what keeps infinite scroll
   * honest: the cursor still walks `createdAt`, so no book is served twice and
   * none is skipped, and — because the shuffle is per page rather than over the
   * whole accumulated list — the rows already on screen do not rearrange
   * themselves when the next page loads.
   */
  const books = useMemo(() => {
    const fetched = (listQuery.data?.pages || [])
      .flatMap((p, i) => shuffleStable(p.items, shelfSeed + i));
    // The four filters the query could not carry, applied here. Before the
    // sort, so an order is computed over the books that will actually be shown.
    const kept = filtering ? fetched.filter((b) => matchesFilters(b, filters)) : fetched;
    return sortBooks(kept, filters.sort, lang);
  }, [listQuery.data, shelfSeed, filtering, filters, lang]);

  // The rail is a browsing shortcut, not a filter result: while the user is
  // searching or narrowing by anything it would only push their results off screen.
  const showNewBooks = !debouncedSearch && !isFilterActive;

  const newBooksQuery = useQuery({
    queryKey: qk.books.recent(community?.id),
    enabled: !!community?.id && showNewBooks,
    queryFn: () => listNewBooks({ communityId: community.id }),
    staleTime: 5 * 60_000,
    // The rail shows the same books as the list below it, so a cached copy that
    // predates an edit — an admin adding the cover a minute after the book —
    // reads as one book with two different covers on one screen. The query
    // cache is persisted to IndexedDB, so without this the mismatch survives
    // restarts. Ten documents by index; cheap enough to re-read on mount.
    refetchOnMount: "always",
  });

  // The genre grid's own sample. Unfiltered on purpose: the tiles are the way
  // *into* the shelf, so narrowing them by the chips the tiles are meant to
  // replace would leave a grid that empties as you use it.
  const genreQuery = useQuery({
    queryKey: qk.books.genreOverview(community?.id),
    enabled: !!community?.id && view === VIEW.CARD && !openGenre,
    queryFn: () => listBooks({ communityId: community.id, pageSize: GENRE_SAMPLE }),
    staleTime: 5 * 60_000,
  });

  // Two horizontal scrollers stacked on a phone is a gesture fight nobody
  // wins: a swipe near the boundary picks one at random. The shelf *is* the
  // visual browse in card view, so the rail stands down while it is up.
  const hasNewBooks =
    showNewBooks && view === VIEW.LIST && (newBooksQuery.data?.length || 0) > 0;

  // One loader behind both views: the list reaches it through an intersection
  // sentinel, the shelf through its own scroll position.
  const loadMore = useCallback(() => {
    if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
      listQuery.fetchNextPage();
    }
  }, [listQuery.hasNextPage, listQuery.isFetchingNextPage, listQuery.fetchNextPage]);

  // A scan that has filtered away everything it has fetched so far has no rows
  // to hang a sentinel on, so nothing would ever ask for the next page and the
  // screen would settle on "nothing found" while most of the shelf was still
  // unread. Keep pulling until a match turns up or the shelf runs out.
  const pagesLoaded = listQuery.data?.pages?.length || 0;
  const scanExhausted = !listQuery.hasNextPage || pagesLoaded >= MAX_SCAN_PAGES;

  useEffect(() => {
    if (!scanning) return;
    // A sort keeps pulling regardless of how much it has; a filter stops as
    // soon as it has something to show and lets the reader's own scrolling ask
    // for the rest.
    if (!fullScan && books.length) return;
    if (scanExhausted || listQuery.isFetchingNextPage) return;
    listQuery.fetchNextPage();
  }, [scanning, fullScan, books.length, scanExhausted, listQuery.isFetchingNextPage, listQuery.fetchNextPage]);

  // A sort is only true once the whole shelf is in. Until then the screen says
  // it is working rather than showing an order it will rearrange a moment
  // later — a list that reshuffles under a thumb is worse than a wait.
  const awaitingFullScan = fullScan && !scanExhausted;

  const { sentinelRef } = useInfiniteScroll({ onLoadMore: loadMore, threshold: 300 });

  const savedSet = useMemo(() => new Set(user?.savedBookIds || []), [user?.savedBookIds]);

  // Optimistic save toggle. UI flips instantly; the network call happens in
  // the background. On failure, refresh() will pull the true state from Auth.
  const saveMutation = useMutation({
    mutationFn: async (nextIds) => {
      await updateUser(user.id, { savedBookIds: nextIds });
    },
    onSuccess: () => refresh(),
  });

  // Track a local override so the button reflects the optimistic state until
  // AuthContext refreshes. Once refresh() lands, savedSet takes over again.
  const pendingSavedRef = useRef(null);
  const effectiveSaved = pendingSavedRef.current ?? savedSet;

  function onSaveToggle(book) {
    if (!user?.id) return;
    const next = new Set(effectiveSaved);
    if (next.has(book.id)) next.delete(book.id);
    else next.add(book.id);
    pendingSavedRef.current = next;
    saveMutation.mutate([...next], {
      onSettled: () => {
        pendingSavedRef.current = null;
      },
    });
  }

  /** Hand the current filters to the filter screen so it opens on them. */
  function openFilter() {
    const query = writeFilters(filters).toString();
    navigate(query ? `/books/filter?${query}` : "/books/filter");
  }

  if (!community) {
    return (
      <MobileShell>
        <div className="px-4 pt-2">
          <JoinCommunityBanner />
        </div>
        <EmptyState title={t.booksNeedCommunityTitle} subtitle={t.booksNeedCommunitySubtitle} />
      </MobileShell>
    );
  }

  // We never show a full-page spinner if any cached data is available — the
  // list renders immediately and a background refetch quietly replaces it.
  const isInitialLoading = listQuery.isLoading && books.length === 0;

  return (
    <MobileShell
      header={
        <div className="pb-2">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder={t.searchPlaceholder}
            onFilterClick={openFilter}
            filterActive={isFilterActive}
            rightSlot={
              <>
                <ViewToggle view={view} onToggle={toggleView} />
                <SortToggle active={isSorted(filters)} onClick={() => setSortOpen(true)} />
              </>
            }
          />
        </div>
      }
    >
      {view === VIEW.CARD ? (
        /* One bar over both card screens — the grid of genres and a genre
           opened as a shelf are the same screen at two depths, and the bar is
           what moves between them: a chip opens that genre, the "all" pill is
           the way back to the grid. Above the grid rather than only over the
           shelf, so drilling in changes what is *under* the bar and never
           moves the bar itself. */
        <GenreBar
          single
          selected={openGenre ? [openGenre] : []}
          onChange={(next) => setOpenGenre(next[0] ?? null)}
        />
      ) : null}

      {inCardGrid ? (
        // Card view with no tile open is the genre grid and nothing else: the
        // tiles are the way into the shelf, and the paged list underneath is a
        // query this screen is not showing.
        genreQuery.isLoading ? (
          // Six tiles in the same two columns the grid uses — enough to fill
          // the fold, so the page has its real height before the covers land.
          <div role="status" aria-busy="true" aria-label={t.loading} className="grid grid-cols-2 gap-x-4 gap-y-5 px-4 pt-1">
            {Array.from({ length: 6 }, (_, i) => <GenreTileSkeleton key={i} />)}
          </div>
        ) : (genreQuery.data?.items?.length || 0) === 0 ? (
          <EmptyState title={t.noBooksYetTitle} subtitle={t.noBooksYetSubtitle} />
        ) : (
          <GenreShelves books={genreQuery.data.items} onOpen={setOpenGenre} />
        )
      ) : (
        <>
          {view === VIEW.CARD ? null : (
            /* The genre chips scroll away with the shelf rather than joining the
               bar. They are what you are looking at, not what you are looking
               with — and a two-storey sticky header eats a third of a phone. */
            <GenreBar selected={genres} onChange={(next) => setFilters({ genres: next })} />
          )}

          {/* One chip for the whole filter rather than one per filter: six of
              them would wrap to three lines above the results, and the screen
              that can actually edit them is one tap away. Removing it clears
              all six, which is what a single chip has to mean. */}
          {isFilterActive ? (
            <div className="flex flex-wrap gap-2 px-4 pt-1 pb-2">
              <Chip
                label={t.filterActiveCount(activeCount)}
                onRemove={() => setParams(
                  writeFilters({ ...EMPTY_FILTERS, sort: filters.sort }),
                  { replace: true }
                )}
              />
            </div>
          ) : null}

          {hasNewBooks ? <NewBooksRail books={newBooksQuery.data} /> : null}

          {isInitialLoading ? (
            <SkeletonList count={7} label={t.loading} Item={BookCardSkeleton} />
          ) : awaitingFullScan ? (
            // Ahead of the empty check on purpose: a half-read shelf may well
            // have rows to show, and showing them would mean rendering an order
            // that is about to change.
            <SkeletonList count={7} label={t.sortScanning} Item={BookCardSkeleton} />
          ) : books.length === 0 ? (
            // Three different nothings, and saying the wrong one is worse than
            // saying nothing: a scan still walking the shelf has not concluded
            // anything yet, a scan that reached the end has concluded the
            // filters are too narrow, and an unfiltered shelf with no rows is a
            // community that has not added a book.
            scanning && !scanExhausted ? (
              <SkeletonList count={5} label={t.filterScanning} Item={BookCardSkeleton} />
            ) : isFilterActive ? (
              <>
                <EmptyState title={t.filterNoMatches} subtitle={t.filterNoMatchesHint} />
                {/* The automatic scan stops at MAX_SCAN_PAGES so one tap cannot
                    bill a thousand reads. When it stopped there rather than at
                    the end of the shelf, "nothing matches" is not yet true —
                    so the reader is offered the rest rather than told a thing
                    the app has not checked. */}
                {listQuery.hasNextPage ? (
                  <div className="px-4">
                    <button
                      onClick={loadMore}
                      disabled={listQuery.isFetchingNextPage}
                      className="btn-secondary"
                    >
                      {listQuery.isFetchingNextPage ? t.loading : t.filterKeepSearching}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState title={t.noBooksYetTitle} subtitle={t.noBooksYetSubtitle} />
            )
          ) : (
            <>
              {/* The rail's books are in this list too, so it needs a name of its
                  own once the rail is up — otherwise the two read as one
                  sequence. */}
              {hasNewBooks ? (
                <h2 className="px-4 pt-1 pb-2 text-[19px] font-bold text-ink-900">{t.defaultBooks}</h2>
              ) : null}

              {view === VIEW.CARD ? (
                // The shelf paginates off its own horizontal scroll — the
                // vertical sentinel below never comes into view when the books
                // run sideways, so handing it the same callback is what keeps
                // the two views loading the same pages.
                <BookCoverflow
                  books={books}
                  saved={effectiveSaved}
                  onSaveToggle={onSaveToggle}
                  hasMore={listQuery.hasNextPage}
                  loadingMore={listQuery.isFetchingNextPage}
                  onLoadMore={loadMore}
                  activeGenre={openGenre}
                />
              ) : books.length > VIRTUALIZE_ABOVE ? (
                /* Same rows, same order, same handlers — only the ones inside
                   the viewport exist in the DOM. Not a <ul>: the virtualiser
                   inserts spacer padding on its own container, and a list whose
                   children are mostly absent is a lie to a screen reader
                   anyway, so the rows stay plain links.

                   The sentinel goes after it, where it always was: the padding
                   below the slice reserves the full height of the remaining
                   rows, so "the bottom of the list" is still the bottom of the
                   list and infinite scroll keeps firing at the same point. */
                <>
                  <WindowVirtualList
                    items={books}
                    itemHeight={BOOK_ROW_HEIGHT}
                    className="mt-1"
                    keyExtractor={(b) => b.id}
                    renderItem={(b) => (
                      <BookCard book={b} saved={effectiveSaved.has(b.id)} onSaveToggle={onSaveToggle} />
                    )}
                  />
                  {listQuery.hasNextPage && (
                    <div ref={sentinelRef}>
                      {listQuery.isFetchingNextPage ? (
                        <SkeletonList count={2} label={t.loading} Item={BookCardSkeleton} />
                      ) : (
                        <p className="py-4 text-center text-ink-500 text-[13px]">{t.scrollForMore}</p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <ul className="mt-1">
                  {books.map((b) => (
                    <li key={b.id}>
                      <BookCard book={b} saved={effectiveSaved.has(b.id)} onSaveToggle={onSaveToggle} />
                    </li>
                  ))}

                  {listQuery.hasNextPage && (
                    /* The sentinel carries the next page's placeholder rather
                       than a line of text: the two rows that appear here are
                       the same height as the two that replace them, so the
                       scroll position the reader is holding does not shift
                       under them when the page lands. */
                    <li ref={sentinelRef}>
                      {listQuery.isFetchingNextPage ? (
                        <SkeletonList count={2} label={t.loading} Item={BookCardSkeleton} />
                      ) : (
                        <p className="py-4 text-center text-ink-500 text-[13px]">{t.scrollForMore}</p>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
        </>
      )}

      <Modal open={sortOpen} onClose={() => setSortOpen(false)} title={t.sortTitle}>
        <div className="flex flex-col gap-1">
          {SORTS.map((option) => {
            const chosen = (filters.sort?.by || DEFAULT_SORT.by) === option.value;
            return (
              <button
                key={option.value}
                onClick={() => {
                  // Picking an order opens it on that order's own useful end,
                  // and re-picking the one already chosen keeps the direction
                  // the reader set rather than snapping it back.
                  const dir = chosen ? filters.sort.dir : option.dir;
                  setFilters({ sort: { by: option.value, dir } });
                  setSortOpen(false);
                }}
                className={
                  "flex items-center gap-3 px-3 py-3 rounded-xl text-left text-[15px] transition " +
                  (chosen ? "bg-tint text-tintInk font-semibold" : "text-ink-900")
                }
              >
                <span className="flex-1">{t[option.labelKey]}</span>
                {chosen ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Direction is meaningless on the shelf's own order, which is not an
            order over any field, so it only appears once there is one. */}
        {isSorted(filters) ? (
          <div className="mt-4 pt-4 border-t border-ink-100">
            <p className="text-[13px] text-ink-500 mb-2">{t.sortDirection}</p>
            <div className="flex gap-2">
              {[["desc", t.sortDescending], ["asc", t.sortAscending]].map(([dir, label]) => (
                <button
                  key={dir}
                  onClick={() => setFilters({ sort: { ...filters.sort, dir } })}
                  aria-pressed={filters.sort.dir === dir}
                  className={
                    "flex-1 py-2.5 rounded-xl text-[14px] font-medium transition " +
                    (filters.sort.dir === dir ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-700")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Modal>
    </MobileShell>
  );
}

/**
 * Sort, beside the filter. Its own control rather than a section inside the
 * filter screen: filtering is a decision somebody makes once and sorting is one
 * they flip between, and burying a flip two taps deep behind a screen with an
 * Apply button turns "show me the highest rated" into a small errand.
 */
function SortToggle({ active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t.sortTitle}
      title={t.sortTitle}
      className="icon-btn shrink-0 relative"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M7 4v16M7 20l-3-3M7 20l3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 20V4M17 4l-3 3M17 4l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {active ? (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-brand-500 ring-2 ring-base" />
      ) : null}
    </button>
  );
}

/**
 * List ⇄ card. One button with two faces rather than a pair of tabs: there are
 * exactly two states, so the icon can show the one you would land in and the
 * control costs a single slot next to the filter.
 */
function ViewToggle({ view, onToggle }) {
  const isCard = view === VIEW.CARD;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isCard}
      aria-label={isCard ? t.viewList : t.viewCard}
      title={isCard ? t.viewList : t.viewCard}
      className="icon-btn shrink-0"
    >
      {isCard ? (
        // Showing cards → offer the list
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        // Showing the list → offer the shelf: a tall plate flanked by two
        // turning away, which is what the view actually looks like.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="4" width="6" height="16" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
          <path d="M6 7.5v9M3.5 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M18 7.5v9M20.5 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function JoinCommunityBanner() {
  return (
    <div className="card px-4 py-3 flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-500">
          <circle cx="9" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 21c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M16 3.1a3 3 0 0 1 0 5.8M21 21c0-2.7-1.7-5-4-5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ink-700">{t.joinCommunityPromptTitle}</p>
        <p className="text-[12px] text-ink-400">{t.joinCommunityPromptHint}</p>
      </div>
      <Link to="/community/join" className="text-[12px] font-semibold text-brand-600 shrink-0">
        {t.findCta}
      </Link>
    </div>
  );
}

function Chip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-full bg-brand-50 text-brand-700 text-[13px] font-medium">
      {label}
      <button
        onClick={onRemove}
        className="w-4 h-4 rounded-full bg-brand-200 flex items-center justify-center hover:bg-brand-300 transition"
        aria-label={t.removeFilter}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}
