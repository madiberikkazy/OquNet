import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import BookCard from "../../components/BookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useMemberProfile, EMPTY_LISTS } from "../../utils/useMemberProfile.js";
import { peerName } from "../../utils/chatPeer.js";
import { t } from "../../utils/i18n.js";

/** The three counters on a member's profile, and what each one opens. */
const KINDS = Object.freeze({
  saved:     { titleKey: "saved" },
  completed: { titleKey: "completed" },
  held:      { titleKey: "memberHeldTitle" },
});

/**
 * One of another member's shelves, on a page of its own.
 *
 * These lists used to unfold underneath the profile, on the argument that a
 * member's shelves have nothing to act on and so deserve no routes. Reading it
 * back on a phone settles the argument the other way: the profile is already a
 * long screen, and a list opening halfway down it pushes the thing you were
 * looking at off the top while giving the list itself a third of the height it
 * needs. A shelf is a list of books; a list of books is a screen.
 *
 * It shares the profile's query and cache key, so arriving here draws instantly
 * from what the profile already loaded, and the count on the counter cannot
 * disagree with the list it opened — they are the same array.
 */
export default function MemberBooks() {
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const { user: viewer } = useAuth();

  const memberQuery = useMemberProfile(id, viewer);
  const member = memberQuery.data?.user ?? null;
  const lists = memberQuery.data?.lists ?? EMPTY_LISTS;
  const sameCommunity = memberQuery.data?.sameCommunity ?? false;

  const spec = KINDS[kind] ?? null;
  const items = spec ? lists[kind] ?? [] : [];

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-bold truncate">{spec ? t[spec.titleKey] : t.book}</h1>
          {member ? <p className="text-[13px] text-ink-500 truncate">{peerName(member)}</p> : null}
        </div>
      </div>

      {memberQuery.isLoading ? (
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      ) : !member || !spec ? (
        <EmptyState title={t.userNotFound} subtitle={t.userNotFoundHint} />
      ) : !sameCommunity ? (
        // Not a permissions error to apologise for — the shelves of a community
        // you are not in are simply not yours to read.
        <div className="px-4">
          <div className="card px-4 py-5 text-center">
            <p className="text-[14px] text-ink-500">{t.otherCommunityBooksHidden}</p>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.nothingHereYet}</p>
      ) : kind === "completed" ? (
        /* Loans, not books. A loan carries the book's name as it was when it was
           taken, so a finished-reading list renders without a fetch per row —
           which is the reason these are not normalised into books first. */
        <ul className="px-4 divide-y divide-ink-100">
          {items.map((loan) => (
            <li key={loan.id}>
              <button
                onClick={() => navigate(`/books/${loan.bookId}`)}
                className="w-full text-left py-3 active:bg-ink-100/40 transition rounded-xl px-1"
              >
                <p className="font-medium text-[15px] truncate">{loan.bookName || t.book}</p>
                <p className="text-[12px] text-ink-500 mt-0.5">{t.completedLoanLabel}</p>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul>{items.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>
      )}
    </MobileShell>
  );
}
