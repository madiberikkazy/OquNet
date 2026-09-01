import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  leaveCoReading, logReadingSession, touchCoReading, watchCoReaders,
} from "../../firebase/firestore.js";
import { COREAD_STALE_MS } from "../../firebase/schema.js";
import { coReadAvatarSrc } from "../../utils/icons.js";
import {
  MIN_SESSION_SECONDS,
  READING_MINUTES_DEFAULT, READING_MINUTES_MAX, READING_MINUTES_MIN,
} from "../../utils/readingProgress.js";
import { qk } from "../../lib/queryKeys.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

/** Heartbeat interval — comfortably inside the window a row goes stale in. */
const BEAT_MS = Math.round(COREAD_STALE_MS / 3);

/** How often the ring turns once, in ms. Slow enough to be ambient. */
const ORBIT_MS = 60_000;

/** Room under each face for the name that hangs there, in px. */
const LABEL_H = 16;

/**
 * The room: everybody reading, around you, while the clock runs.
 *
 * ── Presence ────────────────────────────────────────────────────────────────
 * One subscription over the community's presence rows, and a heartbeat on this
 * reader's own. Leaving deletes it — and so does closing the tab, as far as the
 * room is concerned, because a row that stops being touched stops being drawn.
 * That is the only reason this survives a killed browser: nothing can be relied
 * on to run at the end, so nothing important is left to run at the end.
 *
 * ── The circle ──────────────────────────────────────────────────────────────
 * You are in the middle and everybody else is on a ring around you, turning.
 * The angles are assigned by user id rather than by array position, so somebody
 * arriving does not shuffle everyone already seated — a ring that reshuffles on
 * every join reads as a glitch, not as a person walking in.
 *
 * The rotation is a CSS animation on the ring, with each face counter-rotated
 * by the same amount so the pictures stay upright while their positions travel.
 * Nothing here runs on a timer in JavaScript; the clock below is the only thing
 * that ticks, and it ticks off the wall clock rather than counting frames.
 */
export default function ReadTogetherRoom() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const { community } = useCommunity();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();

  const [readers, setReaders] = useState([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const pausedMsRef = useRef(0);
  const pausedAtRef = useRef(null);

  // How much of this sitting is already in the log, and where the next unwritten
  // stretch starts. Reading here counts towards the same total the solo timer
  // feeds, and it is banked as it goes rather than at the end — see `commit`.
  const committedMsRef = useRef(0);
  const segmentStartRef = useRef(startedAt);
  // Which sitting the numbers above belong to. Reset starts a new one while a
  // commit for the old one may still be in flight, and that commit must not be
  // allowed to write its bookkeeping over the fresh sitting's — see `commit`.
  const sittingRef = useRef(0);

  // The length the reader chose on the way in. It arrives in the URL so that a
  // reload lands back in the same sitting rather than at the default. Clamped
  // rather than trusted: an edited one only ever mis-sets its own owner's
  // clock, but a clock is easier to reason about when it cannot be handed a
  // negative or a week.
  const durationMs = clampMinutes(params.get("minutes")) * 60_000;

  // Live room.
  useEffect(() => {
    if (!community?.id) return undefined;
    return watchCoReaders(community.id, {
      onRows: setReaders,
      onError: (err) => logger.error("coReadRoom.watch", err?.message, { code: err?.code }),
    });
  }, [community?.id]);

  // Still here.
  useEffect(() => {
    if (!user?.id) return undefined;
    const beat = () => {
      touchCoReading(user.id).catch((err) =>
        logger.warn("coReadRoom.beat", err?.message));
    };
    beat();
    const id = setInterval(beat, BEAT_MS);
    return () => clearInterval(id);
  }, [user?.id]);

  // The clock. Derived from `Date.now()` against the moment the sitting began,
  // never accumulated a tick at a time — a backgrounded tab throttles its
  // timers, and a counter that adds an interval's worth per fire finishes a
  // half-hour late having under-counted every minute the phone was asleep.
  useEffect(() => {
    if (paused) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [paused]);

  const elapsedMs = Math.max(
    0,
    (paused ? pausedAtRef.current ?? nowMs : nowMs) - startedAt - pausedMsRef.current
  );
  const remainingMs = Math.max(0, durationMs - elapsedMs);

  /**
   * Write down what has been read but not yet recorded.
   *
   * Reading in the room is reading: it counts towards the same day map and the
   * same total the solo timer feeds, and it counted for nothing before this —
   * a reader who sat down with everybody else for half an hour and then left
   * before the clock ran out came away with the half hour unrecorded, because
   * the room only ever deleted its presence row on the way out.
   *
   * What is written is the time actually spent reading: elapsed wall-clock time
   * with the paused stretches taken out, not the length the timer was set to.
   * Leaving early records the part that happened; sitting past the end records
   * that too.
   *
   * Safe to call as often as any of the ways out of this screen happen, because
   * it writes the *delta* since the last successful write. The floor is the
   * server's — the rules refuse a row under `MIN_SESSION_SECONDS` — so a smaller
   * delta is held back rather than sent to be rejected, and rides along with the
   * next one.
   */
  const commit = useCallback(async (totalMs) => {
    if (!user?.id) return null;
    const seconds = Math.floor((totalMs - committedMsRef.current) / 1000);
    if (seconds < MIN_SESSION_SECONDS) return null;

    // Reserved before the await, so a second caller arriving while this one is
    // in flight cannot claim the same seconds.
    committedMsRef.current += seconds * 1000;
    const sitting = sittingRef.current;
    const endedAt = Date.now();
    const from = segmentStartRef.current ?? endedAt - seconds * 1000;
    try {
      const { patch } = await logReadingSession({
        userId: user.id,
        communityId: community?.id ?? null,
        // No book: the room is a sitting with other people rather than with a
        // particular loan, and guessing one would mislabel the log.
        bookId: null,
        seconds,
        startedAt: from,
        endedAt,
        readingDays: user.readingDays || {},
      });
      if (sittingRef.current === sitting) segmentStartRef.current = endedAt;
      // The profile's chart and this room's own totals read straight off auth
      // state, so it has to learn the new total here rather than after a refetch.
      setUser({ ...user, ...patch });
      // And the face in the circle, so the minutes under it climb while the
      // reader is sitting there rather than only after they come back.
      touchCoReading(user.id, { minutes: Math.floor((patch.readingSeconds ?? 0) / 60) })
        .catch((err) => logger.warn("coReadRoom.minutes", err?.message));
      queryClient.invalidateQueries({ queryKey: qk.reading.sessions(user.id) });
      if (community?.id) {
        queryClient.invalidateQueries({ queryKey: qk.reading.rank(community.id, user.id) });
      }
      return seconds;
    } catch (err) {
      // Hand the seconds back, so the next commit tries them again rather than
      // swallowing the sitting — but only to the sitting they were taken from.
      // Refunding into a sitting that has since been reset would leave its
      // ledger below zero, and the next commit would write time nobody read.
      if (sittingRef.current === sitting) committedMsRef.current -= seconds * 1000;
      logger.error("coReadRoom.commit", err?.message, { code: err?.code });
      return null;
    }
  }, [user, community?.id, setUser, queryClient]);

  // Every way out of this screen banks first. The unmount covers Back and any
  // navigation; `visibilitychange` and `pagehide` cover the case a phone makes
  // the common one — the screen locked, or the tab reclaimed by the system —
  // where no unmount ever runs and the whole sitting used to disappear with it.
  //
  // Both the elapsed time and the commit are held in a ref so these effects can
  // stay `[]`-dependent: given their real dependencies they would tear down and
  // re-arm four times a second, and a handler that keeps being replaced is one
  // that eventually misses the event it was armed for.
  const exitRef = useRef({ elapsedMs, commit });
  exitRef.current = { elapsedMs, commit };

  useEffect(() => () => {
    const { elapsedMs: ms, commit: save } = exitRef.current;
    save(ms);
  }, []);

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

  function togglePause() {
    setPaused((was) => {
      if (was) {
        pausedMsRef.current += Date.now() - (pausedAtRef.current ?? Date.now());
        pausedAtRef.current = null;
        setNowMs(Date.now());
        return false;
      }
      pausedAtRef.current = Date.now();
      return true;
    });
  }

  /**
   * Start the sitting over.
   *
   * It used to reload the page, which threw the clock away along with every
   * minute that had not been written down yet — the reload's `pagehide` had to
   * race a Firestore write it could not wait for. Resetting in place banks what
   * was read first and then puts the clock back to zero, so the button costs
   * the reader nothing but the count.
   */
  function reset() {
    commit(elapsedMs);
    const now = Date.now();
    sittingRef.current += 1;
    committedMsRef.current = 0;
    segmentStartRef.current = now;
    pausedMsRef.current = 0;
    pausedAtRef.current = null;
    setPaused(false);
    setStartedAt(now);
    setNowMs(now);
  }

  async function leave() {
    // What was read is written down first. Leaving before the timer runs out is
    // an ordinary way to end a sitting, not a reason to lose it.
    commit(elapsedMs);
    try {
      await leaveCoReading(user?.id);
    } catch (err) {
      // Leaving is best-effort: the row goes stale by itself, so a failure here
      // costs the reader nothing and must not trap them on this screen.
      logger.warn("coReadRoom.leave", err?.message);
    }
    navigate("/profile", { replace: true });
  }

  const me = readers.find((r) => (r.userId ?? r.id) === user?.id) ?? null;
  const others = useMemo(
    () => readers.filter((r) => (r.userId ?? r.id) !== user?.id),
    [readers, user?.id]
  );

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center px-3">
        <button onClick={leave} className="icon-btn" aria-label={t.back}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* ── The clock ── */}
      <div className="flex justify-center mt-2">
        <Dial progress={durationMs ? elapsedMs / durationMs : 0}>
          <p className="text-[30px] leading-none font-bold tabular-nums tracking-tight">
            {clock(elapsedMs)}
          </p>
          <p className="text-[11px] text-ink-500 mt-1.5 tabular-nums">
            {t.remainingTime} {clock(remainingMs)}
          </p>
        </Dial>
      </div>

      {/* ── The circle ── */}
      <Circle me={me} others={others} paused={paused} />

      {/* ── Controls ── */}
      <div className="flex items-center justify-center gap-5 mt-6">
        <button onClick={reset} className="timer-side-btn" aria-label={t.reset}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M4 12a8 8 0 1 1 2.5 5.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M4 6.5V12h5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          onClick={togglePause}
          aria-label={paused ? t.start : t.pause}
          className="w-[74px] h-[74px] rounded-[24px] bg-brand-500 text-white inline-flex items-center justify-center shadow-soft transition active:scale-95"
        >
          {paused ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5-11-6.5Z" />
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6.5" y="5" width="4" height="14" rx="1.4" />
              <rect x="13.5" y="5" width="4" height="14" rx="1.4" />
            </svg>
          )}
        </button>

        <button onClick={leave} className="timer-side-btn" aria-label={t.stop}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2.5" />
          </svg>
        </button>
      </div>

      <div className="px-5 mt-6">
        <button onClick={leave} className="btn-secondary">{t.coReadLeave}</button>
      </div>
    </MobileShell>
  );
}

/** The requested sitting length, in minutes, held inside what the app allows. */
function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return READING_MINUTES_DEFAULT;
  return Math.min(READING_MINUTES_MAX, Math.max(READING_MINUTES_MIN, Math.round(n)));
}

/** `MM:SS`, and `H:MM:SS` once a sitting passes an hour. */
function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** The ring around the clock — one dashed stroke, as on the reading timer. */
function Dial({ progress, children }) {
  const R = 70;
  const c = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(1, progress || 0));
  return (
    <div className="relative w-[176px] h-[176px]">
      <svg viewBox="0 0 160 160" className="w-full h-full -rotate-90">
        <circle cx="80" cy="80" r={R} fill="none" stroke="var(--ink-100)" strokeWidth="6" />
        <circle
          cx="80" cy="80" r={R} fill="none"
          stroke="var(--brand-500)" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p)}
          style={{ transition: "stroke-dashoffset 250ms linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
        {children}
      </div>
    </div>
  );
}

/**
 * You, and everybody else turning slowly around you.
 *
 * Sized in percentages of a square box so the whole thing scales with the
 * screen rather than needing a breakpoint. The ring is one rotating element;
 * each face cancels that rotation so it stays the right way up.
 */
function Circle({ me, others, paused }) {
  const ring = others.slice(0, 10);
  const boxRef = useRef(null);
  const [radius, setRadius] = useState(0);

  // The orbit radius is a length, so the ring has to be measured — it is
  // `w-full` under a cap, so it is one width on a small phone and another on a
  // large one, and a hard-coded radius would put the faces through the edge of
  // the box on the first and leave them huddled in the middle on the second.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => {
      const w = box.getBoundingClientRect().width;
      // Half the box, less half of the largest face, less the name hanging
      // under it, less a little air. The label is part of the face now, so it
      // has to be part of what the radius makes room for — without it the names
      // on the lower half of the ring hang out of the box and into the controls.
      setRadius(Math.max(0, w / 2 - 40 - LABEL_H - 6));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={boxRef} className="mt-4 mx-auto relative w-full max-w-[330px] aspect-square">
      {radius > 0 && ring.map((r, i) => {
        const size = 62 + ((hash(r.userId ?? r.id) % 3) * 9);
        return (
          // The animation moves this box rather than the picture, so the name
          // travels with the face it belongs to. It stays upright for the same
          // reason the picture does — the keyframe unwinds its own rotation.
          <div
            key={r.userId ?? r.id}
            title={r.name || ""}
            className="absolute left-1/2 top-1/2"
            style={{
              width: size,
              height: size,
              marginLeft: -size / 2,
              marginTop: -size / 2,
              "--coread-r": `${radius}px`,
              animation: `coread-orbit ${ORBIT_MS}ms linear infinite`,
              // Spread around the circle by starting each face part-way through
              // the same loop. A seat is a phase, not an angle — see index.css.
              animationDelay: `${-(i / Math.max(ring.length, 1)) * ORBIT_MS}ms`,
              animationPlayState: paused ? "paused" : "running",
            }}
          >
            <img
              src={coReadAvatarSrc(r.avatar)}
              alt=""
              aria-hidden="true"
              width={size}
              height={size}
              draggable={false}
              style={{ width: size, height: size }}
              className="rounded-full bg-ink-100 select-none shadow-soft"
            />
            {/* Who that is, under the picture. Out of the box's flow — the box
                is the face, and its size is what the orbit radius was measured
                against, so a label taking height would push the pictures off
                their circle. Capped and clipped rather than wrapped: two lines
                under one face would run into the next one along. */}
            <span
              className="absolute top-full left-1/2 -translate-x-1/2 mt-1 block max-w-[92px] truncate text-center text-[10px] font-medium leading-tight text-ink-700"
            >
              {coReaderLabel(r)}
            </span>
          </div>
        );
      })}

      {/* You, in the middle and larger — the one face that does not travel. */}
      {me ? (
        <img
          src={coReadAvatarSrc(me.avatar)}
          alt=""
          aria-hidden="true"
          width={104}
          height={104}
          draggable={false}
          style={{ width: 104, height: 104 }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-100 select-none shadow-soft ring-4 ring-base"
        />
      ) : null}
    </div>
  );
}

/**
 * What to call a face on the ring.
 *
 * The nickname first, because that is the handle people are known by here and
 * it is short enough to sit under a picture. A reader who has not set one gets
 * their name — a face with nothing under it reads as a face that failed to
 * load, and every presence row carries at least one of the two.
 */
function coReaderLabel(reader) {
  const nickname = String(reader?.nickname ?? "").trim();
  if (nickname) return `@${nickname}`;
  return String(reader?.name ?? "").trim();
}

/** A tiny stable hash, so a reader's size does not change between renders. */
function hash(value) {
  const s = String(value ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
