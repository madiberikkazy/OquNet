import { useState } from "react";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { t } from "../../../utils/i18n.js";
import { SUPPORT_TELEGRAM, SUPPORT_TELEGRAM_URL } from "../../../utils/appInfo.js";

/**
 * Қолдау қызметіне жазу — support runs through the project's Telegram channel.
 *
 * A plain link, not a form: tapping it hands off to the Telegram app if it is
 * installed and to the web client if it isn't, and the conversation then lives
 * somewhere the user still reaches if they lose access to the account they are
 * writing about. The handle is on screen as well, so it is usable even when the
 * link cannot open — a locked-down browser, a screenshot, a dictated address.
 */
export default function Support() {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(SUPPORT_TELEGRAM_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the handle is on screen anyway */
    }
  }

  return (
    <SettingsPage title={t.contactSupport}>
      <div className="px-5 pt-4">
        <p className="text-[14px] text-ink-500 leading-relaxed mb-5">{t.supportIntro}</p>

        <div className="rounded-2xl bg-ink-100 px-4 py-3 mb-4 flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-[#2AABEE] flex items-center justify-center shrink-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d="M21.6 4.3 2.9 11.5c-.9.35-.9.9-.15 1.12l4.8 1.5 1.85 5.65c.22.6.4.83.85.83.45 0 .65-.2.9-.45l2.2-2.13 4.6 3.4c.85.47 1.45.23 1.66-.78l3-14.1c.3-1.24-.5-1.8-1.3-1.44Zm-11.2 10.6-.35 3.8-1.7-5.2 10.5-6.6-8.45 8Z" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-[12px] text-ink-500 mb-0.5">{t.supportTelegramLabel}</p>
            <p className="text-[15px] text-ink-900 break-all">{SUPPORT_TELEGRAM}</p>
          </div>
        </div>

        <a
          href={SUPPORT_TELEGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary block text-center"
        >
          {t.writeUs}
        </a>

        <button onClick={copyLink} className="btn-secondary mt-3">
          {copied ? t.copied : t.copyLink}
        </button>
      </div>
    </SettingsPage>
  );
}
