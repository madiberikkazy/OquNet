export default function SearchBar({
  value, onChange, placeholder = "Search...", showFilter = true, onFilterClick, onBack, filterActive = false,
  // Anything a screen wants to sit to the right of the field — Home puts its
  // liked-posts shortcut there, where the filter button lives on Books.
  rightSlot = null,
}) {
  return (
    <div className="flex items-center gap-2 px-4">
      {onBack ? (
        <button aria-label="Back" onClick={onBack} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <div className="flex-1 relative">
        <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
          <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          value={value || ""}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-ink-100 rounded-2xl pl-10 pr-12 py-3 text-[15px] placeholder-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>
      {rightSlot}
      {showFilter ? (
        <button aria-label="Filter" onClick={onFilterClick} className="icon-btn shrink-0 relative">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {filterActive ? (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-brand-500 ring-2 ring-base" />
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
