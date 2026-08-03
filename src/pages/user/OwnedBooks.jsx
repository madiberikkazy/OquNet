import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import BookStatusBadge from "../../components/BookStatusBadge.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBooks } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { isHeldBy } from "../../utils/bookHolder.js";
import { t } from "../../utils/i18n.js";

export default function OwnedBooks() {
  const { user } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();

  // This list and the counter on the profile answer the same question, so they
  // are fetched the same way — same cache family, same staleness rules. When
  // they had separate caches with different lifetimes the count and the list
  // could disagree after a handoff, which reads as the book being in two places.
  const booksQuery = useQuery({
    queryKey: qk.books.heldBy(user?.id, community?.id),
    enabled: !!user?.id && !!community?.id,
    // A book can leave this list because of something someone *else* did, so a
    // cached answer is never trusted on arrival: show it, then correct it.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const result = await listBooks({ communityId: community.id, pageSize: 200 });
      const allBooks = result?.items || result || [];
      // Books currently in this user's hands: their own shelf, plus anything
      // handed to them that nobody has collected yet — finished or not.
      return allBooks.filter((b) => isHeldBy(b, user.id));
    },
  });

  const books = booksQuery.data ?? [];
  const loading = booksQuery.isPending && !!user?.id && !!community?.id;

  return (
    <MobileShell>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 mb-4">
        <button onClick={() => navigate(-1)} className="icon-btn shrink-0" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="font-bold text-[18px]">{t.ownedBooks}</h1>
      </div>

      {loading ? (
        <p className="text-center text-ink-400 text-[14px] mt-10">{t.loading}</p>
      ) : books.length === 0 ? (
        <EmptyState title="Кітаптар жоқ" subtitle="Қазір сізде кітап жоқ." />
      ) : (
        <ul className="px-4 space-y-0 divide-y divide-ink-100">
          {books.map((book) => (
            <li
              key={book.id}
              onClick={() => navigate(`/books/${book.id}`)}
              className="flex items-center gap-3 py-3 cursor-pointer active:bg-ink-100/40 transition rounded-xl px-1"
            >
              {book.coverUrl ? (
                <img src={book.coverUrl} alt={book.name} className="w-10 h-14 rounded-lg object-cover bg-ink-100 shrink-0" />
              ) : (
                <div className="w-10 h-14 rounded-lg bg-ink-100 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[15px] truncate">{book.name}</p>
                <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
                <div className="mt-1"><BookStatusBadge status={book.status} /></div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </li>
          ))}
        </ul>
      )}
    </MobileShell>
  );
}
