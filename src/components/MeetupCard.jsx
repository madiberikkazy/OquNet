import Avatar from "./Avatar.jsx";
import { memberId } from "../utils/meetups.js";
import { t } from "../utils/i18n.js";

/** How long the faces at a table take to go once round, in ms. */
const ORBIT_MS = 26_000;

/** The size of the square the ring is drawn in, and of the faces on it, in px. */
const RING_BOX = 78;
const HOST_FACE = 38;
const GUEST_FACE = 22;

/**
 * One offline sitting, as a card.
 *
 * The same card does three jobs, because they are three states of one thing and
 * giving each its own component is how two of them end up drifting apart:
 *
 *   an invitation — one person, waiting. A single face, and a ring going out
 *                   from it: nobody has arrived yet and the card should look
 *                   like it is still asking.
 *   a sitting     — two or more, reading. The faces turn around the host, which
 *                   is the room screen's motion brought down to card size on
 *                   purpose: it is the same event, and a reader who has been in
 *                   the room should recognise it without being told.
 *   your own      — either of the above, with the actions that belong to
 *                   somebody already at the table rather than a Join button.
 *
 * Everything the card needs is on the presence rows themselves — the name, the
 * handle and the picture ride along on each seat (see schema.js), so a list of
 * these costs no reads at all beyond the one subscription that produced them.
 */
export default function MeetupCard({
  table,
  mine = false,
  busy = false,
  onJoin,
  onOpenChat,
  onLeave,
  className = "",
  style,
}) {
  if (!table) return null;

  const host = table.host ?? table.members[0];
  const hostName = displayName(host);
  const count = table.members.length;

  return (
    // `style` is how a list staggers these: the entrance is the card's own, so
    // the delay has to reach the element the animation is on rather than a
    // wrapper that has none.
    <div className={"card meetup-rise overflow-hidden " + className} style={style}>
      <div className="flex items-center gap-3 px-3.5 py-3.5">
        <MeetupFaces table={table} />

        <div className="flex-1 min-w-0">
          {/* Two lines before it is cut. A name plus "invites you to read
              together" does not fit one line at any of the three languages'
              lengths, and a title that ends in an ellipsis on every card is a
              title nobody finishes reading. */}
          <p className="text-[14px] font-semibold leading-snug line-clamp-2">
            {mine ? t.meetupYours : t.meetupInvitesYou(hostName)}
          </p>

          {/* Where. The one fact somebody has to act on — it is what they will
              be walking to — so it gets the pin and the darker ink, and it is
              allowed two lines before it is cut. */}
          <p className="mt-1 flex items-start gap-1 text-[13px] text-ink-700">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="mt-[3px] shrink-0 text-brand-500">
              <path
                d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"
                stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round"
              />
              <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.9" />
            </svg>
            <span className="min-w-0 line-clamp-2 break-words">{table.place || "—"}</span>
          </p>

          <p className="mt-1 text-[12px] text-ink-500 flex items-center gap-1.5">
            {table.reading ? (
              // A live dot, and it only appears once there are actually people
              // at the table. An invitation nobody has answered is not "live".
              <span className="relative inline-flex w-1.5 h-1.5 shrink-0">
                <span className="absolute inset-0 rounded-full bg-ok meetup-pulse" />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-ok" />
              </span>
            ) : null}
            <span className="truncate">
              {table.reading
                ? `${t.coReadPeople(count)} · ${t.meetupReadingTogether}`
                : t.meetupWaiting}
            </span>
          </p>
        </div>
      </div>

      {/* The actions, on their own floor. A tint rather than a rule, the same
          way ReadingProgressCard separates its two halves — one card with a
          floor reads as one thing, two stacked panels read as two. */}
      <div className="bg-tint px-3 py-2.5 flex items-center gap-2">
        <span className="flex-1 min-w-0 text-[12px] text-ink-500 truncate">
          {mine ? t.coReadPeople(count) : host?.nickname ? `@${host.nickname}` : ""}
        </span>

        {mine ? (
          <>
            <button
              type="button"
              onClick={onLeave}
              disabled={busy}
              className="shrink-0 rounded-full bg-surface text-ink-700 text-[13px] font-semibold px-3.5 py-2 active:scale-95 transition disabled:opacity-50"
            >
              {t.coReadLeave}
            </button>
            {/* Only worth offering once there is somebody to talk to. */}
            {count > 1 ? (
              <button
                type="button"
                onClick={onOpenChat}
                className="shrink-0 rounded-full bg-brand-500 text-white text-[13px] font-semibold px-4 py-2 active:scale-95 transition"
              >
                {t.meetupOpenChat}
              </button>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            onClick={onJoin}
            disabled={busy}
            className="shrink-0 rounded-full bg-brand-500 text-white text-[13px] font-semibold px-4 py-2 active:scale-95 transition disabled:opacity-50"
          >
            {busy ? "…" : t.coReadJoin}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The host in the middle, everybody who joined turning around them.
 *
 * A fixed-size box, unlike the room's ring — this one is a thumbnail on a card
 * rather than the subject of a screen, so its radius is a constant and there is
 * nothing to measure. The orbit is the same single keyframe the room uses, for
 * the same reason: a parent ring plus counter-rotating children fall out of
 * phase the first time React re-creates one of them.
 *
 * Faces are spread by giving each a negative delay into the same loop, so a
 * person arriving takes the next seat rather than shuffling everybody already
 * at the table.
 */
export function MeetupFaces({ table }) {
  const host = table.host ?? table.members[0];
  const hostId = table.hostId;
  const guests = table.members.filter((m) => memberId(m) !== hostId).slice(0, 5);
  const radius = (RING_BOX - GUEST_FACE) / 2;

  return (
    <div
      className="relative shrink-0"
      style={{ width: RING_BOX, height: RING_BOX }}
      aria-hidden="true"
    >
      {/* The ring going out. On an invitation it is the card still asking; at a
          table it is the sitting being under way. Behind everything, and
          `pointer-events-none` because it is paint, not a control.
          A solid token rather than `bg-brand-500/25`: Tailwind's opacity
          modifier cannot apply to a colour that arrives as a bare `var()`, and
          it fails silently — see the `--bg-glass` note in index.css. */}
      <span className="pointer-events-none absolute inset-[18%] rounded-full bg-brand-200 meetup-pulse" />

      {guests.map((guest, i) => (
        <div
          key={memberId(guest)}
          className="absolute left-1/2 top-1/2"
          style={{
            width: GUEST_FACE,
            height: GUEST_FACE,
            marginLeft: -GUEST_FACE / 2,
            marginTop: -GUEST_FACE / 2,
            "--coread-r": `${radius}px`,
            animation: `coread-orbit ${ORBIT_MS}ms linear infinite`,
            animationDelay: `${-(i / Math.max(guests.length, 1)) * ORBIT_MS}ms`,
          }}
        >
          <Face src={guest.photoURL} name={displayName(guest)} size={GUEST_FACE} />
        </div>
      ))}

      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Face src={host?.photoURL} name={displayName(host)} size={HOST_FACE} />
      </span>
    </div>
  );
}

/**
 * One face on the ring, cut to a circle and sized to hold its own initials.
 *
 * The font size is set here rather than left to Avatar's, which inherits from
 * the page: at 22px across, two inherited 16px letters are wider than the disc
 * they are meant to sit in, and they spill out of it as bare text on the card.
 * A proportion rather than a constant, so the host's face and a guest's are the
 * same picture at two sizes.
 */
function Face({ src, name, size }) {
  return (
    <span
      className="block rounded-full ring-2 ring-base overflow-hidden bg-ink-100"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      <Avatar src={src} name={name} size={size} />
    </span>
  );
}

/**
 * What to call somebody at a table.
 *
 * The real name first, unlike the room's ring: that one is a circle of costumes
 * where the handle is the identity, and this is an arrangement to meet a person
 * somewhere. The handle is the fallback, and `deletedUser` the last resort — a
 * seat whose owner's profile has gone still has to draw.
 */
function displayName(seat) {
  const name = String(seat?.name ?? "").trim();
  if (name) return name;
  const nickname = String(seat?.nickname ?? "").trim();
  return nickname ? `@${nickname}` : t.deletedUser;
}
