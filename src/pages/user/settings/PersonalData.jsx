import { useState } from "react";
import { Link } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { claimUsername, releaseUsername } from "../../../firebase/firestore.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../utils/i18n.js";
import { clampText, isAddress, LIMITS } from "../../../utils/validators.js";

/**
 * Личные данные — name, nickname and the contact details other members need
 * when a book changes hands. The avatar lives on the settings hub; everything
 * textual lives here.
 */
export default function PersonalData() {
  const { user, updateProfile } = useAuth();

  const [form, setForm] = useState({
    firstName: user?.firstName || "",
    lastName:  user?.lastName  || "",
    nickname:  user?.nickname  || "",
    address:   user?.address   || "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { type: "ok" | "err", text }

  function updateForm(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    if (saving) return;
    const nick = form.nickname.trim();
    if (!form.firstName.trim() || !form.lastName.trim() || !nick) {
      setMsg({ type: "err", text: t.fillAllFields });
      return;
    }

    // Address gate — a member is someone other people have to reach for a
    // handover, so they can edit it but not empty it; everyone else may leave
    // it blank, just not malformed. The phone is not part of this save at all:
    // it only ever changes through the verification flow.
    const address = clampText(form.address, LIMITS.ADDRESS_MAX);
    const contactsRequired = Boolean(user?.communityId);
    if ((contactsRequired || address) && !isAddress(address)) {
      setMsg({ type: "err", text: t.addressRequiredError });
      return;
    }

    setSaving(true);
    setMsg(null);
    try {
      // A rename has to move the public nickname index too, and the index is
      // what makes the name unique in the first place — claiming it is the
      // check. Claim before the profile write: if the name is gone, nothing has
      // changed yet. Release the old one only once the profile actually names
      // the new one, so a failure in between leaves a spare claim we still own
      // rather than a nickname anybody could take.
      const renaming = nick !== user.nickname;
      if (renaming) {
        try {
          await claimUsername(nick, { uid: user.id, email: user.email });
        } catch {
          setMsg({ type: "err", text: t.nicknameTaken });
          return;
        }
      }

      await updateProfile({
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        nickname:  nick,
        address,
      });

      if (renaming && user.nickname) {
        await releaseUsername(user.nickname).catch((err) => {
          logger.warn("settings.releaseUsername", err?.message, { nickname: user.nickname });
        });
      }
      setMsg({ type: "ok", text: t.profileSaved });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ type: "err", text: err?.message || t.error });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage title={t.personalData}>
      <div className="px-5 pt-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="text-[12px] text-ink-500 mb-1 block">{t.firstName}</span>
            <input
              value={form.firstName}
              onChange={(e) => updateForm("firstName", e.target.value)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-500 mb-1 block">{t.lastName}</span>
            <input
              value={form.lastName}
              onChange={(e) => updateForm("lastName", e.target.value)}
              className="input"
            />
          </label>
        </div>

        <label className="block mb-3">
          <span className="text-[12px] text-ink-500 mb-1 block">{t.nickname}</span>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-300 text-[15px] select-none">@</span>
            <input
              value={form.nickname}
              onChange={(e) => updateForm("nickname", e.target.value.replace(/\s/g, "").toLowerCase())}
              className="input pl-8"
            />
          </div>
        </label>

        {/* The number is not editable here, and that is the point: it is the
            one detail somebody acts on physically, so changing it costs the
            same message to our bot that proving it did the first time. The
            rules refuse `phone` from any client at all, so a field here would
            only be a way to be told "no" by the server. */}
        <div className="mb-3">
          <span className="text-[12px] text-ink-500 mb-1 block">{t.phone}</span>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-100 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[15px] font-medium truncate">
                {user?.phone || t.phoneNoneYet}
              </p>
              {user?.phone ? (
                <span
                  className={
                    "text-[12px] " + (user?.phoneVerifiedAt ? "text-ok" : "text-warn")
                  }
                >
                  {user?.phoneVerifiedAt ? `✓ ${t.phoneVerified}` : t.phoneNotVerified}
                </span>
              ) : null}
            </div>
            <Link
              to={`/settings/phone?next=${encodeURIComponent("/settings/profile")}`}
              className="text-[13px] font-semibold text-brand-500 shrink-0"
            >
              {user?.phone ? t.phoneChangeCta : t.phoneVerifyCta}
            </Link>
          </div>
        </div>

        <label className="block mb-4">
          <span className="text-[12px] text-ink-500 mb-1 block">{t.address}</span>
          <input
            value={form.address}
            onChange={(e) => updateForm("address", e.target.value)}
            placeholder={t.addressPlaceholder}
            autoComplete="street-address"
            maxLength={LIMITS.ADDRESS_MAX}
            className="input"
          />
        </label>

        {/* Email is the account identity — changing it is not a profile edit. */}
        <div className="flex items-center justify-between py-3 border-b border-ink-100 mb-5">
          <span className="text-[14px] text-ink-500">{t.email}</span>
          <span className="text-[14px] text-ink-500 truncate max-w-[60%]">{user?.email || "—"}</span>
        </div>

        {msg ? (
          <p className={"text-[13px] mb-2 " + (msg.type === "ok" ? "text-ok" : "text-bad")}>
            {msg.text}
          </p>
        ) : null}

        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? "…" : t.save}
        </button>
      </div>
    </SettingsPage>
  );
}
