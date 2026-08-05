import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Stepper from "../../components/Stepper.jsx";
import { createCommunity, updateUser, getUsernameEntry, getCommunityByNickname } from "../../firebase/firestore.js";
import { normalizeUserMembership } from "../../firebase/schema.js";
import { uploadImage } from "../../firebase/storage.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { t } from "../../utils/i18n.js";

export default function CreateCommunity() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { setCommunity } = useCommunity();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    nickname: "", name: "", isPrivate: false, notificationsEnabled: true,
  });
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState(""); // human-readable progress label
  const photoInputRef = useRef(null);

  function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    // reset so same file can be re-selected after removal
    e.target.value = "";
  }

  function removePhoto() {
    setPhotoFile(null);
    if (photoPreview) { URL.revokeObjectURL(photoPreview); setPhotoPreview(null); }
  }

  async function next() {
    setError("");
    if (step === 1) {
      if (!form.nickname.trim() || !form.name.trim()) {
        setError("Заполните оба поля");
        return;
      }
      const [userMatch, communityMatch] = await Promise.all([
        getUsernameEntry(form.nickname),
        getCommunityByNickname(form.nickname),
      ]);
      if (userMatch || communityMatch) {
        setError("Бұл никнейм бос емес. Басқа никнейм таңдаңыз.");
        return;
      }
    }
    if (step < 4) { setStep(step + 1); return; }
    submit();
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      let photoURL = "";
      if (photoFile) {
        setSubmitStatus("Загрузка фото…");
        photoURL = await uploadImage(photoFile, `communities/${form.nickname}`);
      }

      setSubmitStatus("Создание сообщества…");
      const c = await createCommunity({
        ...form,
        photoURL,
        ownerId: user.id,
        memberIds: [user.id],
      });

      setSubmitStatus("Сохранение…");
      await updateUser(user.id, normalizeUserMembership({ communityId: c.id, role: "admin" }));

      setCommunity(c);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err?.message || "Ошибка создания");
    } finally {
      setSubmitting(false);
      setSubmitStatus("");
    }
  }

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4">
        <button
          onClick={() => (step > 1 ? setStep(step - 1) : navigate(-1))}
          className="icon-btn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="flex-1">
          <Stepper step={step} total={4} title="Новое сообщество" />
        </div>
      </div>

      {/* Info banner — only shown if user is already in a community as a member */}
      {user?.communityId && user?.role !== "admin" ? (
        <div className="mx-4 mt-3 px-4 py-3 bg-warnSoft text-warn rounded-xl text-[13px]">
          Вы покинете текущее сообщество и станете администратором нового.
        </div>
      ) : null}

      <div className="px-5 pt-3 pb-24 space-y-3">
        {step === 1 ? (
          <>
            <h2 className="text-xl font-bold mb-2">Шаг 1 — Основное</h2>
            <input
              value={form.nickname}
              onChange={(e) =>
                setForm({ ...form, nickname: e.target.value.replace(/\s/g, "").toLowerCase() })
              }
              placeholder={t.communityNickname + " (aiu.oqyrman)"}
              className="input"
            />
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t.communityName}
              className="input"
            />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h2 className="text-xl font-bold mb-2">Қадам 2 — Формат</h2>
            <p className="text-[13px] text-ink-500 mb-3">Қоғамдастықтың көріну режимін таңдаңыз</p>

            <button
              type="button"
              onClick={() => setForm({ ...form, isPrivate: false })}
              className={
                "w-full flex items-center gap-4 p-4 rounded-2xl border-2 transition mb-3 text-left " +
                (!form.isPrivate
                  ? "border-brand-500 bg-brand-50"
                  : "border-ink-100 bg-surface")
              }
            >
              <div className={
                "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 " +
                (!form.isPrivate ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-500")
              }>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="font-semibold text-[15px]">Ашық (Public)</p>
                <p className="text-[13px] text-ink-500 mt-0.5">Барлығы мүшелерді, кітаптарды және жазбаларды көре алады</p>
              </div>
              {!form.isPrivate && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-brand-500 shrink-0">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={() => setForm({ ...form, isPrivate: true })}
              className={
                "w-full flex items-center gap-4 p-4 rounded-2xl border-2 transition text-left " +
                (form.isPrivate
                  ? "border-brand-500 bg-brand-50"
                  : "border-ink-100 bg-surface")
              }
            >
              <div className={
                "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 " +
                (form.isPrivate ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-500")
              }>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="font-semibold text-[15px]">Жабық (Private)</p>
                <p className="text-[13px] text-ink-500 mt-0.5">Тек мүшелер ішкі контентті көреді. Бейтаныс адамдар тек атауды ғана көреді</p>
              </div>
              {form.isPrivate && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-brand-500 shrink-0">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h2 className="text-xl font-bold mb-2">Қадам 3 — Хабарламалар</h2>
            <label className="card p-4 flex items-center gap-3">
              <input
                type="checkbox"
                checked={form.notificationsEnabled}
                onChange={(e) => setForm({ ...form, notificationsEnabled: e.target.checked })}
                className="w-5 h-5 accent-brand-500"
              />
              <span className="text-[14px]">
                Мүшелер үшін жүйелік хабарламаларды қосу
              </span>
            </label>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h2 className="text-xl font-bold mb-2">Қадам 4 — {t.communityPhoto}</h2>

            {/* Hidden file input — triggered by button click via ref */}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
            />

            {photoPreview ? (
              /* ── Preview + actions ── */
              <div className="relative rounded-2xl overflow-hidden h-48 bg-ink-100">
                <img
                  src={photoPreview}
                  alt="Превью аватара"
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-3 right-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-xl bg-surface/90 text-[13px] font-medium text-ink-700 shadow"
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    onClick={removePhoto}
                    className="px-3 py-1.5 rounded-xl bg-bad/90 text-[13px] font-medium text-white shadow"
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ) : (
              /* ── Upload area ── */
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="w-full h-48 rounded-2xl bg-brand-50 border-2 border-dashed border-brand-200
                           flex flex-col items-center justify-center gap-3
                           text-brand-500 hover:bg-brand-100 transition active:scale-[0.99] cursor-pointer"
              >
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.12" />
                  <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="text-[14px] font-medium">Выбрать фото</span>
                <span className="text-[12px] text-brand-400">JPG, PNG, WEBP</span>
              </button>
            )}
          </>
        ) : null}

        {error ? <p className="text-bad text-[13px]">{error}</p> : null}
      </div>

      <div className="absolute bottom-4 left-0 right-0 px-5">
        <button onClick={next} disabled={submitting} className="btn-primary">
          {submitting ? (submitStatus || "…") : step === 4 ? "Жасау" : t.next}
        </button>
      </div>
    </MobileShell>
  );
}