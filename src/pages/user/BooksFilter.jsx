import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import RangeSlider from "../../components/RangeSlider.jsx";
import { BOOK_LANGUAGES, GENRES, genreLabel, t } from "../../utils/i18n.js";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listBookAuthors } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import {
  EMPTY_FILTERS, LANGUAGE_UNSET, PAGES_MAX, PAGES_MIN, PAGE_STEP,
  YEAR_MAX, YEAR_MIN,
  activeFilterCount, readFilters, writeFilters,
} from "../../utils/bookFilters.js";

/**
 * The filter screen: a page of its own rather than the sheet it used to be.
 *
 * Six filters do not fit in a modal on a phone — the sheet ended up scrolling
 * inside a page that also scrolled, which is the gesture nobody wins — and two
 * of these are sliders, where a drag that starts near the sheet's edge gets
 * read as a dismissal. A route also gives the state somewhere to live: the
 * filters are in the URL, so the back button is "cancel", the browser's forward
 * button is "reapply", and a narrowed shelf is a link that can be shared.
 *
 * Edits are local until Show results. A screen that applied each change as it
 * was made would re-query the shelf six times while someone made up their mind,
 * and every one of those is billed.
 */
export default function BooksFilter() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { lang } = useLang();
  const { community } = useCommunity();

  // Seeded once from the URL: this screen owns the draft while it is open, and
  // re-reading the params on every render would fight the user's edits.
  const [draft, setDraft] = useState(() => readFilters(params));

  const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }));

  function toggleIn(key, value) {
    const list = draft[key];
    set({ [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] });
  }

  function apply() {
    const next = writeFilters(draft);
    const query = next.toString();
    // `replace`, not push: the filter screen is a step in a decision, not a
    // place to come back to. Pushing would put it between the shelf and
    // wherever the reader came from, so Back from the results would reopen the
    // filters they just dismissed.
    navigate(query ? `/books?${query}` : "/books", { replace: true });
  }

  function clearAll() {
    // The sort survives. It is set from the shelf, not from here, and nothing
    // on this screen names it — clearing something the reader cannot see is
    // how a control earns a reputation for doing more than it says.
    setDraft((prev) => ({ ...EMPTY_FILTERS, sort: prev.sort }));
  }

  // One read of the shelf's authors, cached for the session. Fetched on open
  // rather than on the first keystroke: the list is what makes the field
  // discoverable — a reader who does not already know a name on the shelf has
  // nothing to type — so it has to be there before the typing starts.
  const authorsQuery = useQuery({
    queryKey: qk.books.authors(community?.id),
    enabled: !!community?.id,
    queryFn: () => listBookAuthors({ communityId: community.id }),
    staleTime: 5 * 60_000,
  });

  const authorSuggestions = useMemo(() => {
    const all = authorsQuery.data || [];
    const typed = draft.author.trim().toLowerCase();
    // Before anything is typed this is a browsable list of who is on the
    // shelf; after, it narrows. Either way it is capped — a scrolling column
    // of two hundred names under a text field is not a suggestion.
    const matches = typed ? all.filter((a) => a.toLowerCase().includes(typed)) : all;
    // An exact hit is not a suggestion: offering the reader the thing they
    // have already finished typing is a row that can only be a no-op.
    const useful = matches.filter((a) => a.toLowerCase() !== typed);
    return useful.slice(0, 8);
  }, [authorsQuery.data, draft.author]);

  const activeCount = activeFilterCount(draft);

  return (
    <MobileShell
      withNav={false}
      bottomBarSurface
      bottomBar={
        <button onClick={apply} className="btn-primary">
          {t.filterShowResults}
          {activeCount ? ` · ${activeCount}` : ""}
        </button>
      }
      header={
        <div className="flex items-center gap-2 pb-2">
          <button onClick={() => navigate(-1)} className="icon-btn shrink-0" aria-label={t.back}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold flex-1 truncate">{t.filterScreenTitle}</h1>
          {activeCount ? (
            <button
              onClick={clearAll}
              className="text-[13px] font-semibold text-brand-600 shrink-0 px-1"
            >
              {t.filterClearAll}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="px-4 pt-1 space-y-7">
        <Section label={t.filterAvailabilityLabel}>
          <div className="flex flex-wrap gap-2">
            <Chip active={draft.status === null} onClick={() => set({ status: null })}>
              {t.filterAnyOption}
            </Chip>
            <Chip active={draft.status === "available"} onClick={() => set({ status: "available" })}>
              {t.statusAvailable}
            </Chip>
            <Chip active={draft.status === "soon"} onClick={() => set({ status: "soon" })}>
              {t.statusSoon}
            </Chip>
            <Chip active={draft.status === "unavailable"} onClick={() => set({ status: "unavailable" })}>
              {t.statusUnavailable}
            </Chip>
          </div>
        </Section>

        <Section label={t.filterLanguageLabel}>
          <div className="flex flex-wrap gap-2">
            {BOOK_LANGUAGES.map((l) => (
              <Chip
                key={l.value}
                active={draft.languages.includes(l.value)}
                onClick={() => toggleIn("languages", l.value)}
              >
                {l[lang] ?? l.kz}
              </Chip>
            ))}
            {/* The books that predate the field. Last, and worded as an absence
                rather than a language, because it is a gap to be filled rather
                than a choice alongside the others. */}
            <Chip
              active={draft.languages.includes(LANGUAGE_UNSET)}
              onClick={() => toggleIn("languages", LANGUAGE_UNSET)}
            >
              {t.filterLanguageUnset}
            </Chip>
          </div>
        </Section>

        <Section label={t.filterGenreLabel}>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => (
              <Chip
                key={g.value}
                active={draft.genres.includes(g.value)}
                onClick={() => toggleIn("genres", g.value)}
              >
                {genreLabel(g.value)}
              </Chip>
            ))}
          </div>
        </Section>

        <Section label={t.filterAuthorLabel}>
          <input
            value={draft.author}
            onChange={(e) => set({ author: e.target.value })}
            placeholder={t.filterAuthorPlaceholder}
            className="input"
            autoComplete="off"
          />

          {authorSuggestions.length ? (
            <>
              <p className="text-[12px] text-ink-400 mt-2.5 mb-1.5">{t.authorSuggestionsHint}</p>
              {/* Chips rather than a dropdown over the field. A floating list
                  would cover the two sliders below it on a phone, and this
                  field is not a search box that has to stay put — tapping a
                  name fills the field and the list narrows to nothing, which
                  is the same gesture a dropdown gives without the overlay. */}
              <div className="flex flex-wrap gap-2">
                {authorSuggestions.map((author) => (
                  <button
                    key={author}
                    type="button"
                    onClick={() => set({ author })}
                    className="px-3 py-1.5 rounded-full text-[13px] bg-ink-100 text-ink-700 max-w-full truncate"
                  >
                    {author}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </Section>

        <RangeSlider
          label={t.filterPagesLabel}
          min={PAGES_MIN}
          max={PAGES_MAX}
          step={PAGE_STEP}
          value={draft.pages}
          onChange={(pages) => set({ pages })}
          format={(n) => `${n}`}
          anyLabel={t.filterAnyOption}
          fromLabel={t.filterRangeFrom}
          toLabel={t.filterRangeTo}
        />

        <RangeSlider
          label={t.filterYearLabel}
          min={YEAR_MIN}
          max={YEAR_MAX}
          step={1}
          value={draft.years}
          onChange={(years) => set({ years })}
          anyLabel={t.filterAnyOption}
          fromLabel={t.filterRangeFrom}
          toLabel={t.filterRangeTo}
        />
      </div>
    </MobileShell>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <p className="text-[13px] text-ink-500 mb-2.5">{label}</p>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "px-3.5 py-2 rounded-full text-[13px] font-medium transition " +
        (active ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-700")
      }
    >
      {children}
    </button>
  );
}
