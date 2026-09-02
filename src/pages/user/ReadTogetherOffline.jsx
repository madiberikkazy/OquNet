import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import MeetupCard from "../../components/MeetupCard.jsx";
import GenderFigure from "../../components/GenderFigure.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  diagnoseMeetupAccess,
  joinOfflineMeetup, leaveOfflineMeetup, openOfflineMeetup, watchOfflineMeetups,
} from "../../firebase/firestore.js";
import { MEETUP_PLACE_MAX, isMeetupGender } from "../../firebase/schema.js";
import { meetupTables, meetupsFor, tableFor } from "../../utils/meetups.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { t } from "../../utils/i18n.js";

/**
 * Reading together, offline: finding somebody to sit down with in a real place.
 *
 * The online tab next to this one is a circle of avatars and a shared clock —
 * everybody in their own room, together on a screen. This one ends with two
 * people in the same café, so almost nothing is shared between them: there is
 * no timer, no avatar, and the picture on every card is the reader's real one.
 *
 * ── How an arrangement travels ───────────────────────────────────────────────
 * Opening one writes a single document (firebase/schema.js: offline meet-ups).
 * Nothing is *sent* anywhere: every member of the community is already
 * subscribed to that collection from their own profile screen, and the ones
 * whose gender matches draw a card for it the moment it lands. That is the
 * whole delivery mechanism, and it is why the invitation arrives on the profile
 * rather than in the notification list — there is no notification, there is a
 * live list of who is currently looking for company.
 *
 * ── Why the gender question ─────────────────────────────────────────────────
 * This is the one feature in the app that ends with two strangers agreeing to
 * be in the same room, and the reader chooses who that can be. The answer is
 * kept on the profile rather than asked again each time, so it is a decision
 * made once — and changed in Settings, not buried in this flow.
 */
export default function ReadTogetherOffline({ tabs }) {
  const navigate = useNavigate();
  const { user, updateProfile } = useAuth();
  const { community } = useCommunity();

  // Everybody sitting down in this community, live. The same subscription the
  // profile screen holds, so a card cannot exist on one screen and not on the
  // other — see components/MeetupCard.jsx for what a "table" is.
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!community?.id) return undefined;
    return watchOfflineMeetups(community.id, {
      onRows: setRows,
      onError: (err) => logger.error("meetups.watch", err?.message, { code: err?.code }),
    });
  }, [community?.id]);

  const tables = useMemo(() => meetupTables(rows), [rows]);
  const mine = useMemo(() => tableFor(tables, user?.id), [tables, user?.id]);
  const open = useMemo(() => meetupsFor(tables, user), [tables, user]);

  // The two-step sheet: who you are, then where you will be.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [gender, setGender] = useState(user?.gender ?? null);
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function startSearch() {
    setError("");
    setPlace("");
    setGender(user?.gender ?? null);
    // Somebody who has already answered the question does not answer it again —
    // they go straight to the only thing that changes between sittings. It is
    // still one back-step away, so the answer is never locked in here.
    setStep(isMeetupGender(user?.gender) ? 2 : 1);
    setSheetOpen(true);
  }

  async function publish() {
    if (busy) return;
    if (!isMeetupGender(gender)) { setStep(1); setError(t.meetupPickGender); return; }
    const where = place.trim();
    if (!where) { setError(t.meetupPlaceRequired); return; }

    setBusy(true);
    setError("");

    // Two writes, two collections, and two separate refusals. They used to
    // share one `try`, which meant a profile write the server turned down was
    // reported as "could not open the meet-up" — a sentence about the wrong
    // half of the flow, pointing whoever had to fix it at the wrong rule.
    try {
      // The answer is remembered before the sitting is opened, because it is
      // what every future invitation is matched by — this flow is where the
      // question is asked, not where the answer belongs.
      if (user?.gender !== gender) await updateProfile({ gender });
    } catch (err) {
      logger.error("meetups.gender", err?.message, {
        code: err?.code, collection: "users", userId: user?.id,
      });
      setError(writeError(err) || t.saveFailed);
      setBusy(false);
      return;
    }

    try {
      await openOfflineMeetup({
        userId: user.id,
        communityId: community.id,
        gender,
        place: where,
        name: peerName(user),
        nickname: user.nickname ?? "",
        photoURL: user.photoURL ?? "",
      });
      setSheetOpen(false);
      setStep(1);
      setPlace("");
    } catch (err) {
      // Named, because "Missing or insufficient permissions" does not say which
      // document it was about, and this flow touches two collections.
      logger.error("meetups.open", err?.message, { code: err?.code, collection: "meetups" });
      await reportRefusal(err, user, community.id, "meetups.open");
      setError(writeError(err) || t.meetupOpenFailed);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Take a seat at somebody's table, and then go and talk to them.
   *
   * The chat is the point of the button, not a courtesy after it: an
   * arrangement to meet is useless until the two of them can agree on a time,
   * and the alternative — joining and being returned to a list — leaves the
   * host with a stranger's face on their card and no way to reach them.
   */
  async function join(table) {
    if (busy || !table) return;
    setBusy(true);
    setError("");
    try {
      await joinOfflineMeetup({
        userId: user.id,
        // Synthesised from the table rather than taken off one row: the host's
        // own seat may be gone, and the place and gender are the table's.
        meetup: {
          hostId: table.hostId,
          communityId: community.id,
          gender: table.gender,
          place: table.place,
        },
        name: peerName(user),
        nickname: user.nickname ?? "",
        photoURL: user.photoURL ?? "",
      });
      navigate(`/chats/${table.hostId}`);
    } catch (err) {
      logger.error("meetups.join", err?.message, { code: err?.code, collection: "meetups" });
      await reportRefusal(err, user, community.id, "meetups.join");
      setError(writeError(err) || t.meetupJoinFailed);
      setBusy(false);
    }
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    try {
      await leaveOfflineMeetup(user?.id);
    } catch (err) {
      // Best effort, exactly like leaving the online room: an abandoned seat
      // ages out on its own, so a failure here must not trap anybody.
      logger.warn("meetups.leave", err?.message);
    } finally {
      setBusy(false);
    }
  }

  /** Whoever to open a chat with from your own table — the host, or a guest. */
  function chatPeer(table) {
    if (!table) return null;
    if (table.hostId !== user?.id) return table.hostId;
    const guest = table.members.find((m) => (m.userId ?? m.id) !== user?.id);
    return guest ? guest.userId ?? guest.id : null;
  }

  // The same bar the online tab carries, with a title where its search field
  // is: this list is short and already filtered to the people who can be met,
  // so there is nothing here to search. The arrow is the reason it exists —
  // without a header this screen has no way back but the browser's own.
  const header = (
    <div className="flex items-center gap-2 px-1 pb-2">
      <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <h1 className="flex-1 min-w-0 text-[17px] font-semibold truncate">{t.coReadTitle}</h1>
    </div>
  );

  if (!community?.id) {
    return (
      <MobileShell withNav={false} header={header}>
        <div className="px-4 pt-4">{tabs}</div>
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.coReadNeedCommunity}</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell
      withNav={false}
      header={header}
      overlay={
        <SearchSheet
          open={sheetOpen}
          step={step}
          gender={gender}
          place={place}
          busy={busy}
          error={error}
          onClose={() => setSheetOpen(false)}
          onBack={() => setStep(1)}
          onGender={(value) => { setGender(value); setError(""); setStep(2); }}
          onPlace={setPlace}
          onSubmit={publish}
        />
      }
      bottomBar={
        // Only for somebody not already sitting somewhere. A second sitting
        // would silently move the first — the row is keyed by its owner — and
        // a button whose real effect is "cancel the arrangement you made" is
        // not a button, it is a trap.
        mine ? null : (
          <>
            {error && !sheetOpen ? (
              <p className="mb-2 text-bad text-[13px] text-center px-2">{error}</p>
            ) : null}
            <button onClick={startSearch} className="btn-primary flex items-center justify-center gap-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
                <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t.meetupSearchPeople}
            </button>
          </>
        )
      }
    >
      <div className="px-4 pt-4">{tabs}</div>

      {/* Your own arrangement, above everything and drawn as what it is rather
          than as something to join. No heading over it: the card already says
          whose it is, and a section title repeating the card's own first line
          is the same sentence twice in a row. */}
      {mine ? (
        <section className="px-4 mt-5">
          <MeetupCard
            table={mine}
            mine
            busy={busy}
            onLeave={leave}
            onOpenChat={() => {
              const peer = chatPeer(mine);
              if (peer) navigate(`/chats/${peer}`);
            }}
          />
        </section>
      ) : null}

      <section className="px-4 mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="section-title">{t.meetupInvites}</h2>
          {open.length > 0 ? (
            <span className="text-[12px] text-ink-500 tabular-nums">{t.coReadPeople(open.length)}</span>
          ) : null}
        </div>

        {open.length > 0 ? (
          <ul className="mt-2 space-y-2.5">
            {open.map((table, i) => (
              <li key={table.hostId}>
                <MeetupCard
                  table={table}
                  busy={busy}
                  onJoin={() => join(table)}
                  // A stagger down the list, so a screenful of cards arrives as
                  // one motion rather than five things appearing at once. Capped,
                  // because the delay is only worth having while the eye can
                  // still follow it — past six rows it is just a slow list.
                  style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 rounded-2xl bg-ink-100 px-5 py-8 text-center">
            <p className="text-[14px] text-ink-500">
              {isMeetupGender(user?.gender) ? t.meetupNobody : t.meetupNeedGender}
            </p>
            {!isMeetupGender(user?.gender) ? (
              <button
                onClick={startSearch}
                className="mt-3 text-[13px] font-semibold text-brand-500 active:opacity-60"
              >
                {t.meetupPickGender}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <div className="h-4" />
    </MobileShell>
  );
}

// ─── The search sheet ─────────────────────────────────────────────────────────

/**
 * Two questions, one sheet: who you are, and where you will be.
 *
 * A sheet rather than a screen because neither half means anything on its own —
 * a gender picker reachable by its own URL is a picker somebody can land on
 * with nothing to apply it to, which is the same reason the online tab asks for
 * an avatar in a step rather than on a route.
 *
 * It goes through MobileShell's overlay slot for the reason BookDetail's rating
 * sheet does: a `fixed` element rendered inside the page is pinned to the page,
 * which is a transformed element during the route transition, and it opens at
 * the bottom of the content rather than the bottom of the screen.
 */
function SearchSheet({
  open, step, gender, place, busy, error,
  onClose, onBack, onGender, onPlace, onSubmit,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative bg-surface rounded-t-3xl px-6 pt-4 pb-9 meetup-rise">
        <div className="w-10 h-1 rounded-full bg-ink-300 mx-auto" />

        {step === 1 ? (
          <>
            <h2 className="text-[18px] font-bold text-center mt-4">{t.meetupPickGender}</h2>
            <p className="text-[13px] text-ink-500 text-center mt-1.5">{t.meetupGenderNote}</p>

            <div className="grid grid-cols-2 gap-3 mt-5">
              <GenderChoice
                value="male"
                label={t.meetupMale}
                selected={gender === "male"}
                onSelect={onGender}
              />
              <GenderChoice
                value="female"
                label={t.meetupFemale}
                selected={gender === "female"}
                onSelect={onGender}
              />
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[18px] font-bold text-center mt-4">{t.meetupPlaceTitle}</h2>
            <p className="text-[13px] text-ink-500 text-center mt-1.5">{t.meetupGenderNote}</p>

            <input
              value={place}
              onChange={(e) => onPlace(e.target.value)}
              placeholder={t.meetupPlacePlaceholder}
              maxLength={MEETUP_PLACE_MAX}
              autoFocus
              className="input mt-5"
            />

            {error ? <p className="text-bad text-[13px] mt-2">{error}</p> : null}

            <button onClick={onSubmit} disabled={busy} className="btn-primary mt-3">
              {busy ? "…" : t.meetupPublish}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="w-full py-3 text-[14px] text-ink-500 font-medium"
            >
              {t.back}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Say out loud why the server refused, when it did.
 *
 * Only for `permission-denied`, and only from a write somebody actually asked
 * for, so it costs one profile read per refusal and nothing when things work.
 * The verdict it prints is the difference between "deploy the rules" and "this
 * account is not in the community it thinks it is" — two problems that look
 * identical from the screen and have nothing in common.
 */
async function reportRefusal(err, user, communityId, scope) {
  if (err?.code !== "permission-denied") return;
  const diagnosis = await diagnoseMeetupAccess({ userId: user?.id, communityId });
  logger.error(`${scope}.diagnosis`, diagnosis.verdict, diagnosis);
}

/**
 * One of the two figures, as a card you tap once.
 *
 * The artwork and its fallback both live in GenderFigure — this is the card
 * around it: the ring that says which one is chosen, and the slow breath that
 * makes a picture on a card read as something you are choosing to be rather
 * than an icon labelling a row.
 */
function GenderChoice({ value, label, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={
        "rounded-2xl px-3 pt-4 pb-3 flex flex-col items-center gap-2 transition active:scale-95 " +
        (selected
          ? "bg-tint ring-2 ring-brand-500"
          : "bg-ink-100 ring-2 ring-transparent")
      }
    >
      <span className="meetup-float">
        <GenderFigure value={value} size={92} />
      </span>
      <span className={"text-[14px] font-semibold " + (selected ? "text-tintInk" : "text-ink-700")}>
        {label}
      </span>
    </button>
  );
}
