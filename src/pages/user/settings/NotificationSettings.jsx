import { useEffect, useState } from "react";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { SettingsGroup, ToggleRow } from "../../../components/SettingsList.jsx";
import { t } from "../../../utils/i18n.js";
import {
  NOTIFICATION_SOUNDS,
  loadNotificationPreferences,
  saveNotificationPreferences,
  requestNotificationPermission,
  getNotificationPermissionStatus,
  areNotificationsSupported,
} from "../../../utils/notificationService.js";
import { isWebPushSupported, isPushEnabled, enablePush, disablePush } from "../../../utils/webPush.js";

/** Уведомления — master switch, sound, and the browser permission. */
export default function NotificationSettings() {
  const [prefs, setPrefs] = useState(() => loadNotificationPreferences());
  const [permission, setPermission] = useState(() => getNotificationPermissionStatus());
  const supported = areNotificationsSupported();

  // ── Push ──────────────────────────────────────────────────────────────────
  //
  // A row of its own rather than a flag inside `prefs`, because unlike every
  // other setting on this screen it is not a local preference: it is a
  // registration held on a server, per device. The same account on a phone and
  // a laptop is two answers, and neither is stored with the profile.
  //
  // `null` means "not looked up yet" — distinct from false, so the switch does
  // not flick from off to on in front of the reader on the way in.
  const pushSupported = isWebPushSupported();
  const [pushOn, setPushOn] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");

  useEffect(() => {
    if (!pushSupported) return undefined;
    let cancelled = false;
    isPushEnabled().then((on) => { if (!cancelled) setPushOn(on); });
    return () => { cancelled = true; };
  }, [pushSupported]);

  async function togglePush(next) {
    if (pushBusy) return;
    setPushBusy(true);
    setPushError("");
    // Optimistic, and reverted below on failure. The permission prompt this
    // opens can sit on screen for several seconds, and a switch that does not
    // move until it is answered reads as a switch that did not work.
    setPushOn(next);

    const result = next ? await enablePush() : await disablePush();
    if (!result.ok) {
      setPushOn(!next);
      // A denied permission is not an error to apologise for — the row below
      // already says the browser is refusing, and the reader is the one who
      // refused. Anything else is worth naming.
      if (result.reason !== "denied") setPushError(t.pushFailed);
      setPermission(getNotificationPermissionStatus());
    }
    setPushBusy(false);
  }

  function updatePref(key, value) {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);
    saveNotificationPreferences(updated);
  }

  async function enableBrowserNotifications() {
    if (!supported) return;
    const granted = await requestNotificationPermission();
    setPermission(getNotificationPermissionStatus());
    if (granted) updatePref("browserNotificationsEnabled", true);
  }

  return (
    <SettingsPage title={t.notifications}>
      <SettingsGroup className="pt-2">
        <ToggleRow
          label={t.enableNotifications}
          checked={prefs.notificationsEnabled}
          onChange={(v) => updatePref("notificationsEnabled", v)}
        />

        {prefs.notificationsEnabled ? (
          <ToggleRow
            label={t.soundEffects}
            checked={prefs.soundEnabled}
            onChange={(v) => updatePref("soundEnabled", v)}
          />
        ) : null}
      </SettingsGroup>

      {prefs.notificationsEnabled && prefs.soundEnabled ? (
        <div className="px-5 pt-4">
          <label className="block text-[12px] text-ink-500 mb-2">{t.chooseSound}</label>
          <select
            value={prefs.selectedSound}
            onChange={(e) => updatePref("selectedSound", e.target.value)}
            className="input"
          >
            {Object.entries(NOTIFICATION_SOUNDS).map(([key, sound]) => (
              <option key={key} value={key}>{sound.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {prefs.notificationsEnabled && supported ? (
        <SettingsGroup className="pt-2">
          {permission === "granted" ? (
            <ToggleRow
              label={t.browserNotifications}
              subtitle={t.permissionGranted}
              checked={prefs.browserNotificationsEnabled}
              onChange={(v) => updatePref("browserNotificationsEnabled", v)}
            />
          ) : (
            <div className="flex items-center gap-3 py-4">
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] text-ink-900 leading-tight">
                  {t.browserNotifications}
                </span>
                <span className="block text-[12px] text-ink-500 mt-0.5">
                  {permission === "denied" ? t.permissionDenied : t.permissionDefault}
                </span>
              </span>
              <button
                onClick={enableBrowserNotifications}
                disabled={permission === "denied"}
                className="text-[13px] text-brand-500 font-medium px-3 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 disabled:opacity-50 transition shrink-0"
              >
                {t.requestPermission}
              </button>
            </div>
          )}
        </SettingsGroup>
      ) : null}

      {prefs.notificationsEnabled ? (
        <>
          <SettingsGroup className="pt-2">
            <ToggleRow
              label={t.pushNotifications}
              subtitle={pushSupported ? t.pushNotificationsHint : t.pushUnsupported}
              checked={pushOn === true}
              disabled={!pushSupported || pushBusy || pushOn === null || permission === "denied"}
              onChange={togglePush}
            />
          </SettingsGroup>
          {pushError ? (
            <p className="px-5 pt-2 text-[13px] text-bad">{pushError}</p>
          ) : null}
        </>
      ) : null}

      {!supported ? (
        <p className="px-5 pt-4 text-[13px] text-ink-500">{t.notificationsNotSupported}</p>
      ) : null}
    </SettingsPage>
  );
}
