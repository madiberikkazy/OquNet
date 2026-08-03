import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword as fbUpdatePassword,
} from "firebase/auth";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import PWASettings from "../../components/PWASettings.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { useTheme } from "../../contexts/ThemeContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import { auth, isFirebaseConfigured } from "../../firebase/config.js";
import {
  getActiveBorrowingForUser, getUserByNickname, updateUser,
  createLeaveRequest, getPendingLeaveRequest, createNotification,
} from "../../firebase/firestore.js";
import { uploadImage } from "../../firebase/storage.js";
import { t, SUPPORTED_LANGS } from "../../utils/i18n.js";
import { clampText, LIMITS } from "../../utils/validators.js";
import { 
  NOTIFICATION_SOUNDS, 
  loadNotificationPreferences, 
  saveNotificationPreferences,
  requestNotificationPermission,
  getNotificationPermissionStatus,
  areNotificationsSupported 
} from "../../utils/notificationService.js";

export default function Settings() {
  const navigate     = useNavigate();
  const fileRef      = useRef(null);
  const { user, updateProfile, signOut, switchView } = useAuth();
  const { community } = useCommunity();
  const { theme, setTheme } = useTheme();
  const { lang, setLang } = useLang();

  // ── Profile form ────────────────────────────────────────────────────────────
  const [form, setForm]           = useState({
    firstName: user?.firstName || "",
    lastName:  user?.lastName  || "",
    nickname:  user?.nickname  || "",
    phone:     user?.phone     || "",
    address:   user?.address   || "",
  });
  const [photoFile, setPhotoFile]       = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [saving, setSaving]             = useState(false);
  const [profileMsg, setProfileMsg]     = useState(null); // { type: "ok"|"err", text }

  // ── Notification preferences ───────────────────────────────────────────────
  const [notifPrefs, setNotifPrefs] = useState(() => loadNotificationPreferences());
  const notificationPermission = getNotificationPermissionStatus();
  const notificationsSupported = areNotificationsSupported();

  function updateNotifPref(key, value) {
    const updated = { ...notifPrefs, [key]: value };
    setNotifPrefs(updated);
    saveNotificationPreferences(updated);
  }

  async function enableBrowserNotifications() {
    if (!notificationsSupported) {
      alert(t.notificationsNotSupported);
      return;
    }
    const granted = await requestNotificationPermission();
    if (granted) {
      updateNotifPref('browserNotificationsEnabled', true);
    }
  }

  function updateForm(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function onPickPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function saveProfile() {
    if (saving) return;
    const nick = form.nickname.trim();
    if (!form.firstName.trim() || !form.lastName.trim() || !nick) {
      setProfileMsg({ type: "err", text: t.fillAllFields });
      return;
    }
    setSaving(true);
    setProfileMsg(null);
    try {
      // Nickname uniqueness check (skip if unchanged)
      if (nick !== user.nickname) {
        const taken = await getUserByNickname(nick);
        if (taken && taken.id !== user.id) {
          setProfileMsg({ type: "err", text: t.nicknameTaken });
          return;
        }
      }

      let photoURL = user.photoURL || "";
      if (photoFile) {
        photoURL = await uploadImage(photoFile, `avatars/${user.id}_${Date.now()}`);
      }

      await updateProfile({
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        nickname:  nick,
        phone:     form.phone.trim().slice(0, 20),
        address:   clampText(form.address, LIMITS.ADDRESS_MAX),
        photoURL,
      });
      setPhotoFile(null);
      setProfileMsg({ type: "ok", text: t.profileSaved });
      setTimeout(() => setProfileMsg(null), 3000);
    } catch (err) {
      setProfileMsg({ type: "err", text: err?.message || t.error });
    } finally {
      setSaving(false);
    }
  }

  // ── Password form ────────────────────────────────────────────────────────────
  const [pw, setPw]       = useState({ current: "", next: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg]       = useState(null);

  function updatePw(k, v) { setPw((p) => ({ ...p, [k]: v })); }

  async function savePassword() {
    if (pwSaving) return;
    if (!pw.current) { setPwMsg({ type: "err", text: `${t.currentPassword} — ${t.required}` }); return; }
    if (pw.next.length < 6) { setPwMsg({ type: "err", text: t.passwordMinError }); return; }
    if (pw.next !== pw.confirm) { setPwMsg({ type: "err", text: t.passwordsDoNotMatch }); return; }

    setPwSaving(true);
    setPwMsg(null);
    try {
      if (isFirebaseConfigured) {
        const credential = EmailAuthProvider.credential(user.email, pw.current);
        await reauthenticateWithCredential(auth.currentUser, credential);
        await fbUpdatePassword(auth.currentUser, pw.next);
      } else {
        // Mock mode: password is stored in the user doc
        const stored = user.password;
        if (stored && stored !== pw.current) throw new Error(t.wrongPassword);
        await updateUser(user.id, { password: pw.next });
      }
      setPw({ current: "", next: "", confirm: "" });
      setPwMsg({ type: "ok", text: t.passwordChanged });
      setTimeout(() => setPwMsg(null), 3000);
    } catch (err) {
      const code = err?.code || "";
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setPwMsg({ type: "err", text: t.wrongPassword });
      } else {
        setPwMsg({ type: "err", text: err?.message || t.error });
      }
    } finally {
      setPwSaving(false);
    }
  }

  // ── Role switch ──────────────────────────────────────────────────────────────
  const [roleSwitching, setRoleSwitching] = useState(false);
  async function trySwitchRole() {
    if (roleSwitching || !user) return;
    setRoleSwitching(true);
    try {
      if (user.role === "admin") {
        const active = await getActiveBorrowingForUser(user.id).catch(() => null);
        if (active) { alert(t.returnBookFirst); return; }
        switchView();
        navigate("/", { replace: true });
      } else {
        navigate("/community/create");
      }
    } catch (err) {
      console.error("Role switch failed:", err);
      alert(err?.message || t.error);
    } finally {
      setRoleSwitching(false);
    }
  }

  // ── Leave community ──────────────────────────────────────────────────────────
  const [leaveState, setLeaveState] = useState("idle"); // "idle" | "pending" | "done"
  const [leaveBusy, setLeaveBusy]   = useState(false);

  // On mount: check if user already has a pending leave request
  useState(() => {
    if (user?.communityId) {
      getPendingLeaveRequest(user.id).then((r) => {
        if (r) setLeaveState("pending");
      });
    }
  });

  async function handleLeave() {
    if (leaveBusy || leaveState !== "idle") return;
    if (!community) return;
    setLeaveBusy(true);
    try {
      const req = await createLeaveRequest({
        userId: user.id,
        userNickname: user.nickname,
        userName: `${user.firstName} ${user.lastName}`,
        communityId: community.id,
      });

      // Notify the user themselves
      await createNotification({
        recipientId: user.id,
        title: "Өтінішіңіз жіберілді",
        body: `«${community.name}» қоғамдастығынан шығу өтінішіңіз администраторға жіберілді. Жауап күтіңіз.`,
        read: false,
        type: "leave-request-sent",
        requestId: req.id,
        communityId: community.id,
        communityName: community.name,
      });

      // Notify the admin
      await createNotification({
        recipientId: community.ownerId,
        title: "Қоғамдастықтан шығу өтінімі",
        body: `@${user.nickname} қоғамдастықтан шығуға өтініш берді.`,
        read: false,
        type: "leave-request",
        requestId: req.id,
        communityId: community.id,
        userId: user.id,
        userNickname: user.nickname,
        userName: `${user.firstName} ${user.lastName}`,
      });

      setLeaveState("pending");
    } catch (err) {
      console.error(err);
    } finally {
      setLeaveBusy(false);
    }
  }

  const avatarSrc = photoPreview || user?.photoURL || null;
  const avatarName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();

  return (
    <MobileShell withNav={false}>
      <SearchBar value="" onChange={() => {}} onBack={() => navigate(-1)} showFilter={false} />

      <div className="px-5 pt-3 pb-10 space-y-7">

        {/* ══ PROFILE ════════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-4">{t.editProfile}</h2>

          {/* Avatar picker */}
          <div className="flex justify-center mb-5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative focus:outline-none group"
              aria-label="Change photo"
            >
              <Avatar src={avatarSrc} name={avatarName} size={88} />
              {/* Camera overlay */}
              <span className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                    stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
                  <circle cx="12" cy="13" r="4" stroke="white" strokeWidth="1.6" />
                </svg>
              </span>
              {/* "Change" badge */}
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-brand-500 text-white text-[10px] font-semibold whitespace-nowrap">
                {t.uploadPhotoShort}
              </span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />
          </div>

          {/* Name fields */}
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

          <label className="block mb-4">
            <span className="text-[12px] text-ink-500 mb-1 block">{t.nickname}</span>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-400 text-[15px] select-none">@</span>
              <input
                value={form.nickname}
                onChange={(e) => updateForm("nickname", e.target.value.replace(/\s/g, "").toLowerCase())}
                className="input pl-8"
              />
            </div>
          </label>

          {/* Contacts — shown to whoever comes to collect a book from you,
              and required before joining a community. */}
          <label className="block mb-3">
            <span className="text-[12px] text-ink-500 mb-1 block">{t.phone}</span>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => updateForm("phone", e.target.value.replace(/[^\d+\-() ]/g, ""))}
              placeholder="+7 (777) 123-45-67"
              autoComplete="tel"
              className="input"
            />
          </label>

          <label className="block mb-4">
            <span className="text-[12px] text-ink-500 mb-1 block">{t.address}</span>
            <input
              value={form.address}
              onChange={(e) => updateForm("address", e.target.value)}
              placeholder={t.addressPlaceholder}
              autoComplete="street-address"
              className="input"
            />
          </label>

          {/* Email — read only */}
          <div className="flex items-center justify-between py-3 border-b border-ink-100 mb-4">
            <span className="text-[14px] text-ink-500">Email</span>
            <span className="text-[14px] text-ink-500">{user?.email || "—"}</span>
          </div>

          {profileMsg ? (
            <p className={"text-[13px] mb-2 " + (profileMsg.type === "ok" ? "text-ok" : "text-bad")}>
              {profileMsg.text}
            </p>
          ) : null}

          <button onClick={saveProfile} disabled={saving} className="btn-primary">
            {saving ? "…" : t.save}
          </button>
        </section>

        <Divider />

        {/* ══ PASSWORD ═══════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-4">{t.changePassword}</h2>

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

          {pwMsg ? (
            <p className={"text-[13px] mt-2 mb-1 " + (pwMsg.type === "ok" ? "text-ok" : "text-bad")}>
              {pwMsg.text}
            </p>
          ) : null}

          <button onClick={savePassword} disabled={pwSaving} className="btn-primary mt-4">
            {pwSaving ? "…" : t.save}
          </button>
        </section>

        <Divider />

        {/* ══ APPEARANCE ═════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-4">{t.appearance}</h2>
          <SectionRow label={t.theme}>
            <PillGroup
              options={[
                { value: "light", label: t.themeLight },
                { value: "dark",  label: t.themeDark  },
              ]}
              value={theme}
              onChange={setTheme}
            />
          </SectionRow>
          <SectionRow label={t.language}>
            <PillGroup
              options={SUPPORTED_LANGS.map((l) => ({ value: l.code, label: l.short }))}
              value={lang}
              onChange={setLang}
            />
          </SectionRow>
        </section>

        <Divider />

        {/* ══ PREFERENCES ════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-4">{t.notifications}</h2>
          
          {/* Enable/Disable notifications */}
          <div className="flex items-center justify-between py-3 border-b border-ink-100">
            <span className="text-[14px] text-ink-700">{t.enableNotifications}</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={notifPrefs.notificationsEnabled}
                onChange={(e) => updateNotifPref('notificationsEnabled', e.target.checked)}
              />
              <div className="w-11 h-6 rounded-full bg-ink-300 peer-checked:bg-brand-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
            </label>
          </div>

          {notifPrefs.notificationsEnabled && (
            <>
              {/* Sound Settings */}
              <div className="py-3 border-b border-ink-100">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[14px] text-ink-700">{t.soundEffects}</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={notifPrefs.soundEnabled}
                      onChange={(e) => updateNotifPref('soundEnabled', e.target.checked)}
                    />
                    <div className="w-11 h-6 rounded-full bg-ink-300 peer-checked:bg-brand-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
                  </label>
                </div>

                {notifPrefs.soundEnabled && (
                  <div>
                    <label className="block text-[12px] text-ink-500 mb-2">{t.chooseSound}</label>
                    <select
                      value={notifPrefs.selectedSound}
                      onChange={(e) => updateNotifPref('selectedSound', e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-ink-200 bg-surface text-[14px] text-ink-700"
                    >
                      {Object.entries(NOTIFICATION_SOUNDS).map(([key, sound]) => (
                        <option key={key} value={key}>
                          {sound.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Browser Notifications */}
              {notificationsSupported && (
                <div className="py-3 border-b border-ink-100">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <span className="text-[14px] text-ink-700">{t.browserNotifications}</span>
                      <p className="text-[12px] text-ink-500 mt-0.5">
                        {notificationPermission === 'granted'
                          ? t.permissionGranted
                          : notificationPermission === 'denied'
                          ? t.permissionDenied
                          : t.permissionDefault}
                      </p>
                    </div>
                    {notificationPermission === 'granted' ? (
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={notifPrefs.browserNotificationsEnabled}
                          onChange={(e) => updateNotifPref('browserNotificationsEnabled', e.target.checked)}
                        />
                        <div className="w-11 h-6 rounded-full bg-ink-300 peer-checked:bg-brand-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
                      </label>
                    ) : (
                      <button
                        onClick={enableBrowserNotifications}
                        className="text-[13px] text-brand-500 font-medium px-3 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 transition"
                      >
                        {t.requestPermission}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <Divider />

        {/* ══ ROLE ═══════════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-3">{t.role}</h2>
          <button onClick={trySwitchRole} className="btn-secondary">
            {user?.role === "admin" ? t.switchToUser : t.switchToAdmin}
          </button>
          <p className="text-[12px] text-ink-500 mt-2">
            {user?.role === "admin" ? t.adminNote : t.userNote}
          </p>
        </section>

        <Divider />

        {/* ══ COMMUNITY ══════════════════════════════════════════════════════════ */}
        {community && user?.role !== "admin" && (
          <>
            <section>
              <h2 className="text-[17px] font-bold mb-1">{t.community}</h2>
              <p className="text-[13px] text-ink-500 mb-4">{community.name}</p>

              {leaveState === "pending" ? (
                <div className="rounded-2xl bg-ink-100 px-4 py-3 text-[13px] text-ink-500 text-center">
                  {t.leavePending}
                </div>
              ) : (
                <button
                  onClick={handleLeave}
                  disabled={leaveBusy}
                  className="w-full text-left rounded-xl bg-badSoft text-bad font-semibold py-3 px-4 disabled:opacity-60"
                >
                  {leaveBusy ? "…" : t.leaveCommunity}
                </button>
              )}
            </section>
            <Divider />
          </>
        )}

        {/* ══ PWA SETTINGS ═══════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-4">{t.appSection}</h2>
          <PWASettings />
        </section>

        <Divider />

        {/* ══ ACCOUNT ════════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-[17px] font-bold mb-3">{t.account}</h2>
          <button
            onClick={async () => { await signOut(); navigate("/auth/login", { replace: true }); }}
            className="w-full text-left rounded-xl bg-badSoft text-bad font-semibold py-3 px-4"
          >
            {t.logOut}
          </button>
        </section>

      </div>
    </MobileShell>
  );
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

function Divider() {
  return <div className="h-px bg-ink-100" />;
}

function SectionRow({ label, children }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-ink-100 last:border-b-0">
      <span className="text-[14px] text-ink-700">{label}</span>
      {children}
    </div>
  );
}

function PillGroup({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={
            "px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors " +
            (value === opt.value
              ? "bg-brand-500 text-white"
              : "bg-ink-100 text-ink-700")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
