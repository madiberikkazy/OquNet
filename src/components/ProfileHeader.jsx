import { useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import AppIcon from "./AppIcon.jsx";
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
 */
export default function ProfileHeader({ user, showSettings = false, onBack, badge }) {
  const fullName = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim();

  return (
    <header>
      {/* Full-bleed band. `-mt-4` cancels MobileShell's top padding so it starts
          at the very top of the screen, as in the design. */}
      <div className="-mt-4 h-28 bg-brand-500 relative sm:rounded-b-3xl">
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
      </div>

      {/* The avatar straddles the band's lower edge. The ring is the page
          background, not white, so it stays a cut-out in dark mode too.
          `relative` is load-bearing: the band above is positioned, and without
          a stacking context of its own this column paints *under* it — which
          hid the top half of the avatar. */}
      <div className="relative flex flex-col items-center px-4">
        <div className="-mt-[46px] rounded-full ring-4 ring-base">
          <Avatar src={user?.photoURL} name={fullName} size={92} />
        </div>

        <div className="flex items-center gap-2 mt-3">
          <h2 className="font-bold text-[22px] text-center">{fullName || `@${user?.nickname ?? ""}`}</h2>
          <ShareProfileButton user={user} />
        </div>

        {user?.nickname ? <p className="text-ink-500 text-[14px]">@{user.nickname}</p> : null}
        {badge}
      </div>
    </header>
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
