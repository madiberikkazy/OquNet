import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import BookCard from "../../components/BookCard.jsx";
import CurrentBookCard from "../../components/CurrentBookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import FollowButton from "../../components/FollowButton.jsx";
import MessageButton from "../../components/MessageButton.jsx";
import ProfileHeader, { CommunityRankChip } from "../../components/ProfileHeader.jsx";
import ProfileStatsRow, { MEMBER_STATS } from "../../components/ProfileStatsRow.jsx";
import ReadingWeek from "../../components/ReadingWeek.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getBook, getBooksByIds, getCommunity, getCommunityReadingRank, getUserById,
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
 * "The same screen" is meant literally, and used not to be. This page had a
 * banner and a reading week in common with the reader's own profile and then
 * diverged: a grid of five coloured cards where the reader's own has a row of
 * counters, no role badge, no card for the book in their hands, and the reading
 * section above the shelves rather than below. Two designs for one object.
 *
 * It is now the reader's own layout, in the reader's own order — header,
 * counters, current book, reading week — built from the same components, with
 * exactly two differences, both of which are about who is looking:
 *
 *   · A counter expands its list in place instead of navigating. Your own
 *     counters open screens because those screens can *act* on the books —
 *     return one, unsave one. Here there is nothing to act on, so five
 *     read-only routes never have to exist.
 *   · There is no reading-timer launcher. That button starts *your* timer, and
 *     it means nothing on somebody else's page.
 */
export default function UserProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: viewer } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("owned");

  const memberQuery = useQuery({
    queryKey: qk.profile.member(id, viewer?.communityId),
    enabled: !!id,
    // Show whatever was cached at once, then correct it. The app's default is
    // not to refetch on mount at all, and the cache outlives the session in
    // IndexedDB — which is fine for shelves and wrong for the follower count,
    // a number other people move while this reader is not looking.
    staleTime: 0,
    refetchOnMount: "always",
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

  // The book this member has open. One active loan at a time is the rule the
  // whole app is built on, so the first is the one — same as the reader's own
  // profile does with the same list.
  const activeBorrowing = lists.reading[0] ?? null;

  // The loan names the book; the book carries the cover, the score and the days
  // allowed. Only worth a read once there is a loan to describe.
  const bookQuery = useQuery({
    queryKey: qk.books.detail(activeBorrowing?.bookId),
    enabled: !!activeBorrowing?.bookId,
    staleTime: 60_000,
    queryFn: () => getBook(activeBorrowing.bookId),
  });

  /**
   * Move the follower count on screen by the same delta the data layer just
   * wrote to the profile document.
   *
   * A patch of the cached profile rather than an invalidate: this key holds
   * five parallel queries' worth of shelves, and refetching all of them to
   * change one integer would make the number arrive late — after the button had
   * already flipped — which is exactly the disagreement it is meant to avoid.
   */
  function bumpFollowers(delta) {
    queryClient.setQueryData(qk.profile.member(id, viewer?.communityId), (prev) => (
      prev?.user
        ? { ...prev, user: { ...prev.user, followersCount: Math.max(0, (prev.user.followersCount ?? 0) + delta) } }
        : prev
    ));
  }

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

  // Every measurement below is the reader's own profile's, deliberately: the two
  // screens are one design, so the spacing is copied rather than re-chosen.
  return (
    <MobileShell>
      <ProfileHeader
        user={member}
        onBack={() => navigate(-1)}
        badge={
          member.role === "admin"
            ? <span className="mt-2 pill bg-brand-50 text-brand-700">{t.communityAdmin}</span>
            : null
        }
        // Following is the one thing you can do to a profile from anywhere —
        // it needs no shared community, no book and no conversation — so it
        // sits in the header with the identity it acts on, directly under the
        // counter it moves.
        action={
          <FollowButton
            userId={member.id}
            onChange={({ delta }) => bumpFollowers(delta)}
          />
        }
      />

      {/* The way into a conversation, and the only one that matters — a chat
          starts from a person, not from a list. Absent on the reader's own
          profile, seen through the search results or a shared link: a chat
          needs two people, and the data layer refuses a self-chat outright. */}
      <div className="px-4 mt-4">
        <MessageButton userId={member.id} />
      </div>

      {/* The counters and the book in their hands are their community's business,
          so both sit behind the same gate the shelves do. */}
      {sameCommunity ? (
        <>
          <div className="px-5 mt-4">
            <ProfileStatsRow
              stats={stats}
              columns={MEMBER_STATS}
              active={selected}
              onSelect={setSelected}
            />
          </div>

          <div className="px-4 mt-5">
            <CurrentBookCard
              borrowing={activeBorrowing}
              book={bookQuery.data}
              emptyTitle={t.memberNoReadingBook}
              emptyHint={null}
            />
          </div>
        </>
      ) : null}

      <div className="px-4 mt-6 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-bold truncate">{t.readingSectionTitle}</h3>
        <CommunityRankChip community={community} rank={rankQuery.data} />
      </div>

      <div className="px-4 mt-2.5">
        <ReadingWeek readingDays={member.readingDays || {}} />
      </div>

      {sameCommunity ? (
        <section className="mt-5">
          <h3 className="section-title px-4 mb-1">{t[SECTION_TITLE_KEY[selected]]}</h3>
          <MemberList kind={selected} items={lists[selected]} onOpen={(bookId) => navigate(`/books/${bookId}`)} />
        </section>
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

// One title per selectable counter. `reading` is absent because it is no longer
// one: the book being read now is the CurrentBookCard above, which names it.
const SECTION_TITLE_KEY = Object.freeze({
  saved:     "saved",
  completed: "completed",
  held:      "memberHeldTitle",
  owned:     "memberOwnedTitle",
});

/**
 * Two shapes behind the four counters: three are books, and `completed` is a
 * list of loans. A loan carries the book's name as it was when it was taken, so
 * it renders without a second fetch per row — which is the reason these are not
 * normalised into book documents first.
 */
function MemberList({ kind, items, onOpen }) {
  if (!items?.length) {
    return <p className="px-4 text-[13px] text-ink-500">{t.nothingHereYet}</p>;
  }

  if (kind === "completed") {
    return (
      <ul className="px-4 divide-y divide-ink-100">
        {items.map((loan) => (
          <li key={loan.id}>
            <button
              onClick={() => onOpen(loan.bookId)}
              className="w-full text-left py-3 active:bg-ink-100/40 transition rounded-xl px-1"
            >
              <p className="font-medium text-[15px] truncate">{loan.bookName || t.book}</p>
              <p className="text-[12px] text-ink-500 mt-0.5">{t.completedLoanLabel}</p>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return <ul>{items.map((b) => (<li key={b.id}><BookCard book={b} /></li>))}</ul>;
}
