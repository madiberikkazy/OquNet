import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import BookCard from "../../components/BookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBooksOwnedBy } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { t } from "../../utils/i18n.js";

/**
 * The books this reader owns — everything they put into the community, whoever
 * happens to be holding it.
 *
 * The neighbouring screen, /profile/owned, answers the other question: what is
 * physically with them right now. Lending a book out removes it from that list
 * and leaves it on this one, which is the distinction the two counters on the
 * profile are drawing.
 */
export default function MyBooks() {
  const { user } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();

  const booksQuery = useQuery({
    queryKey: qk.books.ownedBy(user?.id, community?.id),
    enabled: !!user?.id && !!community?.id,
    // Ownership only moves by an admin's deliberate correction, so a cached
    // answer is safe to show — but a book added since it was cached is not
    // something the owner should have to hunt for.
    staleTime: 60_000,
    queryFn: () => listBooksOwnedBy({ communityId: community.id, userId: user.id }),
  });

  const books = booksQuery.data ?? [];

  return (
    <MobileShell>
      <div className="flex items-center gap-3 px-4 mb-2">
        <button onClick={() => navigate(-1)} className="icon-btn shrink-0" aria-label={t.back}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="font-bold text-[18px]">{t.ownerBooksCard}</h1>
        {books.length > 0 && (
          <span className="ml-auto text-[13px] text-ink-500 font-medium">{books.length}</span>
        )}
      </div>

      {booksQuery.isLoading ? (
        <p className="text-center text-ink-500 text-[14px] mt-10">{t.loading}</p>
      ) : books.length === 0 ? (
        <EmptyState title={t.ownerBooksEmpty} subtitle={t.ownerBooksEmptyHint} />
      ) : (
        <ul>{books.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>
      )}
    </MobileShell>
  );
}
