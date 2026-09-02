import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import CurrentBookCard from "../../components/CurrentBookCard.jsx";
import ProfileHeader, {
  ProfileCommunityAction, ShareProfileAction,
} from "../../components/ProfileHeader.jsx";
import ProfileStatsRow, { PROFILE_STATS } from "../../components/ProfileStatsRow.jsx";
import ReadingProgressCard from "../../components/ReadingProgressCard.jsx";
import MeetupFeed from "../../components/MeetupFeed.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  getBook, getCommunityReadingRank, listBooksHeldBy, listBorrowingsForUser,
  listPostsByAuthor, watchCoReaders,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

const DEFAULT_STATS = { saved: 0, completed: 0, held: 0 };

export default function Profile() {
  const { user, isAdmin, refresh } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();

  // Re-read the profile whenever this screen is opened.
  //
  // `followersCount` is the one number here that other people move: somebody
  // following you changes your profile document, and nothing tells this app
  // about it. The signed-in profile is otherwise loaded once, at sign-in, so
  // without this the counter under your own name could sit at zero for as long
  // as the app stays open. One document read per visit to your own profile.
  //
  // Deliberately empty deps: `refresh` is rebuilt on every user change, so
  // depending on it would make this loop forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, []);

  // Three parallel fetches that then combine — allSettled keeps wall time to the
  // slowest request, and keeps one failing fetch from zeroing the counters that
  // did load. The active loan comes back from the same query as the counter it
  // feeds, so the number and the book named beside it always agree.
  const statsQuery = useQuery({
    queryKey: qk.profile.stats(user?.id, community?.id),
    enabled: !!user?.id,
    // These counters are the screen's whole point, and the query cache is
    // persisted to IndexedDB — without this, a count captured before the user
    // borrowed a book survives app restarts and only ever refreshes on window
    // focus. Show the cached number instantly, correct it in the background.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const results = await Promise.allSettled([
        listBorrowingsForUser(user.id, "active"),
        listBorrowingsForUser(user.id, "completed"),
        // Books currently in this user's hands: their own shelf, plus anything
        // handed to them that nobody has taken on yet. An indexed query on
        // `holderId` returns exactly those, so the counter no longer depends on
        // them falling inside the community's first two hundred books.
        listBooksHeldBy({ communityId: community?.id, userId: user.id }),
        // What this reader has written. Rides along with the counters rather
        // than getting a query of its own: it is one more number on the same
        // screen, and it is wrong for it to arrive at a different time.
        listPostsByAuthor({ authorId: user.id, communityId: community?.id }),
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error("profile.stats", r.reason?.message, {
            code: r.reason?.code,
            source: ["active", "completed", "held", "posts"][i],
          });
        }
      });
      const [readingList, completed, held, posts] = results.map((r) =>
        r.status === "fulfilled" ? r.value : null
      );
      return {
        stats: {
          saved: (user.savedBookIds || []).length,
          completed: completed?.length ?? 0,
          held: held?.length ?? 0,
        },
        // Null rather than zero when the query failed: the header draws a dash
        // for "not known", and "0 posts" is a different claim from "no answer".
        postsCount: posts?.length ?? null,
        activeBorrowing: readingList?.[0] || null,
      };
    },
  });

  const activeBorrowing = statsQuery.data?.activeBorrowing ?? null;

  // Standing in the community. Its own query rather than another branch of the
  // one above: it depends on other people's reading as much as this reader's,
  // and it is the one number here that is fine a minute stale.
  const rankQuery = useQuery({
    queryKey: qk.reading.rank(community?.id, user?.id),
    enabled: !!user?.id && !!community?.id,
    staleTime: 60_000,
    queryFn: () => getCommunityReadingRank({ communityId: community.id, userId: user.id }),
  });

  // Who is in the reading room right now. Live, because the whole point of the
  // row on that card is that it is true at the moment you look at it — three
  // faces and a count that were right ten minutes ago say nothing.
  const [coReaders, setCoReaders] = useState([]);
  useEffect(() => {
    if (!community?.id) return undefined;
    return watchCoReaders(community.id, {
      onRows: setCoReaders,
      onError: (err) => logger.error("profile.coReaders", err?.message, { code: err?.code }),
    });
  }, [community?.id]);

  // The loan says which book and when it started; the book document carries the
  // cover, the score and the days allowed. Two reads, so the card is only worth
  // making once there is actually a loan to describe.
  const bookQuery = useQuery({
    queryKey: qk.books.detail(activeBorrowing?.bookId),
    enabled: !!activeBorrowing?.bookId,
    staleTime: 60_000,
    queryFn: () => getBook(activeBorrowing.bookId),
  });

  const stats = statsQuery.data?.stats ?? DEFAULT_STATS;

  return (
    <MobileShell>
      {/* Nothing about the admin view lives on this screen any more. Switching
          between admin and reader is a settings decision, reached through the
          gear in the banner — a mode switch sitting in the middle of a profile
          was one mis-tap away from silently changing the whole app. */}
      <ProfileHeader
        user={user}
        showSettings
        postsCount={statsQuery.data?.postsCount ?? null}
        badge={isAdmin ? <span className="mt-2 pill bg-brand-50 text-brand-700">{t.communityAdmin}</span> : null}
        // The same row somebody else's profile draws, with the two halves that
        // only make sense about a stranger swapped for the two that make sense
        // about yourself: you cannot follow or message yourself, but where you
        // read and handing somebody your profile are both real answers.
        action={
          <div className="flex items-stretch gap-2">
            <ProfileCommunityAction community={community} className="flex-1" />
            <ShareProfileAction user={user} className={community ? "flex-1" : "w-full"} />
          </div>
        }
      />

      <div className="px-5 mt-4">
        <ProfileStatsRow
          stats={stats}
          onSelect={(kind) => navigate(routeFor(kind))}
        />
      </div>

      {!community && (
        <div className="px-4 mt-4">
          <Link to="/community/join" className="btn-primary block text-center">{t.findCommunity}</Link>
        </div>
      )}

      {/* Only when there is a book to name. The empty state this used to draw
          told the reader to go and borrow one, which is a whole card of the best
          part of the profile spent on an instruction — and the library is two
          taps away in the tab bar whether or not a card says so. Somebody else's
          profile has always been drawn this way; this is the same rule, applied
          to the screen that was the exception. */}
      {activeBorrowing ? (
        <div className="px-4 mt-5">
          <CurrentBookCard borrowing={activeBorrowing} book={bookQuery.data} />
        </div>
      ) : null}

      <div className="px-4 mt-6">
        <h3 className="text-[17px] font-bold truncate">{t.readingSectionTitle}</h3>
      </div>

      {/* One card, and it is the whole of reading on this screen now.
          
          The week's level-and-bars card and the "Читать ▶ − 30 +" launcher both
          stood here as well, which meant three progress bars in a column
          measuring three different windows, and two different ways to start
          reading. Reading now begins in the room — see the button on the card
          — so the launcher had nothing left to launch that the card does not. */}
      <div className="px-4 mt-2.5">
        <ReadingProgressCard
          readingSeconds={user?.readingSeconds ?? 0}
          rank={rankQuery.data}
          readers={coReaders}
        />
      </div>

      {/* Who is looking for company in a real place, and whichever arrangement
          you are part of yourself.

          This is where an offline invitation lands — there is no notification
          for one, deliberately, and MeetupFeed explains why at length: an
          invitation to be somewhere at four o'clock is a fact about right now,
          and an inbox is the wrong shape for something that stops being true.
          It draws nothing when there is nothing, so on most visits this is not
          a section at all. */}
      <MeetupFeed user={user} communityId={community?.id} className="px-4 mt-6" />

      <div className="h-4" />
    </MobileShell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function routeFor(kind) {
  return PROFILE_STATS.find((s) => s.key === kind)?.route ?? "/profile";
}

