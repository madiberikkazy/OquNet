import { useMemo, useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import BookCard from "../../components/BookCard.jsx";
import GenreBar from "../../components/GenreBar.jsx";
import NewBooksRail from "../../components/NewBooksRail.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import Modal from "../../components/Modal.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBooks, listNewBooks, updateUser } from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";
import { useInfiniteScroll } from "../../utils/useIntersectionHooks.js";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../lib/queryKeys.js";

const STATUS_OPTIONS = [
  { v: null,          labelKey: "allBooks"          },
  { v: "available",   labelKey: "statusAvailable"   },
  { v: "soon",        labelKey: "statusSoon"        },
  { v: "unavailable", labelKey: "statusUnavailable" },
];

const PAGE_SIZE = 25;

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
  useLang();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(null);
  const [genres, setGenres] = useState([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const [draftStatus, setDraftStatus] = useState(null);

  // Genres live in the bar under the search field now, so the dot on the filter
  // icon only has to speak for what the modal still hides — the status.
  const isFilterActive = status !== null;
  const debouncedSearch = useDebounced(search, 300);

  const filters = useMemo(
    () => ({ search: debouncedSearch, status, genres }),
    [debouncedSearch, status, genres]
  );

  const listQuery = useInfiniteQuery({
    queryKey: qk.books.list(community?.id, filters),
    enabled: !!community?.id,
    queryFn: async ({ pageParam }) => {
      const result = await listBooks({
        communityId: community.id,
        ...filters,
        pageSize: PAGE_SIZE,
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

  const books = useMemo(
    () => (listQuery.data?.pages || []).flatMap((p) => p.items),
    [listQuery.data]
  );

  // The rail is a browsing shortcut, not a filter result: while the user is
  // searching or narrowing by genre it would only push their results off screen.
  const showNewBooks = !debouncedSearch && genres.length === 0 && status === null;

  const newBooksQuery = useQuery({
    queryKey: qk.books.recent(community?.id),
    enabled: !!community?.id && showNewBooks,
    queryFn: () => listNewBooks({ communityId: community.id }),
    staleTime: 5 * 60_000,
  });

  const hasNewBooks = showNewBooks && (newBooksQuery.data?.length || 0) > 0;

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: () => {
      if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
        listQuery.fetchNextPage();
      }
    },
    threshold: 300,
  });

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

  function removeStatus() { setStatus(null); }

  function openFilter() {
    setDraftStatus(status);
    setFilterOpen(true);
  }

  function applyFilter() {
    setStatus(draftStatus);
    setFilterOpen(false);
  }

  function resetDraft() {
    setDraftStatus(null);
  }

  if (!community) {
    return (
      <MobileShell>
        <div className="px-4 pt-2">
          <JoinCommunityBanner />
        </div>
        <EmptyState title="Books недоступны" subtitle="Вступите в сообщество, чтобы видеть книги." />
      </MobileShell>
    );
  }

  // We never show a full-page spinner if any cached data is available — the
  // list renders immediately and a background refetch quietly replaces it.
  const isInitialLoading = listQuery.isLoading && books.length === 0;

  return (
    <MobileShell>
      <div className="pb-2">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder={t.searchPlaceholder}
          onFilterClick={openFilter}
          filterActive={isFilterActive}
        />
      </div>

      <GenreBar selected={genres} onChange={setGenres} />

      {status ? (
        <div className="flex flex-wrap gap-2 px-4 pt-1 pb-2">
          <Chip
            label={t[STATUS_OPTIONS.find((o) => o.v === status)?.labelKey] ?? status}
            onRemove={removeStatus}
          />
        </div>
      ) : null}

      {hasNewBooks ? <NewBooksRail books={newBooksQuery.data} /> : null}

      {isInitialLoading ? (
        <EmptyState title="Загрузка..." subtitle="" />
      ) : books.length === 0 ? (
        <EmptyState title="Книг пока нет" subtitle="Когда участники начнут делиться книгами, они появятся здесь." />
      ) : (
        <>
        {/* The rail's books are in this list too, so it needs a name of its own
            once the rail is up — otherwise the two read as one sequence. */}
        {hasNewBooks ? (
          <h2 className="px-4 pt-1 pb-2 text-[19px] font-bold text-ink-900">{t.defaultBooks}</h2>
        ) : null}
        <ul className="mt-1">
          {books.map((b) => (
            <li key={b.id}>
              <BookCard book={b} saved={effectiveSaved.has(b.id)} onSaveToggle={onSaveToggle} />
            </li>
          ))}

          {listQuery.hasNextPage && (
            <li ref={sentinelRef} className="py-4 text-center">
              {listQuery.isFetchingNextPage ? (
                <p className="text-ink-400 text-[14px]">{t.loading || "Загрузка..."}</p>
              ) : (
                <p className="text-ink-400 text-[13px]">Прокрутите для загрузки больше</p>
              )}
            </li>
          )}
        </ul>
        </>
      )}

      <Modal open={filterOpen} onClose={() => setFilterOpen(false)} title={t.filterTitle} scrollable>
        <div className="mb-5">
          <p className="text-[13px] text-ink-500 mb-2">{t.status}</p>
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={String(opt.v)}
                onClick={() => setDraftStatus(opt.v)}
                className={
                  "px-4 py-2 rounded-xl text-[14px] font-medium transition " +
                  (draftStatus === opt.v
                    ? "bg-brand-500 text-white"
                    : "bg-ink-100 text-ink-700")
                }
              >
                {t[opt.labelKey]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <button
            onClick={resetDraft}
            className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-ink-100 text-ink-700 transition"
          >
            {t.filterReset}
          </button>
          <button
            onClick={applyFilter}
            className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-brand-500 text-white transition"
          >
            {t.filterApply}
          </button>
        </div>
      </Modal>
    </MobileShell>
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
        <p className="text-[13px] font-medium text-ink-700">Қоғамдастыққа қосылыңыз</p>
        <p className="text-[12px] text-ink-400">Кітаптарды алу үшін қоғамдастық керек</p>
      </div>
      <Link to="/community/join" className="text-[12px] font-semibold text-brand-600 shrink-0">
        Табу →
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
        aria-label="Remove filter"
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}
