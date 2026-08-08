import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import BookCard from "../../components/BookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import ProfileHeader, { CommunityRankChip } from "../../components/ProfileHeader.jsx";
import ProfileStatCards from "../../components/ProfileStatCards.jsx";
import ReadingWeek from "../../components/ReadingWeek.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getBooksByIds, getCommunity, getCommunityReadingRank, getUserById,
  listBooksHeldBy, listBooksOwnedBy, listBorrowingsForUser,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

const EMPTY_LISTS = { held: [], owned: [], reading: [], completed: [], saved: [] };

/**
 * Another member's profile — the same screen as the reader's own, seen from
 * outside.
 *
 * It shows everything the design puts on a profile: the week's reading, the
 * standing in the community, and all five shelves. The one structural
 * difference is what a counter does when tapped. On your own profile it opens a
 * screen, because those screens can act on the books — return one, unsave one.
 * Here there is nothing to act on, so the counter expands its list in place
 * instead, and five more routes that would each render a read-only list never
 * have to exist.
 */
export default function UserProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: viewer } = useAuth();
  const [selected, setSelected] = useState("owned");

  const memberQuery = useQuery({
    queryKey: qk.profile.member(id, viewer?.communityId),
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const user = await getUserById(id);
      if (!user) return null;

      const community = user.communityId ? await getCommunity(user.communityId) : null;

      // Who somebody is is public; what is on their shelf is their community's
      // business. Asking anyway would just be a denied query, so don't ask.
      const sameCommunity = !!user.communityId && viewer?.communityId === user.communityId;
      if (!sameCommunity) return { user, community, lists: EMPTY_LISTS, sameCommunity };

      // One indexed query per question. This used to ask for a single page of
      // the community's books and sift it here, so a member whose books all sat
      // past the first thirty appeared to own nothing at all.
      const results = await Promise.allSettled([
        listBooksHeldBy({ communityId: user.communityId, userId: user.id }),
        listBooksOwnedBy({ communityId: user.communityId, userId: user.id }),
        listBorrowingsForUser(user.id, "active"),
        listBorrowingsForUser(user.id, "completed"),
        // Saved ids can outlive the community they were saved in, and a book is
        // readable only to members of its own — getBooksByIds drops the misses
        // rather than failing the batch.
        getBooksByIds(user.savedBookIds || []),
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error("userProfile.lists", r.reason?.message, {
            code: r.reason?.code,
            source: ["held", "owned", "reading", "completed", "saved"][i],
          });
        }
      });
      const [held, owned, reading, completed, saved] = results.map((r) =>
        r.status === "fulfilled" ? r.value : []
      );
      return { user, community, sameCommunity, lists: { held, owned, reading, completed, saved } };
    },
  });

  const member = memberQuery.data?.user ?? null;
  const community = memberQuery.data?.community ?? null;
  const sameCommunity = memberQuery.data?.sameCommunity ?? false;
  const lists = memberQuery.data?.lists ?? EMPTY_LISTS;

  const rankQuery = useQuery({
    queryKey: qk.reading.rank(member?.communityId, member?.id),
    enabled: !!member?.id && !!member?.communityId,
    staleTime: 60_000,
    queryFn: () => getCommunityReadingRank({ communityId: member.communityId, userId: member.id }),
  });

  if (memberQuery.isLoading) {
    return <MobileShell><p className="px-6 py-12 text-center text-ink-500">{t.loading}</p></MobileShell>;
  }
  if (!member) {
    return (
      <MobileShell>
        <EmptyState title={t.userNotFound} subtitle={t.userNotFoundHint} />
      </MobileShell>
    );
  }

  const stats = {
    held: lists.held.length,
    owned: lists.owned.length,
    reading: lists.reading.length,
    completed: lists.completed.length,
    saved: lists.saved.length,
  };

  return (
    <MobileShell>
      <ProfileHeader user={member} onBack={() => navigate(-1)} />

      <div className="px-4 mt-5 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-bold truncate">{t.readingSectionTitle}</h3>
        <CommunityRankChip community={community} rank={rankQuery.data} />
      </div>

      <div className="px-4 mt-2.5">
        <ReadingWeek readingDays={member.readingDays || {}} />
      </div>

      {sameCommunity ? (
        <>
          <div className="px-4 mt-4">
            <ProfileStatCards stats={stats} active={selected} onSelect={setSelected} />
          </div>
          <section className="mt-5">
            <h3 className="section-title px-4 mb-1">{t[SECTION_TITLE_KEY[selected]]}</h3>
            <MemberList kind={selected} items={lists[selected]} onOpen={(bookId) => navigate(`/books/${bookId}`)} />
          </section>
        </>
      ) : (
        // Not a permissions error to apologise for — the shelves of a community
        // you are not in are simply not yours to read.
        <div className="px-4 mt-5">
          <div className="card px-4 py-5 text-center">
            <p className="text-[14px] text-ink-500">{t.otherCommunityBooksHidden}</p>
          </div>
        </div>
      )}

      <div className="h-4" />
    </MobileShell>
  );
}

const SECTION_TITLE_KEY = Object.freeze({
  held:      "memberHeldTitle",
  owned:     "memberOwnedTitle",
  reading:   "memberReadingTitle",
  completed: "completed",
  saved:     "saved",
});

/**
 * Two shapes behind five counters: three of them are books, two are loans. A
 * loan carries the book's name at the time it was taken, so it renders without
 * a second fetch per row — which is the reason these are not normalised into
 * book documents first.
 */
function MemberList({ kind, items, onOpen }) {
  if (!items?.length) {
    return <p className="px-4 text-[13px] text-ink-500">{t.nothingHereYet}</p>;
  }

  if (kind === "reading" || kind === "completed") {
    return (
      <ul className="px-4 divide-y divide-ink-100">
        {items.map((loan) => (
          <li key={loan.id}>
            <button
              onClick={() => onOpen(loan.bookId)}
              className="w-full text-left py-3 active:bg-ink-100/40 transition rounded-xl px-1"
            >
              <p className="font-medium text-[15px] truncate">{loan.bookName || t.book}</p>
              <p className="text-[12px] text-ink-500 mt-0.5">
                {kind === "completed" ? t.completedLoanLabel : t.activeLoanLabel}
              </p>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return <ul>{items.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>;
}
