import { t } from "../utils/i18n.js";

/**
 * The three counters under the name: saved, finished, and in hand.
 *
 * A row of numbers rather than the card grid this replaced. The cards each had
 * to state which shelf they meant, so the labels grew long enough to wrap; a
 * number over one word reads at a glance, which is all a counter has to do. The
 * lists behind them are still a tap away.
 *
 * `Қазір бар` is the books physically with the reader — what they are holding,
 * not what they own. Books they own but have lent out are on the borrower's row,
 * not here, and the member profile is where an owned-books list still lives.
 */
export const PROFILE_STATS = Object.freeze([
  { key: "saved",     labelKey: "statSaved",     route: "/profile/saved" },
  { key: "completed", labelKey: "statCompleted", route: "/profile/completed" },
  { key: "held",      labelKey: "statHeld",      route: "/profile/owned" },
]);

export default function ProfileStatsRow({ stats, onSelect }) {
  return (
    <div className="flex items-stretch">
      {PROFILE_STATS.map((stat, i) => (
        <div key={stat.key} className="flex-1 flex items-stretch min-w-0">
          {/* Hairline between columns, not around them — so the row reads as one
              object and the first column has no rule to its left. */}
          {i > 0 ? <span className="w-px bg-ink-100 my-1 shrink-0" aria-hidden="true" /> : null}
          <button
            type="button"
            onClick={() => onSelect?.(stat.key)}
            disabled={!onSelect}
            className="flex-1 min-w-0 px-1 py-1 rounded-xl transition active:scale-[0.97] disabled:active:scale-100"
          >
            <p className="text-[26px] font-bold leading-none tabular-nums">{stats?.[stat.key] ?? 0}</p>
            <p className="text-[12px] text-ink-500 mt-1.5 truncate">{t[stat.labelKey]}</p>
          </button>
        </div>
      ))}
    </div>
  );
}
