import { useMemo, useState, useEffect, useRef } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import BookCard from "../../components/BookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import Modal from "../../components/Modal.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBooks, updateUser, listRatingsForBooks } from "../../firebase/firestore.js";
import { t, GENRES, genreLabel } from "../../utils/i18n.js";
import { useInfiniteScroll } from "../../utils/useIntersectionHooks.js";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  const [draftGenres, setDraftGenres] = useState([]);

  const isFilterActive = status !== null || genres.length > 0;
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

      const items = result.items || [];
      if (items.length === 0) return { items: [], nextCursor: null, hasMore: false };

      // Ratings are batched per-page. We reuse the ratings cache so switching
      // filters that reveal the same books doesn't refetch their ratings.
      const ids = items.map((b) => b.id);
      const ratingMap = await queryClient.fetchQuery({
        queryKey: qk.books.ratings(ids),
        queryFn: () => listRatingsForBooks(ids, 5),
        staleTime: 5 * 60_000,
      });

      const withRatings = items.map((b) => ({
        ...b,
        rating: ratingMap[b.id]?.average || 0,
        ratingCount: ratingMap[b.id]?.count || 0,
      }));

      return {
        items: withRatings,
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

  function removeGenre(v) { setGenres((prev) => prev.filter((g) => g !== v)); }
  function removeStatus() { setStatus(null); }

  function openFilter() {
    setDraftStatus(status);
    setDraftGenres([...genres]);
    setFilterOpen(true);
  }

  function applyFilter() {
    setStatus(draftStatus);
    setGenres(draftGenres);
    setFilterOpen(false);
  }

  function resetDraft() {
    setDraftStatus(null);
    setDraftGenres([]);
  }

  function toggleDraftGenre(value) {
    setDraftGenres((prev) =>
      prev.includes(value) ? prev.filter((g) => g !== value) : [...prev, value]
    );
  }

  if (!community) {
    return (
      <MobileShell>
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
          onFilterClick={openFilter}
          filterActive={isFilterActive}
        />
      </div>

      {isFilterActive ? (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {status ? (
            <Chip
              label={t[STATUS_OPTIONS.find((o) => o.v === status)?.labelKey] ?? status}
              onRemove={removeStatus}
            />
          ) : null}
          {genres.map((g) => (
            <Chip key={g} label={genreLabel(g)} onRemove={() => removeGenre(g)} />
          ))}
        </div>
      ) : null}

      {isInitialLoading ? (
        <EmptyState title="Загрузка..." subtitle="" />
      ) : books.length === 0 ? (
        <EmptyState title="Книг пока нет" subtitle="Когда участники начнут делиться книгами, они появятся здесь." />
      ) : (
        <ul className="mt-2">
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

        <div className="mb-5">
          <p className="text-[13px] text-ink-500 mb-2">{t.genre}</p>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => {
              const lang = typeof window !== "undefined" ? localStorage.getItem("lang") || "kz" : "kz";
              const selected = draftGenres.includes(g.value);
              return (
                <button
                  key={g.value}
                  onClick={() => toggleDraftGenre(g.value)}
                  className={
                    "px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors " +
                    (selected ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-700")
                  }
                >
                  {g[lang] ?? g.kz}
                </button>
              );
            })}
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
