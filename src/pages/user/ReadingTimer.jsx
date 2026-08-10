import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listReadingSessions, logReadingSession } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import {
  MIN_SESSION_SECONDS,
  READING_MINUTES_DEFAULT, READING_MINUTES_MAX, READING_MINUTES_MIN,
  dayKey, formatDuration,
} from "../../utils/readingProgress.js";
import { playTimerSound, primeTimerSound, stopTimerSound } from "../../utils/notificationService.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

// ── Why the clock is not a counter ───────────────────────────────────────────
// Elapsed time is derived from `Date.now()` against the moment the run started,
// never accumulated a tick at a time. A backgrounded tab throttles its timers to
// once a second or stops them altogether, so a counter that adds 100ms per tick
// finishes a "30 minute" session forty minutes later, having under-counted every
// minute the phone was asleep. The interval below only decides how often the
// screen repaints; the number it paints comes from the wall clock.
const TICK_MS = 200;

export default function ReadingTimer() {
  const { user, setUser } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();

  const durationMinutes = clampRequestedMinutes(params.get("minutes"));
  const durationMs = durationMinutes * 60_000;
  // Which book the reader is sitting down with, handed over by the profile so
  // this screen does not spend a read re-deriving what the caller already knew.
  // Recorded on the session row and nothing else — it names a book, it does not
  // grant anything, so an edited URL only mislabels the reader's own log.
  const activeBookId = params.get("book") || null;

  // `startedAt` is when the current running stretch began; `bankedMs` is
  // everything from the stretches before it. Pausing moves one into the other,
  // which is what makes pause-and-resume exact rather than approximate.
  const [startedAt, setStartedAt] = useState(null);
  const [bankedMs, setBankedMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");

  // When the whole run began — the session's `startedAt`, which is not the same
  // as the current stretch's and survives every pause.
  const runStartRef = useRef(null);
  // How much of this run has already been written down, and where the next
  // unwritten stretch starts. A run is no longer logged once at the end: it is
  // banked as it goes, and these two are what keep repeated commits from
  // double-counting or losing the gap between them.
  const committedMsRef = useRef(0);
  const segmentStartRef = useRef(null);

  const running = startedAt != null;
  const elapsedMs = Math.min(durationMs, bankedMs + (running ? Math.max(0, nowMs - startedAt) : 0));
  const remainingMs = Math.max(0, durationMs - elapsedMs);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const todaySessions = useQuery({
    queryKey: qk.reading.sessions(user?.id),
    enabled: !!user?.id,
    queryFn: () => listReadingSessions({ userId: user.id, pageSize: 5 }),
  });

  /**
   * Bank whatever has been read but not yet written down.
   *
   * Called on every way out of a run — finishing, Stop, leaving the screen, and
   * the app being hidden — and safe to call as often as any of those happen,
   * because it writes the *delta* since the last successful write rather than
   * the run so far. Reading for an hour and then having the phone killed used
   * to lose the hour: nothing was recorded until the reader came back to this
   * screen and ended the run themselves, and a backgrounded tab that never
   * returns never does.
   *
   * The floor is the server's, not a preference: the security rules refuse a
   * session row under `MIN_SESSION_SECONDS`, so a smaller delta is held back
   * rather than sent to be rejected. It is not lost — it stays uncommitted and
   * rides along with the next stretch. Only a final tail under half a minute
   * goes unrecorded, which is the same rule a short run has always been held to.
   */
  const commit = useCallback(async (totalMs) => {
    if (!user?.id) return null;
    const seconds = Math.floor((totalMs - committedMsRef.current) / 1000);
    if (seconds < MIN_SESSION_SECONDS) return null;

    // Reserve the stretch before the await, so a second caller landing while
    // this one is in flight cannot claim the same seconds.
    committedMsRef.current += seconds * 1000;
    const endedAt = Date.now();
    const startedAt = segmentStartRef.current ?? runStartRef.current ?? endedAt - seconds * 1000;
    try {
      const { patch } = await logReadingSession({
        userId: user.id,
        communityId: community?.id ?? null,
        // Which book the time went into, when there is one on loan. The session
        // log can then answer "how long did this book take"; nothing could
        // reconstruct it afterwards.
        bookId: activeBookId ?? null,
        seconds,
        startedAt,
        endedAt,
        readingDays: user.readingDays || {},
      });
      segmentStartRef.current = endedAt;
      // The profile's weekly chart reads straight off auth state, so it has to
      // learn the new total here — a refetch would repaint it a second later, and
      // the screen the reader lands on after Stop is exactly that chart.
      setUser({ ...user, ...patch });
      queryClient.invalidateQueries({ queryKey: qk.reading.sessions(user.id) });
      if (community?.id) {
        queryClient.invalidateQueries({ queryKey: qk.reading.rank(community.id, user.id) });
      }
      return seconds;
    } catch (err) {
      // Hand the seconds back so the next commit tries them again rather than
      // swallowing the sitting.
      committedMsRef.current -= seconds * 1000;
      logger.error("reading.commit", err?.message, { code: err?.code });
      setError(t.readingSaveFailed);
      return null;
    }
  }, [user, community?.id, activeBookId, setUser, queryClient]);

  // The run reached its length on its own.
  useEffect(() => {
    if (!running || remainingMs > 0) return;
    setBankedMs(durationMs);
    setStartedAt(null);
    setFinished(true);
    playTimerSound();
    commit(durationMs);
  }, [running, remainingMs, durationMs, commit]);

  // Whatever is still playing stops when the reader leaves.
  useEffect(() => () => stopTimerSound(), []);

  // Leaving mid-run records what was read rather than discarding it. Reading for
  // twenty minutes and then hitting Back is not a reason to lose twenty minutes.
  //
  // Both the elapsed time and the commit function are held in refs so the
  // unmount effect can stay `[]`-dependent: given the real dependencies it would
  // re-run — and so tear down and re-arm — on every one of the five ticks a
  // second, and an unmount handler that keeps being replaced is one that
  // eventually misses the unmount.
  const exitRef = useRef({ elapsedMs, commit });
  exitRef.current = { elapsedMs, commit };
  useEffect(() => () => {
    const { elapsedMs: ms, commit: save } = exitRef.current;
    save(ms);
  }, []);

  // The screen going away is not the same as the app going away, and on a phone
  // the second one is the common case: the reader locks the screen, or switches
  // apps and the system reclaims the tab. No unmount runs for that, so without
  // this the whole sitting was lost. `visibilitychange` is the signal that
  // actually fires on mobile — `beforeunload` largely does not — and `pagehide`
  // covers the tab being closed outright. Both are safe to fire repeatedly now
  // that a commit only writes what is new.
  useEffect(() => {
    const bank = () => {
      const { elapsedMs: ms, commit: save } = exitRef.current;
      save(ms);
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") bank(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", bank);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", bank);
    };
  }, []);

  function toggle() {
    setError("");
    if (running) {
      setBankedMs(elapsedMs);
      setStartedAt(null);
      return;
    }
    if (finished) return;
    // Fetch the tune now, inside the tap. A phone grants audio to a gesture,
    // and there is no gesture left when the run ends by itself.
    primeTimerSound();
    const now = Date.now();
    if (runStartRef.current == null) runStartRef.current = now;
    if (segmentStartRef.current == null) segmentStartRef.current = now;
    setNowMs(now);
    setStartedAt(now);
  }

  function reset() {
    stopTimerSound();
    setStartedAt(null);
    setBankedMs(0);
    setFinished(false);
    setError("");
    runStartRef.current = null;
    segmentStartRef.current = null;
    committedMsRef.current = 0;
  }

  async function stop() {
    stopTimerSound();
    setStartedAt(null);
    setBankedMs(elapsedMs);
    await commit(elapsedMs);
    navigate("/profile");
  }

  const todaySeconds = (user?.readingDays || {})[dayKey()] || 0;
  const progress = durationMs ? elapsedMs / durationMs : 0;

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center px-3">
        <button onClick={() => navigate("/profile")} className="icon-btn" aria-label={t.back}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="flex-1 text-center font-bold text-[18px] -ml-10">{t.readingTimerTitle}</h1>
      </div>

      <div className="px-6 mt-6 flex flex-col items-center">
        <ProgressRing progress={progress}>
          <p className="text-[52px] leading-none font-bold tabular-nums tracking-tight">
            {formatClock(elapsedMs)}
          </p>
          <p className="text-[13px] text-ink-500 mt-2">
            {finished ? t.readingDone : `${t.remainingTime} ${formatClock(remainingMs)}`}
          </p>
        </ProgressRing>

        <div className="flex items-center justify-center gap-5 mt-10">
          <button onClick={reset} className="timer-side-btn" aria-label={t.reset}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M4 12a8 8 0 1 1 2.5 5.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <path d="M4 6.5V12h5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            onClick={toggle}
            disabled={finished}
            aria-label={running ? t.pause : t.start}
            className="w-[92px] h-[92px] rounded-[28px] bg-brand-500 text-white inline-flex items-center justify-center shadow-soft transition active:scale-95 disabled:opacity-40"
          >
            {running ? (
              <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6.5" y="5" width="4" height="14" rx="1.4" />
                <rect x="13.5" y="5" width="4" height="14" rx="1.4" />
              </svg>
            ) : (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.5v13l11-6.5-11-6.5Z" />
              </svg>
            )}
          </button>

          <button onClick={stop} className="timer-side-btn" aria-label={t.stop}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2.5" />
            </svg>
          </button>
        </div>

        {error ? <p className="text-[13px] text-bad mt-4 text-center">{error}</p> : null}

        <p className="text-[13px] text-ink-500 italic mt-8 text-center">
          {t.readTodayLabel} <span className="tabular-nums">{formatDuration(todaySeconds)}</span>
        </p>

        {todaySessions.data?.length ? (
          <ul className="w-full mt-4 max-w-xs">
            {todaySessions.data.slice(0, 3).map((s) => (
              <li key={s.id} className="flex items-center justify-between py-1.5 text-[13px] border-b border-ink-100 last:border-b-0">
                <span className="text-ink-500">{s.dayKey}</span>
                <span className="font-medium tabular-nums">{formatDuration(s.seconds)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </MobileShell>
  );
}

/**
 * The dial. One SVG circle drawn as a dashed stroke whose dash is the arc that
 * has elapsed — the standard trick, and the reason it needs no second element
 * to mask anything. Rotated so zero sits at twelve o'clock rather than three.
 */
function ProgressRing({ progress, children }) {
  const RADIUS = 88;
  const circumference = useMemo(() => 2 * Math.PI * RADIUS, []);
  const clamped = Math.max(0, Math.min(1, progress || 0));

  return (
    <div className="relative w-[260px] h-[260px] max-w-full">
      <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
        <circle
          cx="100" cy="100" r={RADIUS} fill="none"
          stroke="var(--ink-100)" strokeWidth="14"
        />
        <circle
          cx="100" cy="100" r={RADIUS} fill="none"
          stroke="var(--brand-500)" strokeWidth="14" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          style={{ transition: "stroke-dashoffset 200ms linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
        {children}
      </div>
    </div>
  );
}

/** `MM:SS`, and `HH:MM:SS` once a run passes an hour. */
function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** A length out of the URL is user input; treat it as such. */
function clampRequestedMinutes(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return READING_MINUTES_DEFAULT;
  return Math.min(READING_MINUTES_MAX, Math.max(READING_MINUTES_MIN, n));
}
