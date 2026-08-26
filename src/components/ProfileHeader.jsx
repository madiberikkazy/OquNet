import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import AppIcon from "./AppIcon.jsx";
import { leftBookIcon, rightBookIcon } from "../utils/icons.js";
import { safeImageUrl } from "../utils/validators.js";
import { splitDuration } from "../utils/readingProgress.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/**
 * ProfileHeader — the brand banner, the overlapping avatar, and the name row.
 *
 * Shared by the reader's own profile and the one other members see, because the
 * two screens are the same object viewed from different sides: everything that
 * differs between them (the settings button, the back arrow) is a prop, and
 * everything that does not is here exactly once.
 *
 * The community chip is deliberately NOT here. It belongs beside the reading
 * section, where the standing it carries means something.
 *
 * `action` is the slot under the name for whatever this viewer can *do* with
 * this profile — the follow button on somebody else's, nothing on your own.
 */
export default function ProfileHeader({
  user, showSettings = false, onBack, badge, action = null, postsCount = null,
}) {
  const fullName = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim();
  const [viewing, setViewing] = useState(false);

  // Only a real picture opens. With no photo the avatar is a pair of initials,
  // and a viewer full of initials at 92px is a tap that promised something and
  // delivered the same thing bigger — so without one this stays a plain circle
  // with nothing to press.
  const photo = safeImageUrl(user?.photoURL);

  return (
    <header>
      {/* Full-bleed band. `-mt-4` cancels MobileShell's top padding so it starts
          at the very top of the screen, as in the design. Tall enough to hold
          the two stacks of books that flank the avatar — that height is the
          artwork's, and shrinking it crops the piles rather than scaling them. */}
      <div className="-mt-4 h-40 bg-brand-500 relative overflow-hidden sm:rounded-b-3xl">
        {onBack ? (
          <button
            onClick={onBack}
            aria-label={t.back}
            className="absolute left-3 top-3 w-10 h-10 inline-flex items-center justify-center rounded-xl bg-white/15 text-white active:scale-95 transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}

        {/* Settings sits in the band rather than on the name line: it is the
            only route to the admin view now, so it gets a corner of its own
            instead of competing with the reader's name for attention. */}
        {showSettings ? (
          <Link
            to="/settings"
            aria-label={t.settings}
            className="absolute right-3 top-3 w-10 h-10 inline-flex items-center justify-center rounded-xl bg-white/15 active:scale-95 transition"
          >
            <AppIcon name="settings" size={22} className="brightness-0 invert" />
          </Link>
        ) : null}

        {/* The two piles of books, standing on the sheet's edge either side of
            the avatar. Plain <img> rather than AppIcon because these are sized
            by height and left to keep their own proportions — AppIcon pins both
            dimensions to one number, which is right for an icon and wrong for
            artwork.

            Decoration: hidden from assistive tech and deaf to taps, so the back
            and settings buttons in the corners above them stay reachable rather
            than losing their edges to an image nobody can see. */}
        <img
          src={leftBookIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute bottom-0 left-1 h-[104px] sm:h-[118px] w-auto select-none pointer-events-none"
        />
        <img
          src={rightBookIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute bottom-0 right-1 h-[104px] sm:h-[118px] w-auto select-none pointer-events-none"
        />
      </div>

      {/* The page itself, rising over the band with a rounded top edge. It is
          painted in the page colour rather than white so it stays a cut-out in
          dark mode — and because it *is* the page: everything below simply
          continues on it.

          `relative` is load-bearing: the band above is positioned, and without
          a stacking context of its own this column paints *under* it — which
          hid the top half of the avatar, and would now hide the sheet as
          well. */}
      <div className="relative -mt-5 rounded-t-[28px] bg-base flex flex-col items-center px-4">
        {/* The avatar straddles the sheet's edge. The ring is the page
            background, not white, for the same reason the sheet is. */}
        <div className="-mt-[48px] rounded-full ring-4 ring-base">
          {photo ? (
            <button
              type="button"
              onClick={() => setViewing(true)}
              aria-label={t.openPhoto}
              className="block rounded-full active:scale-95 transition"
            >
              <Avatar src={user?.photoURL} name={fullName} size={92} />
            </button>
          ) : (
            <Avatar src={user?.photoURL} name={fullName} size={92} />
          )}
        </div>

        {viewing ? (
          <PhotoViewer src={photo} alt={fullName} onClose={() => setViewing(false)} />
        ) : null}

        <div className="flex items-center gap-2 mt-3">
          <h2 className="font-bold text-[22px] text-center">{fullName || `@${user?.nickname ?? ""}`}</h2>
          <ShareProfileButton user={user} />
        </div>

        {user?.nickname ? <p className="text-ink-500 text-[14px]">@{user.nickname}</p> : null}
        {badge}

        <FollowCounts user={user} postsCount={postsCount} />

        {action ? <div className="w-full mt-3">{action}</div> : null}
      </div>
    </header>
  );
}

/**
 * "Жазбалар 4 · Жазылымдар 26 · Жазылушылар 3" — what this person has written,
 * and the two ends of the follow graph, under the name on every profile.
 *
 * The two follow numbers are read straight off the profile document: they are
 * denormalised totals maintained by followUser/unfollowUser, so they cost no
 * query. An account created before follows existed carries neither field, which
 * is what the `?? 0` is for — a blank where a counter should be reads as a bug,
 * and zero is the truth.
 *
 * `postsCount` is different in kind and is passed in rather than read here: it
 * is counted by a query, and *which* query depends on who is looking (see
 * listPostsByAuthor). Null while that answer is still on its way, which draws
 * as a dash — the two zeroes beside it are facts, and a third zero that only
 * means "not yet" would be a lie standing next to them.
 *
 * The follow halves open the list behind them, on the same route for every
 * profile including the reader's own: a followers list is the same list whoever
 * is looking at it. The posts column leads nowhere yet, so it is not a link —
 * a tappable-looking number that does nothing is worse than a plain one.
 */
function FollowCounts({ user, postsCount = null }) {
  if (!user?.id) return null;

  return (
    <div className="flex items-stretch mt-3 w-full max-w-[320px]">
      <ProfileCount value={postsCount} label={t.postsLabel} />
      {/* Hairlines between the columns, not around them — same as ProfileStatsRow. */}
      <span className="w-px bg-ink-100 my-1 shrink-0" aria-hidden="true" />
      {/* `?? 0` here rather than in the column: a profile that predates follows
          carries neither field, and zero is the true answer for it. The dash the
          column falls back to is for a number that has not arrived yet, which
          only the posts count can be. */}
      <ProfileCount to={`/users/${user.id}/following`} value={user.followingCount ?? 0} label={t.followingLabel} />
      <span className="w-px bg-ink-100 my-1 shrink-0" aria-hidden="true" />
      <ProfileCount to={`/users/${user.id}/followers`} value={user.followersCount ?? 0} label={t.followersLabel} />
    </div>
  );
}

function ProfileCount({ to, value, label }) {
  const inner = (
    <>
      <p className="text-[20px] font-bold leading-none tabular-nums">{value ?? "—"}</p>
      <p className="text-[12px] text-ink-500 mt-1.5 truncate">{label}</p>
    </>
  );
  const className = "flex-1 min-w-0 px-1 py-1 rounded-xl text-center";

  if (!to) return <div className={className}>{inner}</div>;
  return (
    <Link to={to} className={className + " transition active:scale-[0.97]"}>
      {inner}
    </Link>
  );
}

/**
 * The community chip, with the member's standing in it.
 *
 * The standing half is only drawn once there is a rank to draw: a community
 * where nobody has read this week would otherwise give every member an
 * identical "1st place" badge, which says nothing and flatters everyone.
 */
export function CommunityRankChip({ community, rank }) {
  if (!community) return null;
  const { hours, minutes } = splitDuration(rank?.seconds);
  const timeLabel = hours ? `${hours} ${t.hoursShort} ${minutes} ${t.minutesShort}` : `${minutes} ${t.minutesShort}`;

  return (
    <Link
      to={`/community/${community.id}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 pl-3 pr-1.5 py-1 active:scale-[0.98] transition max-w-full shrink-0"
    >
      {/* Ink rather than brand: this text sits on the page background, and the
          brand ramp has no dark-mode variant — `text-brand-700` there is navy
          on near-black. The brand stays on the border and the chip, both of
          which bring their own light background with them. */}
      <span className="text-[13px] text-ink-900 truncate">
        {community.nickname ? community.nickname : community.name}
      </span>
      {rank ? (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-1.5 py-0.5 shrink-0"
          title={`${t.readingTotalLabel} ${timeLabel}`}
        >
          <AppIcon name="cup" size={13} />
          <span className="text-[12px] font-semibold text-brand-700">
            {rank.place} {t.placeShort}
          </span>
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Share the profile.
 *
 * `navigator.share` where it exists — on a phone that is the whole point, since
 * it opens the OS sheet the reader already knows. Everywhere else the link goes
 * to the clipboard and the button says so for a moment, because a share button
 * that appears to do nothing is worse than no share button.
 */
function ShareProfileButton({ user }) {
  const [copied, setCopied] = useState(false);
  if (!user?.id) return null;

  const url = `${window.location.origin}/users/${user.id}`;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`;

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title: name, text: t.shareProfileText(name), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // A cancelled share sheet rejects exactly like a failure does, and it is
      // by far the more common of the two — so this is logged, never surfaced.
      logger.warn("profile.share", err?.message);
    }
  }

  return (
    <button onClick={share} className="profile-action relative" aria-label={t.shareProfile}>
      <AppIcon name="shareProfile" size={18} />
      {/* Colour set inline: Tailwind's own `text-base` is a font size, so the
          `base` surface token cannot be reached through a text utility. */}
      {copied ? (
        <span
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink-900 px-2 py-1 text-[11px] font-medium"
          style={{ color: "var(--bg-base)" }}
        >
          {t.linkCopied}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The profile picture, full size.
 *
 * A plain overlay rather than a Modal: a Modal is a panel with padding and a
 * title, which is chrome around a photograph, and the photograph is the whole
 * point. So it is the picture on a dark ground and nothing else — tap anywhere,
 * press Escape, or use the button in the corner to leave.
 *
 * The image is capped at the viewport rather than shown at its natural size:
 * profile photos are uploaded straight from a camera roll and are routinely
 * several thousand pixels wide, which without this opens a picture the reader
 * has to scroll to see.
 */
function PhotoViewer({ src, alt, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      // Above the bars, not level with them. MobileShell's tab bar is `z-50`
      // and is rendered after the page, so at an equal z-index it wins the tie
      // and floats over the photograph — which is the one thing a full-screen
      // viewer must not let happen. The shell's `overlay` slot solves this by
      // DOM order, but that belongs to the screen; this is a self-contained
      // control inside the header, so it says so with a number instead.
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      // Painted here rather than with a `bg-ink-900/90` class, for two
      // reasons. The practical one: the ink tokens are `var(--ink-900)`
      // holding a whole colour, and Tailwind's `/90` modifier cannot apply an
      // alpha to that — it emits an invalid value the browser drops, leaving
      // the overlay fully transparent. The other is that near-black is simply
      // what this wants in both themes: a photograph is judged against a dark
      // ground, and a viewer that went pale in light mode would be showing the
      // picture against the page it is meant to be lifted off.
      style={{ backgroundColor: "rgba(0, 0, 0, 0.92)" }}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t.close}
        className="absolute right-3 top-3 w-10 h-10 inline-flex items-center justify-center rounded-xl bg-white/15 text-white active:scale-95 transition"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {/* The picture itself does not close the viewer — a tap that lands on
          what you opened it to look at should not dismiss it. */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-[85vh] rounded-2xl object-contain"
      />
    </div>
  );
}
