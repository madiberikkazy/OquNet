import SettingsPage from "../../../components/SettingsPage.jsx";
import { useLang } from "../../../contexts/LanguageContext.jsx";
import { t, SUPPORTED_LANGS } from "../../../utils/i18n.js";

/** Язык интерфейса — switching re-renders the whole tree via <App>. */
export default function LanguageSettings() {
  const { lang, setLang } = useLang();

  return (
    <SettingsPage title={t.interfaceLanguage}>
      <div className="px-5 pt-2 divide-y divide-ink-100">
        {SUPPORTED_LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => setLang(l.code)}
            className="w-full flex items-center gap-3 py-4 text-left transition active:opacity-60"
          >
            <span className="flex-1 text-[15px] text-ink-900">{l.label}</span>
            <span className="text-[13px] text-ink-300">{l.short}</span>
            {lang === l.code ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <span className="w-5" />
            )}
          </button>
        ))}
      </div>
    </SettingsPage>
  );
}
