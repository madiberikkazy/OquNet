import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import AppIcon from "./AppIcon.jsx";
import { leftBookIcon, rightBookIcon } from "../utils/icons.js";
import { safeImageUrl } from "../utils/validators.js";
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
/**
 * Centre of the band to the inner edge of each pile of books, in px. Read off
 * the phone layout, where the two piles already sat right beside the avatar —
 * see where it is used.
 */
const PILE_INSET = 92;

export default function ProfileHeader({
  user, showSettings = false, onBack, badge, action = null, postsCount = null,
  /**
   * The small share icon beside the name. Off on the reader's own profile,
   * where the action row below already carries sharing as a full button — one
   * screen offering the same act twice, once as a 32px icon and once as a
   * labelled button, is clutter rather than convenience.
   */
  showShareIcon = true,
  /**
   * The banner's top-right corner on a profile that is not the reader's own.
   * Settings lives there on their own profile; on somebody else's, the corner
   * is where the things you can *find out* about that person go.
   */
  menu = null,
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

        {/* The same corner, on somebody else's profile. `z-20` because the two
            piles of books below are drawn after it and would otherwise take the
            menu's lower half — the settings link above has never needed it,
            being a plain link with nothing to open downward. */}
        {menu && !showSettings ? (
          <div className="absolute right-3 top-3 z-20">{menu}</div>
        ) : null}

        {/* The two piles of books, standing on the sheet's edge either side of
            the avatar. Plain <img> rather than AppIcon because these are sized
            by height and left to keep their own proportions — AppIcon pins both
            dimensions to one number, which is right for an icon and wrong for
            artwork.

            Anchored to the *centre*, not to the two edges, and that is the
            whole arrangement: the piles flank the avatar, so what has to stay
            constant is their distance from it rather than their distance from
            the sides of a band whose width changes. Pinned at `left-1` /
            `right-1` they only looked composed at phone width, where the band
            is narrow enough that the edges happen to be beside the avatar. Give
            the same header a tablet — the column caps at `max-w-2xl`, so the
            band goes from 375px to 672px — and the piles walk out to the
            corners, leaving 182px of empty blue between each one and the face
            in the middle.

            `PILE_INSET` is that distance, measured off the phone layout, which
            is the one that was already right: 92px from the centre to the inner
            edge of each pile. So this changes nothing at 375px and closes the
            gap everywhere above it. `-100%` in the left pile's translate is the
            image's own width, which is what lets an auto-width image be placed
            by its right edge without anybody hard-coding how wide the artwork
            is at each breakpoint.

            Below about 360px the outer edge of each pile crops, which is the
            same thing this artwork already does to its top: the band is
            `overflow-hidden` and these are sized to it rather than scaled down
            to fit.

            Decoration: hidden from assistive tech and deaf to taps, so the back
            and settings buttons in the corners above them stay reachable rather
            than losing their edges to an image nobody can see. */}
        <img
          src={leftBookIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ transform: `translateX(calc(-100% - ${PILE_INSET}px))` }}
          className="absolute bottom-0 left-1/2 h-[104px] sm:h-[118px] w-auto select-none pointer-events-none"
        />
        <img
          src={rightBookIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ transform: `translateX(${PILE_INSET}px)` }}
          className="absolute bottom-0 left-1/2 h-[104px] sm:h-[118px] w-auto select-none pointer-events-none"
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
          {showShareIcon ? <ShareProfileButton user={user} /> : null}
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
 * Share the profile — the action, without the button around it.
 *
 * `navigator.share` where it exists — on a phone that is the whole point, since
 * it opens the OS sheet the reader already knows. Everywhere else the link goes
 * to the clipboard and the caller says so for a moment, because a share button
 * that appears to do nothing is worse than no share button.
 *
 * A hook rather than one component because the same act is now drawn two ways:
 * an icon beside the name on somebody else's profile, and a full-width button
 * on your own, where it stands in the place a message button would. Two buttons
 * are a styling question; sharing is one behaviour, and copying it into both
 * would be two places for the clipboard fallback to drift apart.
 */
function useProfileShare(user) {
  const [copied, setCopied] = useState(false);

  const share = useCallback(async () => {
    if (!user?.id) return;
    const url = `${window.location.origin}/users/${user.id}`;
    const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`;
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
  }, [user]);

  return { share, copied };
}

/** The icon beside the name. */
function ShareProfileButton({ user }) {
  const { share, copied } = useProfileShare(user);
  if (!user?.id) return null;

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
 * The same act as a full-width button, for the action row.
 *
 * Grey, and on the right, because it is standing exactly where the message
 * button stands on somebody else's profile — the row keeps its shape as the
 * reader moves between the two screens, and only the two things it offers
 * change. Deliberately the quieter of the pair for the same reason the message
 * button is: two filled buttons of equal weight ask the reader to choose
 * between them.
 */
export function ShareProfileAction({ user, className = "" }) {
  const { share, copied } = useProfileShare(user);
  if (!user?.id) return null;

  return (
    <button
      onClick={share}
      // `t.forward` on the face and `t.shareProfile` for assistive tech, which
      // is not a shortcut: the button sits opposite a one-word "Сообщение" on
      // the other profile, and the long form wraps to two lines at phone width
      // — a row half a line taller than the same row on the next screen. The
      // label a reader needs is the short one, because the button is already
      // sitting on their own profile and cannot mean anything else; the full
      // sentence goes where there is no layout to break.
      aria-label={t.shareProfile}
      className={
        "btn-secondary flex items-center justify-center gap-2 py-3 rounded-2xl font-semibold " +
        "min-w-0 px-3 whitespace-nowrap " + className
      }
    >
      <AppIcon name="shareProfile" size={18} />
      <span className="truncate">{copied ? t.linkCopied : t.forward}</span>
    </button>
  );
}

/**
 * Where this reader reads — the community, in the place a follow button takes
 * on somebody else's profile.
 *
 * Following yourself is not a thing, so that half of the row was empty on your
 * own profile and the row was not drawn at all. The community is the honest
 * answer to the same question the follow button asks — what connects you to
 * this person — and on your own profile the answer is the one place you belong.
 * It keeps the brand colour and the left, reading position that the follow
 * button has, so the two screens read as the same header with one slot swapped.
 *
 * Nothing when there is no community: this screen already offers "find a
 * community" as a primary button of its own further down, and two competing
 * calls to join would be one too many.
 */
export function ProfileCommunityAction({ community, className = "" }) {
  if (!community?.id) return null;

  return (
    <Link
      to={`/community/${community.id}`}
      className={
        "bg-brand-500 text-white font-semibold py-3 rounded-2xl text-[15px] " +
        "flex items-center justify-center gap-2 px-3 min-w-0 transition active:scale-[0.98] " + className
      }
    >
      <span className="truncate">{community.name}</span>
    </Link>
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
