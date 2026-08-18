import BottomNav from "./BottomNav.jsx";

/**
 * MobileShell — full-screen, edge-to-edge layout.
 * No card chrome, no gray borders — white all the way.
 *
 * Responsive content column:
 *  • Mobile  (< 640 px) : full width, px-4
 *  • Tablet  (640–1023): max-w-xl centered, px-6
 *  • Desktop (≥ 1024 px): max-w-2xl centered, px-8
 *
 * `header` is an optional bar that stays at the top of the screen while the
 * page scrolls under it — the frosted iOS one. Two things had to change for
 * `position: sticky` to work at all here, and both are the kind that fail
 * silently:
 *
 *  1. `<main>` used to carry `overflow-y-auto`, which made it the nearest
 *     scrollport for everything inside it. It never actually scrolled — the
 *     shell is `min-h-screen`, so the *document* scrolls and main just grows —
 *     so a sticky child had nothing to stick against and scrolled away with
 *     the page. Measured before removing it: main's scrollHeight and
 *     clientHeight were identical at 4105 px while the document ran to 4115.
 *     Nothing depended on it; the one screen that genuinely scrolls a region,
 *     Chat.jsx, builds its own and never used this.
 *
 *  2. `page-transition` ends on `transform: translateY(0)` with fill-mode
 *     `both`, so the transform *persists* — and a transformed ancestor becomes
 *     the containing block for sticky descendants, which breaks them the same
 *     silent way. The animation now wraps the content rather than the whole
 *     column, which also reads better: the bar stays put across a route change
 *     and the page slides in beneath it, exactly as a native one does.
 */
export default function MobileShell({ children, header = null, withNav = true }) {
  return (
    <div className="min-h-screen bg-base flex flex-col">
      <main className={"flex-1 w-full " + (withNav ? "pb-24" : "pb-4")}>
        {/* Responsive centred column */}
        <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl">
          {header ? (
            // `top: 0` is already below the status bar: the app declares
            // `apple-mobile-web-app-status-bar-style: default`, so an installed
            // iOS PWA insets its own viewport. The safe-area padding is there
            // for the day that changes to `black-translucent`, where it starts
            // reporting a real inset instead of zero.
            <div
              className="app-glass sticky top-0 z-30 pt-4"
              style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
            >
              {header}
            </div>
          ) : null}

          <div className={"page-transition " + (header ? "" : "pt-4")}>
            {children}
          </div>
        </div>
      </main>
      {withNav ? <BottomNav /> : null}
    </div>
  );
}
