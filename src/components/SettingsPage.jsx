import { useNavigate } from "react-router-dom";
import MobileShell from "./MobileShell.jsx";

/**
 * SettingsPage — the shared chrome for every settings screen: a back arrow,
 * the screen title, and the page body. Matches the hub so moving between
 * them feels like one screen sliding.
 */
export default function SettingsPage({ title, children, backTo = "/settings" }) {
  const navigate = useNavigate();

  return (
    <MobileShell withNav={false}>
      <header className="flex items-center gap-3 px-5 pb-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(backTo)}
          className="-ml-1 p-1 text-ink-900"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className="text-[20px] font-semibold">{title}</h1>
      </header>

      <div className="pb-12">{children}</div>
    </MobileShell>
  );
}
