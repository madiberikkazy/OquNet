import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import CurrentBookCard from "../../components/CurrentBookCard.jsx";
import ProfileHeader, { CommunityRankChip } from "../../components/ProfileHeader.jsx";
import ProfileStatsRow, { PROFILE_STATS } from "../../components/ProfileStatsRow.jsx";
import ReadingWeek from "../../components/ReadingWeek.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  getBook, getCommunityReadingRank, listBooksHeldBy, listBorrowingsForUser,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import {
  READING_MINUTES_DEFAULT, READING_MINUTES_MAX, READING_MINUTES_MIN, READING_MINUTE_STEP,
  readingStreak,
} from "../../utils/readingProgress.js";
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
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error("profile.stats", r.reason?.message, {
            code: r.reason?.code,
            source: ["active", "completed", "held"][i],
          });
        }
      });
      const [readingList, completed, held] = results.map((r) =>
        r.status === "fulfilled" ? r.value : null
      );
      return {
        stats: {
          saved: (user.savedBookIds || []).length,
          completed: completed?.length ?? 0,
          held: held?.length ?? 0,
        },
        activeBorrowing: readingList?.[0] || null,
      };
    },
  });

  const activeBorrowing = statsQuery.data?.activeBorrowing ?? null;

  // The loan says which book and when it started; the book document carries the
  // cover, the score and the days allowed. Two reads, so the card is only worth
  // making once there is actually a loan to describe.
  const bookQuery = useQuery({
    queryKey: qk.books.detail(activeBorrowing?.bookId),
    enabled: !!activeBorrowing?.bookId,
    staleTime: 60_000,
    queryFn: () => getBook(activeBorrowing.bookId),
  });

  // Standing in the community. Its own query rather than a fourth branch of the
  // one above: it depends on other people's reading as much as this reader's,
  // and is the one number on the screen that is fine to show a minute stale.
  const rankQuery = useQuery({
    queryKey: qk.reading.rank(community?.id, user?.id),
    enabled: !!user?.id && !!community?.id,
    staleTime: 60_000,
    queryFn: () => getCommunityReadingRank({ communityId: community.id, userId: user.id }),
  });

  const stats = statsQuery.data?.stats ?? DEFAULT_STATS;
  const readingDays = user?.readingDays || {};

  return (
    <MobileShell>
      {/* Nothing about the admin view lives on this screen any more. Switching
          between admin and reader is a settings decision, reached through the
          gear in the banner — a mode switch sitting in the middle of a profile
          was one mis-tap away from silently changing the whole app. */}
      <ProfileHeader
        user={user}
        showSettings
        badge={isAdmin ? <span className="mt-2 pill bg-brand-50 text-brand-700">{t.communityAdmin}</span> : null}
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

      <div className="px-4 mt-5">
        <CurrentBookCard borrowing={activeBorrowing} book={bookQuery.data} />
      </div>

      <div className="px-4 mt-6 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-bold truncate">{t.readingSectionTitle}</h3>
        <CommunityRankChip community={community} rank={rankQuery.data} />
      </div>

      <div className="px-4 mt-2.5">
        <ReadingWeek readingDays={readingDays} />
      </div>

      <div className="px-4 mt-3">
        <ReadingLauncher
          readingDays={readingDays}
          onStart={(minutes) => navigate(
            `/profile/timer?minutes=${minutes}` +
            (activeBorrowing?.bookId ? `&book=${encodeURIComponent(activeBorrowing.bookId)}` : "")
          )}
        />
      </div>

      <div className="h-4" />
    </MobileShell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function routeFor(kind) {
  return PROFILE_STATS.find((s) => s.key === kind)?.route ?? "/profile";
}

/**
 * "Оқу ▶  −  30  +" — pick a length and start the timer.
 *
 * The length lives here rather than in the timer screen so it can be chosen and
 * changed without leaving the profile, and it travels in the URL so the timer
 * has no state of its own to get out of step with this.
 */
function ReadingLauncher({ readingDays, onStart }) {
  const [minutes, setMinutes] = useState(READING_MINUTES_DEFAULT);
  const streak = readingStreak(readingDays);

  const step = (delta) => setMinutes((m) =>
    Math.min(READING_MINUTES_MAX, Math.max(READING_MINUTES_MIN, m + delta))
  );

  return (
    <div className="rounded-2xl bg-tint px-3 py-2.5 flex items-center justify-between gap-3">
      <button
        onClick={() => onStart(minutes)}
        className="flex items-center gap-2 min-w-0 active:scale-[0.98] transition"
      >
        <span className="text-[20px] font-bold text-tintInk">{t.readAction}</span>
        <span className="w-8 h-8 rounded-full bg-brand-500 text-white inline-flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5-11-6.5Z" />
          </svg>
        </span>
        {streak > 0 ? (
          <span className="text-[12px] text-ink-500 truncate">{t.streakLabel(streak)}</span>
        ) : null}
      </button>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => step(-READING_MINUTE_STEP)}
          disabled={minutes <= READING_MINUTES_MIN}
          className="w-8 h-8 rounded-full bg-brand-500 text-white text-[20px] leading-none inline-flex items-center justify-center disabled:opacity-40 active:scale-95 transition"
          aria-label={t.decrease}
        >
          −
        </button>
        <span className="text-[22px] font-bold tabular-nums w-9 text-center">{minutes}</span>
        <button
          onClick={() => step(READING_MINUTE_STEP)}
          disabled={minutes >= READING_MINUTES_MAX}
          className="w-8 h-8 rounded-full bg-brand-500 text-white text-[20px] leading-none inline-flex items-center justify-center disabled:opacity-40 active:scale-95 transition"
          aria-label={t.increase}
        >
          +
        </button>
      </div>
    </div>
  );
}
