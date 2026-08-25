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
import { t } from "../../utils/i18n.js";
import BookFields from "../../components/BookFields.jsx";
import { isPageBand } from "../../utils/bookPages.js";
import { logger } from "../../utils/logger.js";

export default function AddBook() {
  const navigate = useNavigate();
  const { community } = useCommunity();
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "", author: "", year: "", givenAt: "", pages: "", language: "",
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
          title: t.newBookNotifTitle,
          body: t.newBookNotifBody(book.name, book.author),
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
    <MobileShell
      withNav={false}
      // Not markup inside the page: an `absolute` button here anchors to the
      // document's first screenful, so once the form grew past one screen it
      // stopped following the window and came to rest on top of the fields.
      // The shell's slot is fixed to the window and reserves the room it
      // covers, which is the whole reason the slot exists.
      bottomBar={
        <button onClick={onNext} disabled={submitting} className="btn-primary">
          {submitting ? "..." : t.next}
        </button>
      }
    >
      <div className="flex items-center gap-2 px-4">
        <button onClick={() => (step > 1 ? setStep(step - 1) : navigate(-1))} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <div className="flex-1">
          <Stepper step={step} total={3} title={step === 3 ? t.addBookFinalStepTitle : t.addBookTitle} />
        </div>
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="px-5 pt-3">
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

    </MobileShell>
  );
}

function Step1({ form, update }) {
  return (
    <div>
      <h2 className="text-xl font-bold mb-3">{t.basicData}</h2>
      {/* The same field set the applicant fills in to join, and the same one the
          admin sees when reviewing that application — one definition, so a book
          added here and a book arriving with a join request describe the same
          thing. */}
      <BookFields form={form} onChange={update} />
    </div>
  );
}

function Step2({ members, search, setSearch, selectedId, onSelect }) {
  return (
    <div>
      <h2 className="text-xl font-bold mb-3">{t.whoHasIt}</h2>
      <SearchBar value={search} onChange={setSearch} placeholder={t.searchByNickname} showFilter={false} />
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
        {members.length === 0 ? <li className="text-center py-8 text-ink-500">{t.noMembers}</li> : null}
      </ul>
    </div>
  );
}

