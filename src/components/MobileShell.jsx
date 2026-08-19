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
      {/* The strip under the clock, for a screen with no header to cover it.
          Always rendered: it costs nothing where the inset is zero, and a
          screen that only *sometimes* protects the status bar is a screen that
          flickers on the way in. A header, when there is one, paints over this
          in the same colour — so the two never show a seam and, because this
          sits a layer below, never blur the same pixels twice. */}
      <div className="status-scrim" aria-hidden="true" />
      <main className={"flex-1 w-full " + (withNav ? "pb-24" : "pb-4")}>
        {/* Responsive centred column */}
        <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl">
          {header ? (
            // The bar reaches all the way up under the clock now: the app
            // declares `black-translucent`, which is the only iOS mode that
            // puts the page under the status bar at all. `--status-bar-inset`
            // is how far that is — env(safe-area-inset-top) wherever a platform
            // reports one, and a measured fallback where it does not. It
            // resolves to 0 in a browser tab, which is the right answer there.
            <div
              className="app-topbar sticky top-0 z-30"
              style={{ paddingTop: "max(1rem, var(--status-bar-inset))" }}
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
