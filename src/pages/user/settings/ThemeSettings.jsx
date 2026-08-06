import SettingsPage from "../../../components/SettingsPage.jsx";
import { useTheme } from "../../../contexts/ThemeContext.jsx";
import { t } from "../../../utils/i18n.js";

const OPTIONS = [
  { value: "light", labelKey: "themeLight" },
  { value: "dark",  labelKey: "themeDark"  },
];

/** Тема — light / dark, applied the moment it is picked. */
export default function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <SettingsPage title={t.theme}>
      <div className="px-5 pt-2 divide-y divide-ink-100">
        {OPTIONS.map((opt) => (
          <ChoiceRow
            key={opt.value}
            label={t[opt.labelKey]}
            selected={theme === opt.value}
            onClick={() => setTheme(opt.value)}
          />
        ))}
      </div>
    </SettingsPage>
  );
}

function ChoiceRow({ label, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 py-4 text-left transition active:opacity-60"
    >
      <span className="flex-1 text-[15px] text-ink-900">{label}</span>
      {selected ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-brand-500">
          <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}
