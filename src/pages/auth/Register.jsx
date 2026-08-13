import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Stepper from "../../components/Stepper.jsx";
import {
  startEmailRegistration,
  finalizeRegistration,
  refreshEmailVerified,
  resendVerificationEmail,
  cancelPendingRegistration,
  signInWithGoogle,
} from "../../firebase/auth.js";
import { logger } from "../../utils/logger.js";
import { uploadImage } from "../../firebase/storage.js";
import { getUsernameEntry } from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { t, SUPPORTED_LANGS } from "../../utils/i18n.js";

export default function Register() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const { lang, setLang } = useLang();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    nickname: "",
    firstName: "",
    lastName: "",
    address: "",
    notificationsEnabled: true,
    acceptedTerms: false,
  });
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  // Email-verification gate state
  const [verifyState, setVerifyState] = useState(null); // null | { uid }
  const [verifyBusy, setVerifyBusy]   = useState(false);
  const [resendBusy, setResendBusy]   = useState(false);
  const [resendOk, setResendOk]       = useState(false);

  // Live nickname availability
  const [nickStatus, setNickStatus] = useState(null); // null | "checking" | "available" | "taken"
  const nickTimer = useRef(null);

  const photoInputRef = useRef(null);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Debounced nickname check
  useEffect(() => {
    const nick = form.nickname.trim();
    if (!nick || nick.length < 2) { setNickStatus(null); return; }
    setNickStatus("checking");
    clearTimeout(nickTimer.current);
    nickTimer.current = setTimeout(async () => {
      try {
        const existing = await getUsernameEntry(nick);
        setNickStatus(existing ? "taken" : "available");
      } catch {
        setNickStatus(null);
      }
    }, 400);
    return () => clearTimeout(nickTimer.current);
  }, [form.nickname]);

  async function onGoogle() {
    setError("");
    setGoogleBusy(true);
    try {
      const profile = await signInWithGoogle();
      setUser(profile);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err?.message || "Google кіру қатесі");
    } finally {
      setGoogleBusy(false);
    }
  }

  function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    e.target.value = "";
  }

  function removePhoto() {
    setPhotoFile(null);
    if (photoPreview) { URL.revokeObjectURL(photoPreview); setPhotoPreview(null); }
  }

  async function next() {
    if (submitting || verifyBusy) return;
    setError("");

    if (step === 1) {
      if (!/^\S+@\S+\.\S+$/.test(form.email)) { setError(t.registerErrEmail); return; }
      if (form.password.length < 6) { setError(t.registerErrPasswordShort); return; }
      if (form.password !== form.confirmPassword) { setError(t.registerErrPasswordMatch); return; }
      // Kick off auth creation + verification email, then show the gate.
      setSubmitting(true);
      try {
        const result = await startEmailRegistration({
          email: form.email,
          password: form.password,
        });
        if (result?.verified) {
          // Either mock mode or some flow returned an already-verified user.
          setVerifyState({ uid: result.uid });
          setStep(2);
        } else {
          setVerifyState({ uid: result.uid });
          // If Firebase accepted the account but rejected the verification-email send,
          // tell the user up front rather than letting them stare at a quiet inbox.
          if (result?.sendError) setError(result.sendError);
        }
      } catch (err) {
        logger.warn("register.startEmail", err?.message, { code: err?.code });
        setError(prettyError(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (step === 2) {
      if (!form.nickname.trim()) { setError(t.registerErrNickname); return; }
      if (nickStatus === "taken") { setError(t.nicknameTaken); return; }
      if (nickStatus === "checking") { setError(t.registerErrCheckingNick); return; }
    }

    if (step < 3) { setStep(step + 1); return; }

    if (!form.acceptedTerms) {
      setError(t.registerMustAcceptTerms);
      return;
    }

    // Step 3 — submit
    await submit();
  }

  /** Verification gate: poll Firebase for emailVerified and advance to Step 2 if true. */
  async function checkVerified() {
    if (verifyBusy) return;
    setVerifyBusy(true);
    setError("");
    try {
      const ok = await refreshEmailVerified();
      if (ok) {
        setStep(2);
      } else {
        setError(t.emailNotVerified);
      }
    } catch (err) {
      logger.warn("register.checkVerified", err?.message, { code: err?.code });
      setError(prettyError(err));
    } finally {
      setVerifyBusy(false);
    }
  }

  async function handleResend() {
    if (resendBusy) return;
    setResendBusy(true);
    setResendOk(false);
    setError("");
    try {
      await resendVerificationEmail();
      setResendOk(true);
    } catch (err) {
      logger.warn("register.resendVerify", err?.message, { code: err?.code });
      setError(prettyError(err));
    } finally {
      setResendBusy(false);
    }
  }

  /** "Change email" — discard the half-created auth user and go back to Step 1. */
  async function handleChangeEmail() {
    if (verifyBusy || submitting) return;
    setVerifyBusy(true);
    try {
      await cancelPendingRegistration();
    } catch (err) {
      logger.warn("register.cancelPending", err?.message, { code: err?.code });
    } finally {
      setVerifyState(null);
      setResendOk(false);
      setError("");
      setVerifyBusy(false);
    }
  }

  async function submit() {
    if (!form.acceptedTerms) {
      setError(t.registerMustAcceptTerms);
      return;
    }
    if (!verifyState?.uid) {
      setError(t.sessionExpired);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      let photoURL = "";
      if (photoFile) {
        photoURL = await uploadImage(photoFile, `avatars/${form.email}_${Date.now()}`);
      }
      const profile = await finalizeRegistration({
        uid: verifyState.uid,
        email: form.email,
        password: form.password,
        nickname: form.nickname,
        firstName: form.firstName,
        lastName: form.lastName,
        address: form.address,
        notificationsEnabled: form.notificationsEnabled,
        photoURL,
      });
      setUser(profile);
      navigate("/", { replace: true });
    } catch (err) {
      logger.error("register.finalize", err?.message, { code: err?.code });
      setError(prettyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const onVerifyGate = step === 1 && !!verifyState;

  return (
    <MobileShell withNav={false}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4">
        <button
          onClick={() => {
            if (onVerifyGate) { handleChangeEmail(); return; }
            return step > 1 ? setStep(step - 1) : navigate(-1);
          }}
          className="icon-btn"
          aria-label={t.back}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="flex-1">
          <Stepper step={step} total={3} title={t.signUp} />
        </div>
      </div>

      <div className="px-6 pt-3 pb-28 space-y-3">
        {/* ── Email-verification gate (between Step 1 form and Step 2) ── */}
        {onVerifyGate && (
          <div className="pt-3">
            <div className="w-16 h-16 mx-auto rounded-full bg-brand-50 text-brand-500 flex items-center justify-center mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M4 7l8 6 8-6M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2"
                  stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-center">{t.verifyEmailTitle}</h2>
            <p className="text-[13px] text-ink-500 text-center mt-1">{t.verifyEmailBody}</p>
            <p className="text-[14px] font-semibold text-center break-all mt-1">{form.email}</p>
            <p className="text-[13px] text-ink-500 text-center mt-3 leading-snug">{t.verifyEmailHint}</p>
            <p className="text-[12px] text-ink-400 text-center mt-2">{t.checkSpamFolder}</p>

            {/* Surface any error from the send attempt right on the gate. */}
            {error ? (
              <div className="mt-4 rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2 break-words">
                {error}
              </div>
            ) : null}

            <div className="mt-6 space-y-2">
              <button
                onClick={handleResend}
                disabled={resendBusy}
                className="w-full py-2.5 rounded-2xl text-[13px] font-semibold text-brand-500 bg-brand-500/10 hover:bg-brand-500/15 transition disabled:opacity-60"
              >
                {resendBusy ? t.verificationSending : t.resendEmail}
              </button>
              {resendOk ? (
                <p className="text-[12px] text-ok text-center">{t.resendSent}</p>
              ) : null}
              <button
                onClick={handleChangeEmail}
                disabled={verifyBusy}
                className="w-full py-2.5 text-[13px] font-medium text-ink-500 disabled:opacity-60"
              >
                ← {t.changeEmail}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 1: Email & Password (hidden once the gate is showing) ── */}
        {step === 1 && !onVerifyGate && (
          <>
            {/* Language picker — visible on the very first launch screen */}
            <div className="mb-2">
              <p className="text-[12px] text-ink-500 mb-1.5">{t.selectLanguage}</p>
              <div className="flex gap-2">
                {SUPPORTED_LANGS.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => setLang(l.code)}
                    className={
                      "flex-1 py-2 rounded-xl text-[13px] font-medium transition-colors " +
                      (lang === l.code
                        ? "bg-brand-500 text-white"
                        : "bg-ink-100 text-ink-700")
                    }
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            <h2 className="text-xl font-bold mb-1">{t.registerEmailStepTitle}</h2>

            <label className="block">
              <span className="text-[13px] text-ink-500 mb-1 block">{t.email}</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="input"
              />
            </label>

            <label className="block">
              <span className="text-[13px] text-ink-500 mb-1 block">{t.password}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder={t.passwordMin}
                autoComplete="new-password"
                className="input"
              />
            </label>

            <label className="block">
              <span className="text-[13px] text-ink-500 mb-1 block">{t.confirmPassword}</span>
              <input
                type="password"
                value={form.confirmPassword}
                onChange={(e) => update("confirmPassword", e.target.value)}
                autoComplete="new-password"
                className="input"
              />
            </label>

            {/* Divider */}
            <div className="flex items-center gap-3 py-1">
              <div className="flex-1 h-px bg-ink-200" />
              <span className="text-[12px] text-ink-400">{t.or}</span>
              <div className="flex-1 h-px bg-ink-200" />
            </div>

            {/* Google sign-in */}
            <button
              type="button"
              disabled={googleBusy}
              onClick={onGoogle}
              className="w-full flex items-center justify-center gap-3 py-3 rounded-2xl border border-ink-200 bg-surface text-ink-700 font-medium text-[14px] active:scale-[0.98] transition disabled:opacity-60"
            >
              <GoogleIcon />
              {googleBusy ? "..." : t.signUpWithGoogle}
            </button>

            <p className="text-center text-[14px] text-ink-500 pt-1">
              {t.haveAccount}{" "}
              <Link to="/auth/login" className="text-brand-500 font-medium">{t.signIn}</Link>
            </p>
          </>
        )}

        {/* ── Step 2: Nickname, Name, Phone ── */}
        {step === 2 && (
          <>
            <h2 className="text-xl font-bold mb-1">{t.registerProfileStepTitle}</h2>

            <label className="block">
              <span className="text-[13px] text-ink-500 mb-1 block">{t.nickname} *</span>
              <input
                value={form.nickname}
                onChange={(e) => update("nickname", e.target.value.replace(/\s/g, "").toLowerCase())}
                placeholder="myhandle"
                autoComplete="username"
                className="input"
              />
              {/* Live availability indicator */}
              {form.nickname.trim().length >= 2 && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  {nickStatus === "checking" && (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-ink-300 border-t-transparent animate-spin" />
                      <span className="text-[12px] text-ink-400">{t.registerNicknameChecking}</span>
                    </>
                  )}
                  {nickStatus === "available" && (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="text-[12px] text-ok font-medium">@{form.nickname} — {t.registerNicknameAvailable}</span>
                    </>
                  )}
                  {nickStatus === "taken" && (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                      <span className="text-[12px] text-bad font-medium">@{form.nickname} — {t.registerNicknameTaken}</span>
                    </>
                  )}
                </div>
              )}
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[13px] text-ink-500 mb-1 block">{t.firstName}</span>
                <input
                  value={form.firstName}
                  onChange={(e) => update("firstName", e.target.value)}
                  placeholder={t.optional}
                  className="input"
                />
              </label>
              <label className="block">
                <span className="text-[13px] text-ink-500 mb-1 block">{t.lastName}</span>
                <input
                  value={form.lastName}
                  onChange={(e) => update("lastName", e.target.value)}
                  placeholder={t.optional}
                  className="input"
                />
              </label>
            </div>

            {/* No phone field. A number typed here would be a number nobody
                checked, and it is the one detail a stranger acts on — so it is
                asked for once, with an SMS behind it, at the point it starts to
                matter: joining a community (see settings/PhoneVerify.jsx). */}

            {/* Address — optional here, but required before joining a community,
                since it is what the next reader navigates to. */}
            <label className="block">
              <span className="text-[13px] text-ink-500 mb-1 block">{t.address}</span>
              <input
                value={form.address}
                onChange={(e) => update("address", e.target.value)}
                placeholder={t.addressPlaceholder}
                autoComplete="street-address"
                className="input"
              />
            </label>

            <label className="flex items-center gap-3 pt-1">
              <input
                type="checkbox"
                checked={form.notificationsEnabled}
                onChange={(e) => update("notificationsEnabled", e.target.checked)}
                className="w-5 h-5 accent-brand-500"
              />
              <span className="text-[14px]">{t.enableNotifications}</span>
            </label>
          </>
        )}

        {/* ── Step 3: Photo (skippable) ── */}
        {step === 3 && (
          <>
            <h2 className="text-xl font-bold mb-1">{t.uploadPhoto}</h2>
            <p className="text-[13px] text-ink-500 mb-3">{t.registerSkippable}</p>

            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
            />

            {photoPreview ? (
              <div className="relative rounded-2xl overflow-hidden h-56 bg-ink-100">
                <img
                  src={photoPreview}
                  alt="Превью"
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-3 right-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-xl bg-surface/90 text-[13px] font-medium text-ink-700 shadow"
                  >
                    {t.changePhoto}
                  </button>
                  <button
                    type="button"
                    onClick={removePhoto}
                    className="px-3 py-1.5 rounded-xl bg-bad/90 text-[13px] font-medium text-white shadow"
                  >
                    {t.removePhoto}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="w-full h-56 rounded-2xl bg-brand-50 border-2 border-dashed border-brand-200
                           flex flex-col items-center justify-center gap-3
                           text-brand-500 hover:bg-brand-100 transition active:scale-[0.99] cursor-pointer"
              >
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.12" />
                  <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="text-[14px] font-medium">{t.pickPhoto}</span>
                <span className="text-[12px] text-brand-400">{t.pickPhotoHint}</span>
              </button>
            )}

            {/* Terms of Use agreement — mandatory */}
            <label className="flex items-start gap-3 pt-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.acceptedTerms}
                onChange={(e) => update("acceptedTerms", e.target.checked)}
                className="w-5 h-5 mt-0.5 shrink-0 accent-brand-500"
              />
              <span className="text-[14px] leading-snug">
                {t.registerAcceptTerms.split(t.registerAcceptTermsLink)[0]}
                <a
                  href="/drawable/TermsofUse.docx.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-500 underline underline-offset-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {t.registerAcceptTermsLink}
                </a>
                {t.registerAcceptTerms.split(t.registerAcceptTermsLink)[1] || ""}
              </span>
            </label>
          </>
        )}

        {error && !onVerifyGate ? <p className="text-bad text-[13px]">{error}</p> : null}
      </div>

      {/* Fixed bottom button */}
      <div className="absolute bottom-4 left-0 right-0 px-6 space-y-2">
        {onVerifyGate ? (
          <button
            onClick={checkVerified}
            disabled={verifyBusy}
            className="btn-primary disabled:opacity-60"
          >
            {verifyBusy ? "..." : t.iVerified}
          </button>
        ) : (
          <>
            <button
              onClick={next}
              disabled={submitting || (step === 3 && !form.acceptedTerms)}
              className="btn-primary disabled:opacity-60"
            >
              {submitting ? "..." : step === 3 ? t.signUp : t.next}
            </button>

            {step === 3 && !photoFile && (
              <button
                onClick={submit}
                disabled={submitting || !form.acceptedTerms}
                className="w-full py-3 rounded-2xl text-[14px] font-semibold text-ink-500 bg-ink-100 active:scale-[0.99] transition disabled:opacity-60"
              >
                {submitting ? "..." : t.continueWithoutPhoto}
              </button>
            )}
          </>
        )}
      </div>
    </MobileShell>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function prettyError(err) {
  const code = err?.code || "";
  if (code === "auth/email-already-in-use") return t.emailAlreadyInUse;
  if (code === "auth/invalid-email") return t.emailInvalid;
  if (code === "auth/weak-password") return t.passwordWeak;
  if (code === "auth/operation-not-allowed") return t.emailPasswordDisabled;
  return err?.message || t.registerError;
}
