import { GENRES, t, getCurrentLang } from "../utils/i18n.js";

/**
 * Horizontal genre picker that lives right under the search bar.
 *
 * Genres are the one filter people reach for constantly, so they sit in the
 * open here instead of behind the filter icon — everything else (status) stays
 * in the modal. Selection is multi-choice, matching the `genres` array the list
 * query already takes; "all" simply means an empty array.
 *
 * `single` narrows that to one at a time, for the card view: there the chips do
 * not narrow a list, they *open* a genre — a shelf is one genre's shelf — so
 * picking a second one has to replace the first rather than intersect with it.
 * The shape of the value stays an array either way, so the caller reads the
 * same prop in both views.
 */
export default function GenreBar({ selected = [], onChange, single = false }) {
  const lang = getCurrentLang();

  function toggle(value) {
    if (single) {
      // Tapping the open genre again closes it, which is the same "all" the
      // first pill means — one gesture back out, wherever the finger already is.
      onChange?.(selected.includes(value) ? [] : [value]);
      return;
    }
    onChange?.(
      selected.includes(value)
        ? selected.filter((g) => g !== value)
        : [...selected, value]
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 py-1">
      <Pill active={selected.length === 0} onClick={() => onChange?.([])}>
        {t.genreAll}
      </Pill>
      {GENRES.map((g) => (
        <Pill key={g.value} active={selected.includes(g.value)} onClick={() => toggle(g.value)}>
          {g[lang] ?? g.kz}
        </Pill>
      ))}
    </div>
  );
}

function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        "shrink-0 px-4 py-2 rounded-2xl text-[14px] font-medium whitespace-nowrap transition " +
        (active ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-500")
      }
    >
      {children}
    </button>
  );
}
