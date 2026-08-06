import { useState } from "react";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { t } from "../../../utils/i18n.js";
import { APP_NAME, APP_VERSION, SUPPORT_EMAIL } from "../../../utils/appInfo.js";

/**
 * Написать в поддержку.
 *
 * The message is composed in the user's own mail client rather than posted to
 * a collection: a support request needs a reply channel that survives the user
 * losing access to the account they're writing about.
 */
export default function Support() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const subject = `${APP_NAME} — ${t.contactSupport}`;
  // The account details save the first round-trip of "which account is this?".
  const body = [
    "",
    "",
    "—",
    `${APP_NAME} ${APP_VERSION}`,
    user?.nickname ? `@${user.nickname}` : "",
    user?.email || "",
  ].join("\n");

  const mailto =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the address is on screen anyway */
    }
  }

  return (
    <SettingsPage title={t.contactSupport}>
      <div className="px-5 pt-4">
        <p className="text-[14px] text-ink-500 leading-relaxed mb-5">{t.supportIntro}</p>

        <div className="rounded-2xl bg-ink-100 px-4 py-3 mb-4">
          <p className="text-[12px] text-ink-500 mb-0.5">{t.supportEmailLabel}</p>
          <p className="text-[15px] text-ink-900 break-all">{SUPPORT_EMAIL}</p>
        </div>

        <a href={mailto} className="btn-primary block text-center">
          {t.writeUs}
        </a>

        <button onClick={copyEmail} className="btn-secondary mt-3">
          {copied ? t.copied : t.copyEmail}
        </button>
      </div>
    </SettingsPage>
  );
}
