import { useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import AppIcon from "../../components/AppIcon.jsx";
import Modal from "../../components/Modal.jsx";
import { SettingsGroup, GroupDivider, SettingsRow } from "../../components/SettingsList.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useTheme } from "../../contexts/ThemeContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { IMAGE_SIZES, uploadImage } from "../../firebase/storage.js";
import { logger } from "../../utils/logger.js";
import { t, SUPPORTED_LANGS } from "../../utils/i18n.js";
import { useGoBack } from "../../utils/useGoBack.js";
import { usePhotoPicker } from "../../native/usePhotoPicker.js";

/**
 * Settings hub.
 *
 * Everything that used to be one long scroll now lives on its own screen; this
 * page is just the index of them. The only thing it still *does* itself is the
 * avatar — swapping a photo is one tap and a save, and burying it behind a
 * sub-screen would make the header picture look decorative.
 */
export default function Settings() {
  const navigate = useNavigate();
  // Settings is reached from either profile, so the fallback is the profile
  // route — the arrow still pops normally when there is a history entry.
  const goBack = useGoBack("/profile");
  const { user, updateProfile, signOut } = useAuth();
  const { theme } = useTheme();
  const { lang } = useLang();

  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);

  // A File, from the OS picker on a phone and from the hidden input in a
  // browser — usePhotoPicker owns that choice, and the input reset that used to
  // be the first thing this function did. See native/usePhotoPicker.js.
  async function onPickPhoto(file) {
    if (!file || photoBusy) return;

    setPhotoError("");
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoBusy(true);
    try {
      const photoURL = await uploadImage(file, `avatars/${user.id}_${Date.now()}`, {
        maxDimension: IMAGE_SIZES.avatar,
      });
      await updateProfile({ photoURL });
      setPhotoPreview(null); // the stored URL takes over from here
    } catch (err) {
      logger.error("settings.avatar", err?.message);
      setPhotoPreview(null);
      // A picture too big to store names itself; everything else is the
      // generic failure, because a raw Firestore message is English and no
      // help to the person looking at it.
      setPhotoError(err?.errorKey && t[err.errorKey] ? t[err.errorKey] : t.saveFailed);
    } finally {
      setPhotoBusy(false);
    }
  }

  const photoPicker = usePhotoPicker({ kind: "avatar", onPick: onPickPhoto });

  async function handleLogout() {
    setConfirmLogout(false);
    await signOut();
    navigate("/auth/login", { replace: true });
  }

  const avatarSrc = photoPreview || user?.photoURL || null;
  const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  const themeLabel = theme === "dark" ? t.themeDark : t.themeLight;
  const langLabel = SUPPORTED_LANGS.find((l) => l.code === lang)?.label || lang;

  return (
    <MobileShell withNav={false}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-5 pb-2">
        <button
          type="button"
          aria-label={t.back}
          onClick={goBack}
          className="-ml-1 p-1 text-ink-900"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-[20px] font-semibold">{t.settings}</h1>
      </header>

      {/* ── Identity ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col items-center pt-4 pb-6">
        <button
          type="button"
          onClick={photoPicker.open}
          disabled={photoBusy}
          className="relative rounded-full focus:outline-none focus:ring-2 focus:ring-brand-200"
          aria-label={t.uploadPhoto}
        >
          <Avatar src={avatarSrc} name={fullName} size={120} />
          <span className="absolute bottom-1 right-1 w-9 h-9 rounded-full bg-ink-100 border-2 border-base flex items-center justify-center">
            <AppIcon name="camera" size={18} />
          </span>
          {photoBusy ? (
            <span className="absolute inset-0 rounded-full bg-ink-900/30 flex items-center justify-center text-white text-[13px]">
              …
            </span>
          ) : null}
        </button>
        <input {...photoPicker.inputProps} />

        <h2 className="text-[24px] font-semibold mt-4 text-center px-6">{fullName || "—"}</h2>
        <p className="text-ink-300 text-[16px] mt-0.5">@{user?.nickname}</p>
        {photoError ? <p className="text-[13px] text-bad mt-2">{photoError}</p> : null}
      </div>

      {/* ── Profile & security ─────────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow icon="profile"  label={t.personalData} to="/settings/profile" />
        <SettingsRow icon="security" label={t.security}     to="/settings/security" />
      </SettingsGroup>

      <GroupDivider />

      {/* ── App preferences ────────────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow icon="notifications" label={t.notifications} to="/settings/notifications" />
        <SettingsRow icon="theme"    label={t.theme}             to="/settings/theme"    value={themeLabel} chevron={false} />
        <SettingsRow icon="language" label={t.interfaceLanguage} to="/settings/language" value={langLabel}  chevron={false} />
        <SettingsRow icon="info"     label={t.information}       to="/settings/about" />
        <SettingsRow icon="support"  label={t.contactSupport}    to="/settings/support" />
      </SettingsGroup>

      <GroupDivider />

      {/* ── Role & community ───────────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow icon="community" label={t.roleAndCommunity} to="/settings/community" />
      </SettingsGroup>

      <GroupDivider />

      {/* ── Account ────────────────────────────────────────────────────────── */}
      <SettingsGroup className="pb-6">
        <SettingsRow
          icon="logout"
          label={t.logOutAccount}
          onClick={() => setConfirmLogout(true)}
          chevron={false}
        />
        <SettingsRow
          icon="delete"
          label={t.deleteAccount}
          to="/settings/delete"
          chevron={false}
          danger
        />
      </SettingsGroup>

      <Modal open={confirmLogout} onClose={() => setConfirmLogout(false)} title={t.logOutConfirm}>
        <div className="flex gap-3">
          <button onClick={() => setConfirmLogout(false)} className="btn-secondary">
            {t.cancel}
          </button>
          <button
            onClick={handleLogout}
            className="w-full font-semibold rounded-xl py-3.5 bg-badSoft text-bad transition"
          >
            {t.logOut}
          </button>
        </div>
      </Modal>
    </MobileShell>
  );
}
