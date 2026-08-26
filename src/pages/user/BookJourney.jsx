import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  BOOK_JOURNEY_MAX, getBook, getUsersByIds, listBorrowingsForBook,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import { safeImageUrl } from "../../utils/validators.js";
import { formatPostDate, toMillis } from "../../utils/time.js";
import { useGoBack } from "../../utils/useGoBack.js";
import { t } from "../../utils/i18n.js";
import Loading from "../../components/Loading.jsx";

const DAY_MS = 86_400_000;

/**
 * Where a book has been, and who had it.
 *
 * A shelf tells you where a book is; this tells you where it has been, which is
 * the thing a shared library has that a private one does not. It is drawn as a
 * timeline rather than a table because that is what it is: it starts with the
 * person who put the book into the community and ends wherever it is tonight.
 *
 * Read from the loans, not from the book. A book document carries only its
 * current state — one owner, one holder — so the history has to come from the
 * `borrowings` collection, which keeps one row per read and never deletes one.
 * That is also why this screen exists at all: the data was already there and
 * nothing looked at it.
 *
 * Everything here is public to the community by construction: a book is
 * readable only to its own members, so anybody who can open this screen could
 * already see who is holding the book and who owns it. The journey adds the
 * past, not a new audience.
 */
export default function BookJourney() {
  const { id: bookId } = useParams();
  const { user } = useAuth();
  const goBack = useGoBack(`/books/${bookId}`);

  const bookQuery = useQuery({
    queryKey: qk.books.detail(bookId),
    enabled: !!bookId,
    staleTime: 60_000,
    queryFn: () => getBook(bookId),
  });
  const book = bookQuery.data ?? null;

  const loansQuery = useQuery({
    queryKey: qk.books.journey(bookId),
    enabled: !!bookId,
    staleTime: 30_000,
    queryFn: () => listBorrowingsForBook(bookId),
  });
  const loans = loansQuery.data ?? [];

  // One fetch for the whole cast, keyed on who is in it — so a second visit
  // with the same readers is free, and a new loan re-runs it.
  const castKey = useMemo(() => {
    const ids = loans.map((l) => l.borrowerId).filter(Boolean);
    if (book?.ownerId) ids.push(book.ownerId);
    return [...new Set(ids)].sort().join(",");
  }, [loans, book?.ownerId]);

  const peopleQuery = useQuery({
    queryKey: qk.books.journeyPeople(castKey),
    enabled: castKey.length > 0,
    staleTime: 60_000,
    queryFn: () => getUsersByIds(castKey.split(",")),
  });
  const people = peopleQuery.data ?? {};

  const loading = bookQuery.isLoading || loansQuery.isLoading;

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <Loading />
      </MobileShell>
    );
  }

  if (!book) {
    return (
      <MobileShell withNav={false}>
        <EmptyState title={t.bookNotFound} subtitle={t.journeyBookGoneHint} />
      </MobileShell>
    );
  }

  const owner = people[book.ownerId] ?? null;
  const holderId = holderIdOf(book);
  // The book is home when the person holding it is the person it belongs to.
  const homeNow = !!holderId && holderId === book.ownerId;
  const readers = new Set(loans.map((l) => l.borrowerId).filter(Boolean));
  const cover = safeImageUrl(book.coverUrl);

  return (
    <MobileShell withNav={false}>
      <header className="flex items-center gap-2 px-4 pb-3">
        <button onClick={goBack} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[18px] font-bold flex-1 truncate">{t.bookJourney}</h1>
      </header>

      {/* Which book this is about — the screen is reachable from a notification
          as well as from the book, so it names its subject. */}
      <section className="px-4 flex items-center gap-3">
        {cover ? (
          <img
            src={cover}
            alt=""
            className="w-12 h-16 rounded-lg object-cover bg-ink-100 shrink-0"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0">
          <p className="font-semibold text-[15px] truncate">{book.name}</p>
          <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
          <p className="text-[12px] text-ink-500 mt-0.5">
            {t.journeyReaderCount(readers.size)}
          </p>
        </div>
      </section>

      <ol className="px-4 mt-6">
        {/* Stop zero: the book arriving in the community. Every book has this
            one, which is why the empty state below is about *loans*. */}
        <Stop
          person={owner}
          personId={book.ownerId}
          selfId={user?.id}
          label={t.journeyAdded}
          when={formatPostDate(book.createdAt)}
          tone="origin"
        />

        {loans.map((loan, i) => {
          // The rail has to stop at the bottom of the last stop drawn, and
          // whether that is a loan or the "back with its owner" line below
          // depends on where the book is now. A line running past the final dot
          // is a journey that continues somewhere the screen is not showing.
          const lastDrawn = i === loans.length - 1 && !homeNow;
          const started = toMillis(loan.createdAt, 0);
          const ended = toMillis(loan.returnDate, 0);
          const active = loan.status !== "completed";
          const days = spanInDays(started, active ? Date.now() : ended);

          return (
            <Stop
              key={loan.id}
              person={people[loan.borrowerId] ?? null}
              personId={loan.borrowerId}
              selfId={user?.id}
              label={active ? t.journeyReadingNow : t.journeyRead}
              when={
                started
                  ? active
                    ? `${formatPostDate(started)} — ${t.journeyStillOut}`
                    : `${formatPostDate(started)}${ended ? ` — ${formatPostDate(ended)}` : ""}`
                  : ""
              }
              note={days > 0 ? t.journeyDays(days) : null}
              tone={active ? "active" : "past"}
              last={lastDrawn}
            />
          );
        })}

        {/* The closing line. A book on loan already ends on its reader, so this
            only says something when the book is back where it started. */}
        {homeNow && loans.length > 0 ? (
          <Stop
            person={owner}
            personId={book.ownerId}
            selfId={user?.id}
            label={t.journeyHome}
            when=""
            tone="origin"
            last
          />
        ) : null}
      </ol>

      {loans.length === 0 ? (
        <p className="px-6 py-10 text-center text-ink-500 text-[14px]">
          {t.journeyNoLoansYet}
        </p>
      ) : null}

      <div className="h-6" />
    </MobileShell>
  );
}

/** Whole days between two stamps, rounded up — a loan of hours still counts. */
function spanInDays(from, to) {
  if (!from || !to || to < from) return 0;
  return Math.max(1, Math.ceil((to - from) / DAY_MS));
}

/**
 * One stop on the line.
 *
 * The rail is drawn per row rather than as a border on the list, because the
 * first and last rows have to stop it half way: a line running above the first
 * dot or below the last one is a journey that started somewhere else.
 */
function Stop({ person, personId, selfId, label, when, note = null, tone, last = false }) {
  const dot =
    tone === "active" ? "bg-brand-500" : tone === "origin" ? "bg-ink-300" : "bg-ink-300";
  const name = peerName(person);
  const isSelf = !!selfId && personId === selfId;

  const body = (
    <>
      <span className="flex items-center gap-2 min-w-0">
        <Avatar src={person?.photoURL} name={name} size={32} />
        <span className="min-w-0">
          <span className="block text-[14px] font-medium truncate">
            {name}
            {isSelf ? <span className="text-[12px] text-ink-500 ml-1">{t.youMark}</span> : null}
          </span>
          <span className="block text-[12px] text-ink-500 truncate">{label}</span>
        </span>
      </span>
      <span className="text-right shrink-0">
        {when ? <span className="block text-[12px] text-ink-500 tabular-nums">{when}</span> : null}
        {note ? <span className="block text-[11px] text-ink-400">{note}</span> : null}
      </span>
    </>
  );

  return (
    <li className="flex gap-3">
      {/* The rail: a dot with a line under it, except on the last stop. */}
      <span className="flex flex-col items-center shrink-0 pt-3">
        <span className={"w-2.5 h-2.5 rounded-full " + dot} />
        {!last ? <span className="w-px flex-1 bg-ink-100 mt-1" /> : null}
      </span>

      <span className="flex-1 min-w-0 pb-4">
        {person && personId ? (
          <Link
            to={`/users/${personId}`}
            className="flex items-start justify-between gap-3 py-1 active:opacity-70 transition"
          >
            {body}
          </Link>
        ) : (
          // No profile left to open — a deleted account still gets its stop,
          // because it still happened.
          <span className="flex items-start justify-between gap-3 py-1">{body}</span>
        )}
      </span>
    </li>
  );
}
