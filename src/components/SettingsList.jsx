import { useNavigate } from "react-router-dom";
import AppIcon from "./AppIcon.jsx";

/**
 * The settings screen is one visual language repeated everywhere: a stack of
 * rows, each with an icon, a label, and either a value, a chevron, or both.
 * Rows are grouped by topic, and groups are separated by a hairline.
 */

export function SettingsGroup({ children, className = "" }) {
  return (
    <div className={"px-5 " + className}>
      <div className="divide-y divide-ink-100">{children}</div>
    </div>
  );
}

export function GroupDivider() {
  return <div className="h-px bg-ink-100 mx-5 my-1" />;
}

/**
 * One tappable row.
 *
 * `to`      — navigate to a route
 * `onClick` — run an action instead
 * `value`   — right-aligned secondary text (theme name, language, …)
 * `chevron` — show the ">" affordance (default: only when `to` is set)
 * `danger`  — destructive styling (log out, delete account)
 */
export function SettingsRow({
  icon,
  label,
  value,
  to,
  onClick,
  chevron,
  danger = false,
  disabled = false,
  subtitle,
}) {
  const navigate = useNavigate();
  const showChevron = chevron ?? Boolean(to);

  function handleClick() {
    if (disabled) return;
    if (onClick) return onClick();
    if (to) navigate(to);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={
        "w-full flex items-center gap-3 py-4 text-left transition active:opacity-60 " +
        (disabled ? "opacity-50 cursor-not-allowed " : "")
      }
    >
      {icon ? <AppIcon name={icon} size={22} /> : <span className="w-[22px]" />}

      <span className="flex-1 min-w-0">
        <span
          className={
            "block text-[15px] leading-tight " +
            (danger ? "text-bad font-medium" : "text-ink-900")
          }
        >
          {label}
        </span>
        {subtitle ? (
          <span className="block text-[12px] text-ink-500 mt-0.5">{subtitle}</span>
        ) : null}
      </span>

      {value ? (
        <span className="text-[14px] text-ink-300 shrink-0 max-w-[38%] truncate">
          {value}
        </span>
      ) : null}

      {showChevron ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          className="text-ink-300 shrink-0"
        >
          <path
            d="M9 5l7 7-7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}

/** A plain switch row — used by the notification sub-page. */
export function ToggleRow({ label, subtitle, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] text-ink-900 leading-tight">{label}</span>
        {subtitle ? (
          <span className="block text-[12px] text-ink-500 mt-0.5">{subtitle}</span>
        ) : null}
      </span>
      <label className="relative inline-flex items-center cursor-pointer shrink-0">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={Boolean(checked)}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <div className="w-11 h-6 rounded-full bg-ink-300 peer-checked:bg-brand-500 peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
      </label>
    </div>
  );
}
