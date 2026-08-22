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

/**
 * The same row, on somebody else's profile — the reader's own three columns, in
 * the reader's own order, so a member profile and your own read as one design
 * rather than two.
 *
 * There is deliberately no `reading` column: the book somebody has open is shown
 * by the CurrentBookCard below, which names it instead of counting it, exactly
 * as on the reader's own profile. There is no `owned` column either; it was a
 * fourth number nobody asked of a person, and the books somebody owns are on
 * the community's own shelf, which is where you go to borrow one.
 *
 * `route` is absent because the routes are per member — the screen builds them
 * from the id in its own URL and passes an `onSelect`. They *are* routes now,
 * though: a counter opens a page, the same as the reader's own does, rather
 * than unfolding a list under the profile it belongs to.
 */
export const MEMBER_STATS = Object.freeze([
  { key: "saved",     labelKey: "statSaved" },
  { key: "completed", labelKey: "statCompleted" },
  { key: "held",      labelKey: "statHeld" },
]);

/**
 * @param stats    the counts, keyed by stat key.
 * @param columns  which columns to draw — `PROFILE_STATS` or `MEMBER_STATS`.
 * @param onSelect called with the key; omit to make the row read-only.
 * @param active   the key currently expanded, when the row drives a list below.
 */
export default function ProfileStatsRow({ stats, columns = PROFILE_STATS, onSelect, active = null }) {
  return (
    <div className="flex items-stretch">
      {columns.map((stat, i) => (
        <div key={stat.key} className="flex-1 flex items-stretch min-w-0">
          {/* Hairline between columns, not around them — so the row reads as one
              object and the first column has no rule to its left. */}
          {i > 0 ? <span className="w-px bg-ink-100 my-1 shrink-0" aria-hidden="true" /> : null}
          <button
            type="button"
            onClick={() => onSelect?.(stat.key)}
            disabled={!onSelect}
            aria-pressed={active ? active === stat.key : undefined}
            className={
              "flex-1 min-w-0 px-1 py-1 rounded-xl transition active:scale-[0.97] disabled:active:scale-100" +
              (active === stat.key ? " bg-tint" : "")
            }
          >
            <p className="text-[26px] font-bold leading-none tabular-nums">{stats?.[stat.key] ?? 0}</p>
            <p className="text-[12px] text-ink-500 mt-1.5 truncate">{t[stat.labelKey]}</p>
          </button>
        </div>
      ))}
    </div>
  );
}
