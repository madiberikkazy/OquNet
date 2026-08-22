import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import CurrentBookCard from "../../components/CurrentBookCard.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import FollowButton from "../../components/FollowButton.jsx";
import MessageButton from "../../components/MessageButton.jsx";
import PostCard from "../../components/PostCard.jsx";
import ProfileHeader, { CommunityRankChip } from "../../components/ProfileHeader.jsx";
import ProfileStatsRow, { MEMBER_STATS } from "../../components/ProfileStatsRow.jsx";
import ReadingWeek from "../../components/ReadingWeek.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { getBook, getCommunityReadingRank } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { useMemberProfile, EMPTY_LISTS } from "../../utils/useMemberProfile.js";
import { t } from "../../utils/i18n.js";

/**
 * Another member's profile — the same screen as the reader's own, seen from
 * outside.
 *
 * "The same screen" is meant literally. It is the reader's own layout, in the
 * reader's own order — header, counters, current book, reading week — built
 * from the same components, with the differences all being about who is
 * looking:
 *
 *   · Two buttons the reader's own profile has no use for: follow, and a way
 *     into a conversation.
 *   · No reading-timer launcher. That button starts *your* timer, and it means
 *     nothing on somebody else's page.
 *   · The current-book card is drawn only when there is a book to name. On your
 *     own profile its empty state is an instruction — open the library, borrow
 *     one — and an instruction addressed to somebody who is not reading this
 *     screen is a blank card in the best part of their profile.
 *   · Their posts, under the reading week: it is the one part of a profile that
 *     is theirs to say rather than counted about them.
 */
export default function UserProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: viewer } = useAuth();
  const queryClient = useQueryClient();

  const memberQuery = useMemberProfile(id, viewer);

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
   * several parallel queries' worth of shelves, and refetching all of them to
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
        postsCount={lists.posts.length}
        badge={
          member.role === "admin"
            ? <span className="mt-2 pill bg-brand-50 text-brand-700">{t.communityAdmin}</span>
            : null
        }
        // The two things a reader can do with a person, side by side and equal
        // width. Following is the one this app wants to be easy — it needs no
        // shared community, no book and no conversation — so it keeps the
        // brand colour and the left, reading position; the message button is
        // grey beside it rather than a second thing shouting the same volume.
        action={
          <div className="flex items-stretch gap-2">
            <FollowButton
              userId={member.id}
              className="flex-1"
              onChange={({ delta }) => bumpFollowers(delta)}
            />
            <MessageButton userId={member.id} className="flex-1" />
          </div>
        }
      />

      {/* The counters and the book in their hands are their community's business,
          so both sit behind the same gate the shelves do. */}
      {sameCommunity ? (
        <>
          <div className="px-5 mt-4">
            <ProfileStatsRow
              stats={stats}
              columns={MEMBER_STATS}
              onSelect={(kind) => navigate(`/users/${member.id}/books/${kind}`)}
            />
          </div>

          {activeBorrowing ? (
            <div className="px-4 mt-5">
              <CurrentBookCard borrowing={activeBorrowing} book={bookQuery.data} />
            </div>
          ) : null}
        </>
      ) : null}

      <div className="px-4 mt-6 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-bold truncate">{t.readingSectionTitle}</h3>
        <CommunityRankChip community={community} rank={rankQuery.data} />
      </div>

      <div className="px-4 mt-2.5">
        <ReadingWeek readingDays={member.readingDays || {}} />
      </div>

      {/* What they have written. Below the reading week because that is where
          the counted part of a profile ends and the said part begins — and it
          is drawn for everybody, member of the same community or not: a post
          carries its own audience, so whatever is in this list is already
          something this reader was allowed to see. */}
      {lists.posts.length > 0 ? (
        <section className="mt-6">
          <h3 className="section-title px-4 mb-1">{t.postsLabel}</h3>
          <ul>
            {lists.posts.map((p) => (
              <li key={p.id}>
                <PostCard post={p} community={community} likeCount={p.likeCount || 0} likeDisabled />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!sameCommunity ? (
        <div className="px-4 mt-5">
          <div className="card px-4 py-5 text-center">
            <p className="text-[14px] text-ink-500">{t.otherCommunityBooksHidden}</p>
          </div>
        </div>
      ) : null}

      <div className="h-4" />
    </MobileShell>
  );
}
