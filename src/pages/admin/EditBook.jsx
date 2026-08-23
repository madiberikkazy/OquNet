import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import CoverPicker from "../../components/CoverPicker.jsx";
import { getBook, updateBook, reassignBookOwner, listUsersByCommunity } from "../../firebase/firestore.js";
import { uploadImage } from "../../firebase/storage.js";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { t, GENRES } from "../../utils/i18n.js";
import { PAGE_BANDS, isPageBand, loanDaysForPages, pagesForBook } from "../../utils/bookPages.js";

export default function EditBook() {
  const { id }        = useParams();
  const navigate      = useNavigate();
  const { community } = useCommunity();
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState("");
  const [success, setSuccess]       = useState(false);
  const [members, setMembers]       = useState([]);
  const [showOwner, setShowOwner]   = useState(false);
  // A newly picked cover, uploaded on save. Until then the stored URL is what
  // the book still has.
  const [coverFile, setCoverFile]   = useState(null);
  // The owner as stored, so a save can tell "admin reassigned this" apart from
  // "admin edited the blurb and the owner field came along unchanged".
  const [originalOwnerId, setOriginalOwnerId] = useState("");

  const [form, setForm] = useState({
    name: "", author: "", year: "", pages: "",
    description: "", ownerId: "", coverUrl: "", status: "available", genres: [],
  });

  function upd(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // load book + community members
  useEffect(() => {
    (async () => {
      const book = await getBook(id);
      if (!book) { navigate(-1); return; }
      setForm({
        name:        book.name        || "",
        author:      book.author      || "",
        year:        book.year        || "",
        // Books added before page bands existed have only a loan period, so the
        // band is read back out of it — the form opens on the band that grants
        // the allowance the book already has, not on a blank.
        pages:       pagesForBook(book),
        // Blank for every book added before the field existed, which is exactly
        // right: the edit form is where an admin fills that gap in, and a
        // guessed default would silently label a shelf of unknowns.
        language:    book.language    || "",
        description: book.description || "",
        ownerId:     book.ownerId     || "",
        coverUrl:    book.coverUrl    || "",
        status:      book.status      || "available",
        genres:      book.genres || (book.genre ? [book.genre] : []),
      });
      setOriginalOwnerId(book.ownerId || "");
      if (community?.id) setMembers(await listUsersByCommunity(community.id));
      setLoading(false);
    })();
  }, [id, community?.id]);

  async function handleSave() {
    if (saving) return;
    // Friendly, field-specific messages first — but they are a courtesy, not
    // the contract. `updateBook` runs the same payload through the book schema
    // and refuses anything malformed, so it has the last word.
    if (!form.name.trim() || !form.author.trim()) {
      setError(t.addBookErrName);
      return;
    }
    if (form.genres.length < 1) { setError(t.addBookErrGenre); return; }
    if (!isPageBand(form.pages)) { setError(t.addBookErrPages); return; }
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      // `ownerId` is held out of the general save: `updateBook` refuses it, and
      // replaying it on every unrelated edit is how an owner gets quietly
      // rewritten. Reassignment is its own call, made only when the admin
      // actually picked someone else. Note that neither call touches
      // `holderId` — correcting who a book belongs to, or flipping its status
      // by hand, does not move the physical copy.
      //
      // `genre` is not passed either: it is derived from `genres` by the
      // schema, which is the only way the two can be relied on to agree.
      const { ownerId, ...fields } = form;

      // A picked file becomes a URL only now, on the save the admin asked for —
      // the same reason Add Book waits. `uploadImage` falls back to a data-URL
      // when Storage is unavailable, so the cover is never lost to a failure.
      if (coverFile) {
        fields.coverUrl = await uploadImage(coverFile, `books/${id}_${Date.now()}`);
      }

      await updateBook(id, fields);
      if (coverFile) {
        upd("coverUrl", fields.coverUrl);
        setCoverFile(null);
      }
      if (ownerId && ownerId !== originalOwnerId) {
        await reassignBookOwner(id, ownerId);
        setOriginalOwnerId(ownerId);
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(t[err?.errorKey] || err?.message || t.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const ownerMember = members.find((m) => m.id === form.ownerId);

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell withNav={false}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-2 pb-1">
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold flex-1 truncate">{t.editBookTitle}</h1>
      </div>

      <div className="px-5 pt-4 pb-10 space-y-5">

        {/* ── Cover photo — from the device, or a URL ── */}
        <CoverPicker
          coverUrl={form.coverUrl}
          file={coverFile}
          onFile={setCoverFile}
          onUrlChange={(v) => upd("coverUrl", v)}
        />

        {/* ── Basic info ── */}
        <div className="space-y-3">
          <div>
            <label className="text-[13px] text-ink-500 mb-1 block">{t.name}</label>
            <input
              value={form.name}
              onChange={(e) => upd("name", e.target.value)}
              className="input"
            />
          </div>

          <div>
            <label className="text-[13px] text-ink-500 mb-1 block">{t.author}</label>
            <input
              value={form.author}
              onChange={(e) => upd("author", e.target.value)}
              className="input"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] text-ink-500 mb-1 block">{t.year}</label>
              <select value={form.year} onChange={(e) => upd("year", e.target.value)} className="input">
                <option value="">—</option>
                {Array.from({ length: 120 }, (_, i) => 2025 - i).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[13px] text-ink-500 mb-1 block">{t.pagesLabel}</label>
              <select
                value={form.pages}
                onChange={(e) => upd("pages", Number(e.target.value))}
                className="input"
              >
                {PAGE_BANDS.map((b) => (
                  <option key={b.pages} value={b.pages}>
                    {b.from}–{b.pages} {t.pagesUnit}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {form.pages ? (
            <p className="text-[13px] text-ink-500">
              {t.loanTermLabel}: <span className="font-semibold text-ink-700">
                {loanDaysForPages(form.pages)} {t.loanDaysUnit}
              </span>
            </p>
          ) : null}

          <div>
            <label className="text-[13px] text-ink-500 mb-1 block">{t.description}</label>
            <textarea
              value={form.description}
              onChange={(e) => upd("description", e.target.value)}
              placeholder={t.descriptionPlaceholder}
              rows="4"
              className="input"
            />
          </div>
        </div>

        {/* ── Genre (min 1, max 3) ── */}
        <div>
          <label className="text-[13px] text-ink-500 mb-2 block">
            {t.genre} ({(form.genres || []).length}/3)
          </label>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => {
              const lang = typeof window !== "undefined" ? localStorage.getItem("lang") || "kz" : "kz";
              const genres = form.genres || [];
              const selected = genres.includes(g.value);
              const disabled = !selected && genres.length >= 3;
              return (
                <button
                  key={g.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (selected) {
                      upd("genres", genres.filter((v) => v !== g.value));
                    } else if (genres.length < 3) {
                      upd("genres", [...genres, g.value]);
                    }
                  }}
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

        {/* ── Status ── */}
        <div>
          <label className="text-[13px] text-ink-500 mb-2 block">{t.status}</label>
          <div className="flex gap-2">
            {[
              { v: "available",   label: t.statusAvailable },
              { v: "unavailable", label: t.statusUnavailable },
            ].map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => upd("status", opt.v)}
                className={
                  "px-4 py-2 rounded-xl text-[14px] font-medium transition " +
                  (form.status === opt.v
                    ? "bg-brand-500 text-white"
                    : "bg-ink-100 text-ink-700")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Owner picker ── */}
        <div>
          <label className="text-[13px] text-ink-500 mb-2 block">{t.owner}</label>
          <button
            type="button"
            onClick={() => setShowOwner((v) => !v)}
            className="w-full flex items-center gap-3 bg-ink-100 rounded-xl px-4 py-3 text-left"
          >
            {ownerMember ? (
              <>
                <Avatar
                  src={ownerMember.photoURL}
                  name={`${ownerMember.firstName} ${ownerMember.lastName}`}
                  size={32}
                />
                <span className="flex-1 text-[14px] font-medium">
                  {ownerMember.firstName} {ownerMember.lastName}
                </span>
              </>
            ) : (
              <span className="flex-1 text-[14px] text-ink-500">
                {t.whoHasIt}
              </span>
            )}
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              className={"text-ink-400 transition-transform " + (showOwner ? "rotate-180" : "")}
            >
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          {showOwner ? (
            <ul className="mt-1 border border-ink-100 rounded-xl overflow-hidden bg-surface divide-y divide-ink-100 max-h-60 overflow-y-auto">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => { upd("ownerId", m.id); setShowOwner(false); }}
                    className={
                      "w-full flex items-center gap-3 px-4 py-3 text-left transition " +
                      (form.ownerId === m.id ? "bg-brand-50" : "hover:bg-ink-100/60")
                    }
                  >
                    <Avatar
                      src={m.photoURL}
                      name={`${m.firstName} ${m.lastName}`}
                      size={32}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-medium truncate">
                        {m.firstName} {m.lastName}
                      </p>
                      <p className="text-[12px] text-ink-500">@{m.nickname}</p>
                    </div>
                    {form.ownerId === m.id ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-brand-500 shrink-0">
                        <path d="M5 12l4 4 10-10" stroke="currentColor" strokeWidth="2.4"
                          strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </button>
                </li>
              ))}
              {members.length === 0 ? (
                <li className="px-4 py-6 text-center text-ink-500 text-[13px]">{t.noMembers}</li>
              ) : null}
            </ul>
          ) : null}
        </div>

        {/* ── Feedback ── */}
        {error   ? <p className="text-bad text-[13px]">{error}</p>   : null}
        {success ? <p className="text-ok  text-[13px]">{t.bookSaved}</p> : null}

        {/* ── Save ── */}
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saving ? "…" : t.save}
        </button>

      </div>
    </MobileShell>
  );
}
