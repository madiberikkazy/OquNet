import { NavLink } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext.jsx";
import { useChats } from "../contexts/ChatContext.jsx";
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
  const { unreadTotal } = useChats();
  // Notifications are counted here as well as on Home, and that is the point.
  // The bell lives in the Home header, so it says nothing at all while you are
  // on Books or in a chat — which is exactly when something arriving needs to
  // be visible. The tab bar is on every screen, so the count goes there too and
  // Home is the tab that carries it, because Home is where the bell is.
  const { unreadCount } = useNotifications();

  // One `count` per tab rather than a boolean and a single shared total: two
  // tabs carry a badge now, and they are counting different things.
  const items = [
    { to: "/", icon: "home", label: t.navHome, count: unreadCount },
    { to: "/books", icon: "books", label: t.navBooks },
    { to: "/chats", icon: "chats", label: t.navChats, count: unreadTotal },
    { to: "/profile", icon: "profile", label: t.navProfile },
  ];

  return (
    // Frosted, like the header at the top of the scroll — same `.app-glass`
    // material, so the two bars are made of one thing and the list passes
    // under both, with no border on either.
    //
    // The background runs on into `env(safe-area-inset-bottom)` so the
    // frosting covers the phone's own home-indicator strip rather than
    // stopping short of it: the app and the strip are meant to look like one
    // block, and a bar that ends above it would draw the seam it is avoiding.
    //
    // Not `fixed` itself: MobileShell pins the whole bottom stack, and this is
    // the bottom of it. That is what lets a screen put an action bar directly on
    // top of these tabs — the two are adjacent boxes in normal flow, so they
    // meet exactly, with no offset for anybody to compute and get wrong.
    <nav className="app-glass">
      <ul className="grid grid-cols-4 py-2 w-full mx-auto sm:max-w-xl lg:max-w-2xl" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.to === "/"}
              // "Home (3)" rather than the "Home 3" that the badge's bare
              // number would otherwise be read as — the same shape LikeButton
              // uses for a count beside a label. The truncated "9+" is
              // deliberately not what is announced: the real number is useful
              // to somebody who cannot see how big the dot is.
              aria-label={it.count > 0 ? `${it.label} (${it.count})` : undefined}
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
                    {it.count > 0 ? (
                      <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {it.count > 9 ? "9+" : it.count}
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
