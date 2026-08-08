import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import ProfileHeader from "../../components/ProfileHeader.jsx";
import ProfileStatCards, { statRoute } from "../../components/ProfileStatCards.jsx";
import ReadingHeatmap from "../../components/ReadingHeatmap.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  getCommunityReadingRank, listBooksOwnedBy, listBorrowingsForUser, listBooksHeldBy,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import {
  READING_MINUTES_DEFAULT, READING_MINUTES_MAX, READING_MINUTES_MIN, READING_MINUTE_STEP,
  readingStreak,
} from "../../utils/readingProgress.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

const DEFAULT_STATS = { held: 0, reading: 0, completed: 0, saved: 0, owned: 0 };

export default function Profile() {
  const { user, isAdmin, isViewingAsUser, switchView } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();

  // Stats are four parallel fetches that then combine — allSettled keeps wall
  // time to the slowest request, and keeps one failing fetch from zeroing the
  // counters that did load.
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
        // What belongs to them, which is a different question — a lent-out book
        // is still theirs.
        listBooksOwnedBy({ communityId: community?.id, userId: user.id }),
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error("profile.stats", r.reason?.message, {
            code: r.reason?.code,
            source: ["active", "completed", "held", "owned"][i],
          });
        }
      });
      const [readingList, completed, held, owned] = results.map((r) =>
        r.status === "fulfilled" ? r.value : null
      );
      const savedIds = user.savedBookIds || [];
      return {
        stats: {
          held: held?.length ?? 0,
          reading: readingList?.length ?? 0,
          completed: completed?.length ?? 0,
          saved: savedIds.length,
          owned: owned?.length ?? 0,
        },
        activeBorrowing: readingList?.[0] || null,
      };
    },
  });

  // Standing in the community. Its own query rather than a fifth branch of the
  // one above: it reads a different collection, changes on other people's
  // activity as much as this reader's, and is the one number on the screen that
  // is fine to show a minute stale.
  const rankQuery = useQuery({
    queryKey: qk.reading.rank(community?.id, user?.id),
    enabled: !!user?.id && !!community?.id,
    staleTime: 60_000,
    queryFn: () => getCommunityReadingRank({ communityId: community.id, userId: user.id }),
  });

  const stats = statsQuery.data?.stats ?? DEFAULT_STATS;
  const activeBorrowing = statsQuery.data?.activeBorrowing ?? null;
  const readingDays = user?.readingDays || {};

  return (
    <MobileShell>
      <ProfileHeader
        user={user}
        community={community}
        rank={rankQuery.data}
        showSettings
        badge={isAdmin ? <span className="mt-2 pill bg-brand-50 text-brand-700">{t.communityAdmin}</span> : null}
      />

      {isViewingAsUser && (
        <div className="mx-4 mt-3 px-4 py-2.5 bg-brand-50 border border-brand-200 rounded-2xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-500 flex-shrink-0">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span className="text-[13px] text-brand-700 font-medium">{t.viewingAsUser}</span>
          </div>
          <button onClick={switchView} className="text-[12px] font-semibold text-brand-600 underline underline-offset-2 whitespace-nowrap">
            {t.exit}
          </button>
        </div>
      )}

      {!community && (
        <div className="px-4 mt-4">
          <Link to="/community/join" className="btn-primary block text-center">{t.findCommunity}</Link>
        </div>
      )}

      <div className="px-4 mt-4">
        <ReadingHeatmap readingDays={readingDays} />
      </div>

      <div className="px-4 mt-3">
        <ReadingLauncher
          readingDays={readingDays}
          onStart={(minutes) => navigate(`/profile/timer?minutes=${minutes}`)}
        />
      </div>

      <div className="px-4 mt-4">
        <ProfileStatCards
          stats={stats}
          note={{ reading: activeBorrowing?.bookName }}
          onSelect={(kind) => navigate(statRoute(kind))}
        />
      </div>

      {/* Admin switch-back banner */}
      {isViewingAsUser && (
        <div className="px-4 mt-4">
          <button
            onClick={switchView}
            className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-brand-50 border border-brand-200 hover:bg-brand-100 transition active:scale-[0.99]"
          >
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-xl bg-surface flex items-center justify-center shadow-sm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              <div className="text-left">
                <p className="text-[14px] font-semibold text-brand-900">{t.switchToAdminView}</p>
                <p className="text-[12px] text-brand-600">{t.switchToAdminViewHint}</p>
              </div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-400 flex-shrink-0">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div className="h-4" />
    </MobileShell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

/**
 * "Read ▶  −  30  +" — pick a length and start the timer.
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
    <div className="rounded-2xl bg-brand-50 px-3 py-2.5 flex items-center justify-between gap-3">
      <button
        onClick={() => onStart(minutes)}
        className="flex items-center gap-2 min-w-0 active:scale-[0.98] transition"
      >
        <span className="text-[20px] font-bold text-brand-700">{t.readAction}</span>
        <span className="w-8 h-8 rounded-full bg-brand-500 text-white inline-flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5-11-6.5Z" />
          </svg>
        </span>
        {streak > 0 ? (
          <span className="text-[12px] text-brand-600 truncate">{t.streakLabel(streak)}</span>
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
