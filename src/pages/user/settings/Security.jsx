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
import { t } from "../../../utils/i18n.js";

/** Безопасность — changing the password. */
export default function Security() {
  const { user } = useAuth();
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

  return (
    <SettingsPage title={t.security}>
      <div className="px-5 pt-4">
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
      </div>
    </SettingsPage>
  );
}
