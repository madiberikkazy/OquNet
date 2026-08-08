import { t } from "../utils/i18n.js";

/**
 * The five counters on a profile, and the one place that says what they are.
 *
 * "Owned" and "held" are the two that get confused, so they are both here and
 * both named: `owned` is what belongs to this person, `held` is what is
 * physically with them right now. A book is in both lists until somebody
 * collects it, and in neither of the other's once they do.
 *
 * The order matters — it is the order the design lays them out in, and the
 * fifth card takes the full width of the row it starts.
 */
export const STAT_KINDS = Object.freeze(["held", "reading", "completed", "saved", "owned"]);

// Three of the five labels are written in the second person — "books YOU have
// now" — which is right on your own profile and wrong on anybody else's. Each
// card therefore carries both, and `variant` picks the voice.
const CARDS = Object.freeze({
  held:      { color: "bg-statPurple", icon: "user",     labelKey: "ownedBooks",     memberLabelKey: "memberHeldTitle",    route: "/profile/owned" },
  reading:   { color: "bg-statGreen",  icon: "calendar", labelKey: "readingNow",     memberLabelKey: "memberReadingTitle", route: "/profile/reading" },
  completed: { color: "bg-statRed",    icon: "check",    labelKey: "completed",      memberLabelKey: "completed",          route: "/profile/completed" },
  saved:     { color: "bg-statPink",   icon: "heart",    labelKey: "saved",          memberLabelKey: "saved",              route: "/profile/saved" },
  owned:     { color: "bg-brand-50",   icon: "book",     labelKey: "ownerBooksCard", memberLabelKey: "memberOwnedTitle",   route: "/profile/my-books" },
});

/** The route a counter opens on the reader's *own* profile. */
export function statRoute(kind) {
  return CARDS[kind]?.route ?? "/profile";
}

/**
 * @param stats   `{ held, reading, completed, saved, owned }` — plain counts.
 * @param onSelect called with the kind. The own-profile screen navigates; the
 *   other-member screen swaps the list below instead, which is why this is a
 *   callback rather than a `<Link>` baked into the card.
 * @param active  the kind currently expanded, if the caller works that way.
 * @param note    optional secondary line, keyed by kind (the book being read).
 * @param variant "self" or "member" — which voice the labels are written in.
 */
export default function ProfileStatCards({ stats, onSelect, active = null, note = {}, variant = "self" }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {STAT_KINDS.map((kind, i) => {
        const card = CARDS[kind];
        const isLast = i === STAT_KINDS.length - 1;
        const odd = STAT_KINDS.length % 2 === 1;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onSelect?.(kind)}
            aria-pressed={active ? active === kind : undefined}
            className={
              "text-left rounded-2xl p-4 transition-all active:scale-[0.98] " +
              card.color +
              // An odd number of cards leaves a hole in a two-column grid; the
              // last one fills it rather than sitting beside empty space.
              (isLast && odd ? " col-span-2" : "") +
              (active === kind ? " ring-2 ring-brand-500" : "")
            }
          >
            <div className="text-ink-700 mb-2">{renderIcon(card.icon)}</div>
            <h4 className="font-semibold text-[14px] leading-tight">
              {t[variant === "member" ? card.memberLabelKey : card.labelKey]}
            </h4>
            {note[kind] ? <p className="text-[12px] text-ink-500 mt-1 line-clamp-2">{note[kind]}</p> : null}
            <p className="text-[20px] font-bold mt-2">{stats?.[kind] ?? 0}</p>
          </button>
        );
      })}
    </div>
  );
}

function renderIcon(icon) {
  if (icon === "user")     return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" /><path d="M5 20c.6-3.4 3.5-6 7-6s6.4 2.6 7 6" stroke="currentColor" strokeWidth="1.6" /></svg>;
  if (icon === "calendar") return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M4 10h16M8 4v4M16 4v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
  if (icon === "check")    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (icon === "heart")    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
  if (icon === "book")     return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 5.5h5a3 3 0 0 1 3 3v10a2.5 2.5 0 0 0-2.5-2.5H4v-10.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M20 5.5h-5a3 3 0 0 0-3 3v10a2.5 2.5 0 0 1 2.5-2.5H20v-10.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
  return null;
}
