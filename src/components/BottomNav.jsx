import { NavLink } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext.jsx";
import { useNotifications } from "../contexts/NotificationContext.jsx";
import { navIconSrc } from "../utils/icons.js";
import { t } from "../utils/i18n.js";

/**
 * The four tabs.
 *
 * The icons are files under public/drawable, two per tab — one for the selected
 * state and one for the rest — rather than inline SVG tinted by `currentColor`.
 * Artwork stops being code: replacing an icon everywhere is overwriting one
 * file, and a selected tab is free to be a different drawing rather than the
 * same drawing in a different colour. The label keeps its colour from the
 * theme, so the two halves of a tab still agree without the icon knowing
 * anything about the palette.
 */
export default function BottomNav() {
  useLang(); // subscribe to language changes so labels re-render
  const { unreadCount } = useNotifications();

  const items = [
    { to: "/", icon: "home", label: t.navHome },
    { to: "/books", icon: "books", label: t.navBooks },
    { to: "/notifications", icon: "notification", label: t.navNotification, badge: true },
    { to: "/profile", icon: "profile", label: t.navProfile },
  ];

  return (
    // No divider above the bar. A hairline there reads as a seam between the
    // app and the phone's own navigation strip below it — the two are meant to
    // look like one block, which is also why this background runs on into
    // `env(safe-area-inset-bottom)`.
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface">
      <ul className="grid grid-cols-4 py-2 w-full mx-auto sm:max-w-xl lg:max-w-2xl" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.to === "/"}
              className={({ isActive }) =>
                "flex flex-col items-center gap-1 py-1.5 text-[11px] font-medium transition-colors duration-150 " +
                (isActive ? "text-brand-500" : "text-ink-500")
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <img
                      src={navIconSrc(it.icon, isActive)}
                      alt=""
                      aria-hidden="true"
                      width={22}
                      height={22}
                      style={{ width: 22, height: 22 }}
                      className="shrink-0 select-none"
                      draggable={false}
                    />
                    {it.badge && unreadCount > 0 ? (
                      <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {unreadCount > 9 ? "9+" : unreadCount}
                      </span>
                    ) : null}
                  </span>
                  <span>{it.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
