import { useState } from "react";
import {
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword as fbUpdatePassword,
} from "firebase/auth";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { auth, isFirebaseConfigured } from "../../../firebase/config.js";
import { updateUser } from "../../../firebase/firestore.js";
import { sendPasswordReset } from "../../../firebase/auth.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../utils/i18n.js";

/** Қауіпсіздік — the account's credentials: its password and its email. */
export default function Security() {
  const { user, changeEmail } = useAuth();

  // ── Password ────────────────────────────────────────────────────────────────
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  function updatePw(k, v) { setPw((p) => ({ ...p, [k]: v })); }

  async function save() {
    if (saving) return;
    if (!pw.current) { setMsg({ type: "err", text: `${t.currentPassword} — ${t.required}` }); return; }
    if (pw.next.length < 6) { setMsg({ type: "err", text: t.passwordMinError }); return; }
    if (pw.next !== pw.confirm) { setMsg({ type: "err", text: t.passwordsDoNotMatch }); return; }

    setSaving(true);
    setMsg(null);
    try {
      if (isFirebaseConfigured) {
        const credential = EmailAuthProvider.credential(user.email, pw.current);
        await reauthenticateWithCredential(auth.currentUser, credential);
        await fbUpdatePassword(auth.currentUser, pw.next);
      } else {
        // Mock mode: the password is stored in the user doc.
        const stored = user.password;
        if (stored && stored !== pw.current) throw new Error(t.wrongPassword);
        await updateUser(user.id, { password: pw.next });
      }
      setPw({ current: "", next: "", confirm: "" });
      setMsg({ type: "ok", text: t.passwordChanged });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      const code = err?.code || "";
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setMsg({ type: "err", text: t.wrongPassword });
      } else {
        setMsg({ type: "err", text: err?.message || t.error });
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Forgot the current password ─────────────────────────────────────────────
  //
  // The form above needs the current password, which is exactly what somebody
  // who has drifted into a saved session no longer remembers. The reset link
  // goes to the address on the account — never to one typed in here, which
  // would turn this screen into a way to take over a logged-in phone.
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState(null);

  async function sendReset() {
    if (resetBusy || !user?.email) return;
    setResetBusy(true);
    setResetMsg(null);
    try {
      await sendPasswordReset(user.email);
      setResetMsg({ type: "ok", text: t.resetLinkSent(user.email) });
    } catch (err) {
      logger.warn("security.resetPassword", err?.message, { code: err?.code });
      setResetMsg({ type: "err", text: err?.message || t.resetPasswordError });
    } finally {
      setResetBusy(false);
    }
  }

  // ── Email ───────────────────────────────────────────────────────────────────
  const [emailForm, setEmailForm] = useState({ next: "", password: "" });
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState(null);

  async function submitEmail() {
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const sentTo = await changeEmail({
        newEmail: emailForm.next,
        password: emailForm.password,
      });
      setEmailForm({ next: "", password: "" });
      setEmailMsg({
        type: "ok",
        // Mock mode has no mail to send, so the change already happened.
        text: isFirebaseConfigured ? t.emailChangeSent(sentTo) : t.emailChanged,
      });
    } catch (err) {
      setEmailMsg({ type: "err", text: err?.message || t.error });
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <SettingsPage title={t.security}>
      <div className="px-5 pt-4 space-y-8">

        {/* ══ PASSWORD ═══════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[15px] font-semibold mb-4">{t.changePassword}</h2>

          <div className="space-y-3">
            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.currentPassword}</span>
              <input
                type="password"
                value={pw.current}
                onChange={(e) => updatePw("current", e.target.value)}
                autoComplete="current-password"
                className="input"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.newPassword}</span>
              <input
                type="password"
                value={pw.next}
                onChange={(e) => updatePw("next", e.target.value)}
                autoComplete="new-password"
                className="input"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.confirmPassword}</span>
              <input
                type="password"
                value={pw.confirm}
                onChange={(e) => updatePw("confirm", e.target.value)}
                autoComplete="new-password"
                className="input"
              />
            </label>
          </div>

          {msg ? (
            <p className={"text-[13px] mt-3 " + (msg.type === "ok" ? "text-ok" : "text-bad")}>
              {msg.text}
            </p>
          ) : null}

          <button onClick={save} disabled={saving} className="btn-primary mt-5">
            {saving ? "…" : t.save}
          </button>

          {/* Forgot the current password */}
          <div className="mt-4 rounded-2xl bg-ink-100 px-4 py-3">
            <p className="text-[13px] text-ink-700">{t.forgotPasswordHint}</p>
            <button
              onClick={sendReset}
              disabled={resetBusy || !user?.email}
              className="mt-1.5 text-[13px] font-semibold text-brand-500 underline underline-offset-2 disabled:opacity-60"
            >
              {resetBusy ? t.verificationSending : t.sendResetLink}
            </button>
            {resetMsg ? (
              <p className={"text-[13px] mt-2 " + (resetMsg.type === "ok" ? "text-ok" : "text-bad")}>
                {resetMsg.text}
              </p>
            ) : null}
          </div>
        </section>

        <div className="h-px bg-ink-100" />

        {/* ══ EMAIL ══════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[15px] font-semibold mb-1">{t.changeEmail}</h2>
          <p className="text-[12px] text-ink-500 leading-relaxed mb-4">{t.emailChangeNote}</p>

          <div className="flex items-center justify-between py-3 border-b border-ink-100 mb-3">
            <span className="text-[13px] text-ink-500">{t.currentEmail}</span>
            <span className="text-[13px] text-ink-700 truncate max-w-[60%]">{user?.email || "—"}</span>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.newEmail}</span>
              <input
                type="email"
                value={emailForm.next}
                onChange={(e) => setEmailForm((f) => ({ ...f, next: e.target.value.trim() }))}
                placeholder="you@example.com"
                autoComplete="email"
                className="input"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-500 mb-1 block">{t.currentPassword}</span>
              <input
                type="password"
                value={emailForm.password}
                onChange={(e) => setEmailForm((f) => ({ ...f, password: e.target.value }))}
                autoComplete="current-password"
                className="input"
              />
            </label>
          </div>

          {emailMsg ? (
            <p className={"text-[13px] mt-3 leading-relaxed " + (emailMsg.type === "ok" ? "text-ok" : "text-bad")}>
              {emailMsg.text}
            </p>
          ) : null}

          <button
            onClick={submitEmail}
            disabled={emailBusy || !emailForm.next || !emailForm.password}
            className="btn-primary mt-5"
          >
            {emailBusy ? "…" : t.changeEmail}
          </button>
        </section>

      </div>
    </SettingsPage>
  );
}
