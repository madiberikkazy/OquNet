import { GENRES, t } from "../utils/i18n.js";
import { PAGE_BANDS, loanDaysForPages } from "../utils/bookPages.js";

/**
 * Everything a book needs before it can go on a shelf, as one field set.
 *
 * Three screens ask for these now and they have to agree: the admin adding a
 * book, the applicant who has to bring one to join, and the admin reviewing
 * what that applicant submitted. The applicant is filling in the very document
 * the admin will approve, so a form that asked for less would just move the
 * missing half onto the admin's desk — which is the thing this replaces.
 *
 * The cover is deliberately not here. Add Book collects it on a step of its
 * own, and the two review screens put it above the fields, so the parent owns
 * where it goes and this owns what it means.
 */
export default function BookFields({ form, onChange }) {
  const lang = typeof window !== "undefined" ? localStorage.getItem("lang") || "kz" : "kz";
  const genres = form.genres || [];

  function toggleGenre(value) {
    if (genres.includes(value)) {
      onChange("genres", genres.filter((g) => g !== value));
    } else if (genres.length < 3) {
      onChange("genres", [...genres, value]);
    }
  }

  return (
    <div className="space-y-3">
      <input
        value={form.name || ""}
        onChange={(e) => onChange("name", e.target.value)}
        placeholder={t.name}
        className="input"
      />
      <input
        value={form.author || ""}
        onChange={(e) => onChange("author", e.target.value)}
        placeholder={t.author}
        className="input"
      />

      <div className="grid grid-cols-2 gap-3">
        <select
          value={form.year || ""}
          onChange={(e) => onChange("year", e.target.value)}
          className="input"
        >
          <option value="">{t.year}</option>
          {Array.from({ length: 120 }, (_, i) => new Date().getFullYear() - i).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        {/* Pages, not days — the loan period follows from the length of the
            book, and this is where that gets decided. */}
        <select
          value={form.pages || ""}
          onChange={(e) => onChange("pages", Number(e.target.value))}
          className="input"
        >
          <option value="">{t.pagesLabel}</option>
          {PAGE_BANDS.map((b) => (
            <option key={b.pages} value={b.pages}>
              {b.from}–{b.pages} {t.pagesUnit}
            </option>
          ))}
        </select>
      </div>

      {form.pages ? (
        <p className="text-[13px] text-ink-500">
          {t.loanTermLabel}: <span className="font-semibold text-ink-700">
            {loanDaysForPages(form.pages)} {t.loanDaysUnit}
          </span>
        </p>
      ) : null}

      <div>
        <span className="text-[13px] text-ink-500 mb-2 block">
          {t.genre} ({genres.length}/3)
        </span>
        <div className="flex flex-wrap gap-2">
          {GENRES.map((g) => {
            const selected = genres.includes(g.value);
            const disabled = !selected && genres.length >= 3;
            return (
              <button
                key={g.value}
                type="button"
                onClick={() => toggleGenre(g.value)}
                disabled={disabled}
                className={
                  "px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors " +
                  (selected
                    ? "bg-brand-500 text-white"
                    : disabled
                      ? "bg-ink-100 text-ink-300 cursor-not-allowed"
                      : "bg-ink-100 text-ink-700")
                }
              >
                {g[lang] ?? g.kz}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block">
        <span className="text-[13px] text-ink-500 mb-1 block">{t.description}</span>
        <textarea
          value={form.description || ""}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder={t.descriptionPlaceholder}
          rows="4"
          className="input"
        />
      </label>
    </div>
  );
}
