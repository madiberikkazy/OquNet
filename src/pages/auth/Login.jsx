import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import AppIcon from "../../components/AppIcon.jsx";
import { signInWithIdentifier, signInWithGoogle, sendPasswordReset } from "../../firebase/auth.js";
import { track } from "../../utils/analytics.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { t } from "../../utils/i18n.js";
import { isEmail } from "../../utils/validators.js";
import { logger } from "../../utils/logger.js";

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [form, setForm] = useState({ identifier: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  // Forgot-password modal state
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy]   = useState(false);
  const [resetMsg, setResetMsg]     = useState(null); // { type: 'ok'|'err', text }

  function openReset() {
    setResetMsg(null);
    // Pre-fill if the identifier in the form is already an email.
    setResetEmail(form.identifier && isEmail(form.identifier.trim()) ? form.identifier.trim() : "");
    setResetOpen(true);
  }

  async function submitReset(e) {
    e?.preventDefault?.();
    if (resetBusy) return;
    setResetMsg(null);
    if (!isEmail(resetEmail)) {
      setResetMsg({ type: "err", text: t.emailInvalid });
      return;
    }
    setResetBusy(true);
    try {
      await sendPasswordReset(resetEmail);
      // Intentionally ambiguous — don't reveal whether the email exists.
      setResetMsg({ type: "ok", text: t.resetPasswordSent });
    } catch (err) {
      logger.warn("login.resetPassword", err?.message, { code: err?.code });
      setResetMsg({ type: "err", text: err?.message || t.resetPasswordError });
    } finally {
      setResetBusy(false);
    }
  }

  async function onGoogle() {
    setError("");
    setGoogleBusy(true);
    try {
      const profile = await signInWithGoogle();
      setUser(profile);
      track("auth.signIn", { method: "google" });
      navigate("/", { replace: true });
    } catch (err) {
      track("auth.signIn.failed", { method: "google", code: err?.code });
      setError(err?.message || t.googleSignInError);
    } finally {
      setGoogleBusy(false);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const profile = await signInWithIdentifier(form);
      setUser(profile);
      track("auth.signIn", { method: "password" });
      navigate("/", { replace: true });
    } catch (err) {
      track("auth.signIn.failed", { method: "password", code: err?.code });
      setError(prettyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MobileShell withNav={false}>
      <div className="px-6 pt-10 flex flex-col items-center">
        {/* The app mark. It is a full-bleed tile with its own background, so it
            gets no tinted box behind it — only the rounding. */}
        <AppIcon name="logo" size={64} alt={t.app} className="rounded-2xl mb-3" />
        <h1 className="text-2xl font-bold">{t.welcomeBack}</h1>
        <p className="text-[13px] text-ink-500">{t.loginSubtitle}</p>
      </div>

      <form onSubmit={onSubmit} className="px-6 pt-6 space-y-3">
        <label className="block">
          <span className="text-[13px] text-ink-500 mb-1 block">{t.identifier}</span>
          <input
            value={form.identifier}
            onChange={(e) => setForm((f) => ({ ...f, identifier: e.target.value.trim() }))}
            placeholder={t.emailOrNickname}
            autoComplete="username"
            className="input"
          />
        </label>

        <label className="block">
          <span className="text-[13px] text-ink-500 mb-1 block">{t.password}</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            autoComplete="current-password"
            className="input"
          />
        </label>

        {/* Forgot password */}
        <div className="flex justify-end -mt-1">
          <button
            type="button"
            onClick={openReset}
            className="text-[12px] text-brand-500 font-medium hover:underline underline-offset-2"
          >
            {t.forgotPassword}
          </button>
        </div>

        {error ? <p className="text-bad text-[13px]">{error}</p> : null}

        <button type="submit" disabled={submitting} className="btn-primary mt-1">
          {submitting ? "..." : t.signIn}
        </button>

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
          {googleBusy ? "..." : t.signInWithGoogle}
        </button>

        <p className="text-center text-[14px] text-ink-500 pt-2">
          {t.noAccount}{" "}
          <Link to="/auth/register" className="text-brand-500 font-medium">{t.signUp}</Link>
        </p>
      </form>

      {/* ── Forgot-password bottom sheet ── */}
      {resetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => !resetBusy && setResetOpen(false)}
          />
          <form
            onSubmit={submitReset}
            // The input is type="email", so the browser would block submit on a
            // malformed address and show its own tooltip — in its own language,
            // and never the app's message. `submitReset` validates the same
            // thing and says it in the user's chosen language.
            noValidate
            className="relative bg-surface rounded-t-3xl px-6 pt-5 pb-10 space-y-4"
          >
            <div className="w-10 h-1 rounded-full bg-ink-200 mx-auto" />
            <div className="text-center">
              <h2 className="text-[18px] font-bold">{t.resetPasswordTitle}</h2>
              <p className="text-[13px] text-ink-500 mt-1">{t.resetPasswordBody}</p>
            </div>

            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.email}</span>
              <input
                type="email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="input"
                autoFocus
              />
            </label>

            {resetMsg ? (
              <p className={"text-[13px] " + (resetMsg.type === "ok" ? "text-ok" : "text-bad")}>
                {resetMsg.text}
              </p>
            ) : null}

            <div className="space-y-2">
              <button
                type="submit"
                disabled={resetBusy}
                className="btn-primary disabled:opacity-60"
              >
                {resetBusy ? "..." : t.resetPasswordSend}
              </button>
              <button
                type="button"
                onClick={() => !resetBusy && setResetOpen(false)}
                disabled={resetBusy}
                className="w-full py-3 text-[14px] text-ink-500 font-medium"
              >
                {t.cancel}
              </button>
            </div>
          </form>
        </div>
      )}
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
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") return t.loginErrorWrongPassword;
  if (code === "auth/user-not-found") return t.loginErrorUserNotFound;
  if (code === "auth/too-many-requests") return t.loginErrorTooMany;
  if (code === "auth/operation-not-allowed") return t.emailPasswordDisabled;
  return err?.message || t.loginErrorGeneric;
}
