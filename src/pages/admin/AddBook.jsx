import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Stepper from "../../components/Stepper.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import CoverPicker from "../../components/CoverPicker.jsx";
import { listUsersByCommunity, createBook, notifyCommunityMembers } from "../../firebase/firestore.js";
import { uploadImage } from "../../firebase/storage.js";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { t, GENRES } from "../../utils/i18n.js";
import { PAGE_BANDS, isPageBand, loanDaysForPages } from "../../utils/bookPages.js";
import { logger } from "../../utils/logger.js";

export default function AddBook() {
  const navigate = useNavigate();
  const { community } = useCommunity();
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "", author: "", year: "", givenAt: "", pages: "",
    description: "", ownerId: "", coverUrl: "", genres: [],
  });
  // The cover can come from the device or from a URL. A picked file is held
  // here and uploaded at submit, so abandoning the wizard uploads nothing.
  const [coverFile, setCoverFile] = useState(null);
  const [members, setMembers] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!community?.id) return;
    let alive = true;
    listUsersByCommunity(community.id)
      .then((rows) => { if (alive) setMembers(Array.isArray(rows) ? rows : []); })
      .catch((err) => {
        if (!alive) return;
        logger.error("addBook.loadMembers", err?.message, { code: err?.code });
        setMembers([]);
      });
    return () => { alive = false; };
  }, [community?.id]);

  const filteredMembers = useMemo(() => {
    if (!search) return members;
    const s = search.toLowerCase();
    return members.filter((m) => m.nickname?.toLowerCase().includes(s));
  }, [members, search]);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function onNext() {
    if (submitting) return; // hard guard against double-tap on slow networks
    setError("");
    if (step === 1) {
      if (!form.name.trim() || !form.author.trim()) { setError(t.addBookErrName); return; }
      if (form.genres.length < 1) { setError(t.addBookErrGenre); return; }
      if (!isPageBand(form.pages)) { setError(t.addBookErrPages); return; }
    }
    if (step === 2 && !form.ownerId) { setError(t.addBookErrOwner); return; }
    if (step < 3) { setStep(step + 1); return; }

    // Step 3 — final submit. The per-step checks above exist to put a friendly
    // localized message next to the field that is wrong; they are not the
    // contract. `createBook` normalizes and re-checks the whole payload and
    // throws if anything is missing, so a step-skipping bypass or a stale form
    // cannot reach the database — the two checks below only spare the user a
    // round trip for the cases the form itself already knows about.
    if (!form.ownerId) { setError(t.addBookErrOwner); return; }
    if (!community?.id) { setError(t.loadFailed); return; }

    setSubmitting(true);
    try {
      // The upload happens here rather than at pick time so the only thing that
      // ever reaches Storage is a cover attached to a book that got created.
      // `uploadImage` degrades to a data-URL if Storage is unreachable, so a
      // failed upload costs the admin nothing.
      let coverUrl = form.coverUrl;
      if (coverFile) {
        coverUrl = await uploadImage(coverFile, `books/${community.id}_${Date.now()}`);
      }

      // Deliberately the raw form: the data layer owns what a book document
      // looks like, including `genre`, `holderId`, `status` and `createdAt`.
      const book = await createBook({ ...form, coverUrl, communityId: community.id });

      // Announce the book to the community — deliberately *not* awaited.
      //
      // The book exists the moment `createBook` resolves; whether every member
      // has been told is a separate concern with a separate failure mode, and
      // making the admin wait for it coupled the length of this screen's spinner
      // to the size of the community. A try/catch alone did not fix that: it
      // isolated the error but not the latency, because the fan-out was awaited
      // before `navigate`.
      //
      // So: fire it, attach a rejection handler so a failure is logged rather
      // than surfacing as an unhandled rejection, and move on. Firestore's SDK
      // keeps the writes in flight across the route change — this is a SPA, the
      // document is never unloaded.
      notifyCommunityMembers({
        communityId: community.id,
        excludeUserId: user?.id,
        notification: {
          title: "Жаңа кітап қосылды",
          body: `«${book.name}» — ${book.author}. Қазір қолжетімді.`,
          type: "new-book",
          bookId: book.id,
        },
      }).catch((notifyErr) => {
        logger.error("addBook.notify", notifyErr?.message, { bookId: book.id });
      });

      navigate(`/books/${book.id}`, { replace: true });
    } catch (err) {
      logger.error("addBook.create", err?.message, { code: err?.code });
      // A SchemaError names the i18n key for whatever it refused, so a payload
      // the form let through still reads as a field error rather than a stack.
      setError(t[err?.errorKey] || err?.message || t.addBookError);
    } finally { setSubmitting(false); }
  }

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4">
        <button onClick={() => (step > 1 ? setStep(step - 1) : navigate(-1))} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <div className="flex-1">
          <Stepper step={step} total={3} title={step === 3 ? "Добавление нового объекта" : t.addBookTitle} />
        </div>
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="px-5 pt-3 pb-24">
        {step === 1 ? <Step1 form={form} update={update} /> : null}
        {step === 2 ? <Step2 members={filteredMembers} search={search} setSearch={setSearch} selectedId={form.ownerId} onSelect={(id) => update("ownerId", id)} /> : null}
        {step === 3 ? (
          <CoverPicker
            coverUrl={form.coverUrl}
            file={coverFile}
            onFile={setCoverFile}
            onUrlChange={(v) => update("coverUrl", v)}
          />
        ) : null}
        {error ? <p className="text-bad text-[13px] mt-3">{error}</p> : null}
      </div>

      <div className="absolute bottom-4 left-0 right-0 px-5 z-10">
        <button onClick={onNext} disabled={submitting} className="btn-primary">
          {submitting ? "..." : t.next}
        </button>
      </div>
    </MobileShell>
  );
}

function Step1({ form, update }) {
  const lang = typeof window !== "undefined" ? localStorage.getItem("lang") || "kz" : "kz";
  const genres = form.genres || [];

  function toggleGenre(value) {
    if (genres.includes(value)) {
      update("genres", genres.filter((g) => g !== value));
    } else if (genres.length < 3) {
      update("genres", [...genres, value]);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-3">{t.basicData}</h2>
      <div className="space-y-3">
        <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder={t.name} className="input" />
        <input value={form.author} onChange={(e) => update("author", e.target.value)} placeholder={t.author} className="input" />
        <div className="grid grid-cols-2 gap-3">
          <select value={form.year} onChange={(e) => update("year", e.target.value)} className="input">
            <option value="">{t.year}</option>
            {Array.from({ length: 120 }, (_, i) => 2025 - i).map((y) => (<option key={y} value={y}>{y}</option>))}
          </select>
          {/* Pages, not days. The admin knows roughly how long the book is;
              how long a reader may keep it follows from that. */}
          <select
            value={form.pages}
            onChange={(e) => update("pages", Number(e.target.value))}
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
        {/* The consequence of the choice above, spelled out where it is made —
            the loan period is never typed in, so this is the only place it can
            be seen before a reader meets it. */}
        {form.pages ? (
          <p className="text-[13px] text-ink-500">
            {t.loanTermLabel}: <span className="font-semibold text-ink-700">
              {loanDaysForPages(form.pages)} {t.loanDaysUnit}
            </span>
          </p>
        ) : null}

        {/* Genre picker — min 1, max 3 */}
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
          <textarea value={form.description} onChange={(e) => update("description", e.target.value)} placeholder={t.descriptionPlaceholder} rows="4" className="input" />
        </label>
      </div>
    </div>
  );
}

function Step2({ members, search, setSearch, selectedId, onSelect }) {
  return (
    <div>
      <h2 className="text-xl font-bold mb-3">{t.whoHasIt}</h2>
      <SearchBar value={search} onChange={setSearch} placeholder="Поиск по никнейму" showFilter={false} />
      <ul className="mt-3 divide-y divide-ink-100">
        {members.map((m) => (
          <li key={m.id}>
            <button onClick={() => onSelect(m.id)} className={"w-full flex items-center gap-3 py-3 px-2 text-left " + (selectedId === m.id ? "bg-brand-50 rounded-lg" : "")}>
              <span className="flex-1">{m.nickname}</span>
              {selectedId === m.id ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                  <path d="M5 12l4 4 10-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </button>
          </li>
        ))}
        {members.length === 0 ? <li className="text-center py-8 text-ink-500">Нет участников</li> : null}
      </ul>
    </div>
  );
}

