import { t } from "../utils/i18n.js";

/**
 * The five shelves of a *member* profile, as a grid of selectable cards.
 *
 * The reader's own profile shows three counters in a row instead — see
 * ProfileStatsRow. This grid exists because a member profile has to expose five
 * lists with nowhere to navigate to: tapping a card swaps the list underneath it.
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

// Labels are in the third person throughout — "currently holding", not "books
// you have now". This grid only ever describes somebody else.
const CARDS = Object.freeze({
  held:      { color: "bg-statPurple", icon: "user",     labelKey: "memberHeldTitle" },
  reading:   { color: "bg-statGreen",  icon: "calendar", labelKey: "memberReadingTitle" },
  completed: { color: "bg-statRed",    icon: "check",    labelKey: "completed" },
  saved:     { color: "bg-statPink",   icon: "heart",    labelKey: "saved" },
  owned:     { color: "bg-tint",       icon: "book",     labelKey: "memberOwnedTitle" },
});

/**
 * @param stats   `{ held, reading, completed, saved, owned }` — plain counts.
 * @param onSelect called with the kind; the caller swaps the list below.
 * @param active  the kind currently expanded.
 */
export default function ProfileStatCards({ stats, onSelect, active = null }) {
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
            <h4 className="font-semibold text-[14px] leading-tight">{t[card.labelKey]}</h4>
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
