import SettingsPage from "../../../components/SettingsPage.jsx";
import PWASettings from "../../../components/PWASettings.jsx";
import { t } from "../../../utils/i18n.js";
import { APP_NAME, APP_VERSION, TERMS_URL } from "../../../utils/appInfo.js";
import { isNative, publicUrl } from "../../../native/platform.js";
import { externalLink } from "../../../native/browser.js";

/**
 * Информация — what the app is, which version, and the terms.
 *
 * The storage panel below is web-only. Every control on it — "add to home
 * screen", the service-worker cache size, "keep my data" — is a browser asking
 * to behave more like an app. Inside a store build the app is installed, its
 * assets are in the bundle rather than in a cache, and its storage is already
 * persistent by the platform's own rules, so the panel would be three rows that
 * either lie or do nothing.
 */
export default function AboutApp() {
  return (
    <SettingsPage title={t.information}>
      <div className="px-5 pt-4">
        <section className="mb-6">
          <h2 className="text-[15px] font-semibold mb-2">{t.aboutApp}</h2>
          <p className="text-[13px] text-ink-500 leading-relaxed">{t.aboutDescription}</p>
        </section>

        <div className="divide-y divide-ink-100 mb-6">
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[15px] text-ink-900">{APP_NAME}</span>
            <span className="text-[14px] text-ink-300">
              {t.appVersion} {APP_VERSION}
            </span>
          </div>
          {/* The published copy on native: TERMS_URL is a path inside the
              app's own container there, which no other app can open. */}
          <a
            href={isNative ? publicUrl(TERMS_URL) : TERMS_URL}
            {...externalLink(isNative ? publicUrl(TERMS_URL) : TERMS_URL)}
            className="flex items-center justify-between py-3.5"
          >
            <span className="text-[15px] text-ink-900">{t.termsOfUse}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-ink-300">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>

        {/* Install prompt, cache size, persistent storage — see above. */}
        {isNative ? null : <PWASettings />}
      </div>
    </SettingsPage>
  );
}
