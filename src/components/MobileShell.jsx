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
 *  2. `page-transition` used to end on a persisting `transform: translateY(0)`
 *     — fill-mode `both` — and a transformed ancestor becomes the containing
 *     block for sticky descendants, which breaks them the same silent way. The
 *     animation now wraps the content rather than the whole column, which also
 *     reads better: the bar stays put across a route change and the page slides
 *     in beneath it, exactly as a native one does. The fill mode is `backwards`
 *     now as well, so the transform lives only while the animation runs — see
 *     the note on `.page-transition` in index.css, which is where the same trap
 *     was swallowing every modal in the app.
 *
 * `fab`, `bottomBar` and `overlay` are slots rather than something a screen
 * drops into its own markup, because none of them is page content: they belong
 * to the window, they must not scroll with the page or take part in its layout,
 * and they must outlive the page transition rather than slide in with it.
 * Rendered here they are siblings of `<main>` — chrome beside content, which is
 * what they are.
 *
 * `bottomBar` also earns the page some room to end in: it covers the bottom of
 * the screen, so the content has to be able to scroll clear of it, which is
 * what the extra bottom padding below is for.
 */
export default function MobileShell({
  children, header = null, withNav = true, fab = null, bottomBar = null,
  bottomBarSurface = false, overlay = null,
}) {
  // Room at the end of the page for whatever is pinned over it. `pb-24` is the
  // tab bar alone, as before; the taller values add the action bar — generous
  // on purpose, since a bar can hold a note above its button, and blank space
  // after the last section costs nothing while content hidden under a bar is a
  // bug you only find on the one screen that has a long one.
  const bottomPad = bottomBar
    ? (withNav ? "pb-44" : "pb-28")
    : (withNav ? "pb-24" : "pb-4");

  return (
    <div className="min-h-screen bg-base flex flex-col">
      <main className={"flex-1 w-full " + bottomPad}>
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

      {fab}

      {/* The bottom stack: an optional action bar resting directly on the tab
          bar. One fixed container holding both, rather than two fixed elements
          and a number to keep them apart — stacked in normal flow they meet
          exactly, and neither has to know how tall the other is. (It was worth
          measuring: the tab bar is 74.5px on a phone with no home indicator,
          which is not a number anybody would have guessed right.)

          The action bar carries no background of its own — no panel, no
          frosting, just the control. The tab bar below it is a surface because
          it is always there on every screen; this is one button belonging to
          one page, and giving it a slab of its own made it look like a second
          bar bolted under the first.

          Which means it must not take taps where it is not drawn: the strip is
          click-through and only its contents accept a tap, so the page keeps
          the width of the screen. */}
      {bottomBar || withNav ? (
        <div className="fixed inset-x-0 bottom-0 z-50">
          {bottomBar ? (
            // Backgroundless by default — see above. `bottomBarSurface` is for
            // the one bar that cannot be: a composer, where text scrolling
            // behind the field being typed into is not a look, it is a bug.
            <div className={bottomBarSurface ? "bg-surface border-t border-ink-100" : "pointer-events-none"}>
              <div
                className={
                  "w-full mx-auto sm:max-w-xl lg:max-w-2xl px-4 pt-3" +
                  (bottomBarSurface ? "" : " pointer-events-auto")
                }
                // With tabs below, they carry the home-indicator strip. Without
                // them this bar is the bottom of the screen and carries it.
                style={{ paddingBottom: withNav ? "0.75rem" : "max(0.75rem, env(safe-area-inset-bottom))" }}
              >
                {bottomBar}
              </div>
            </div>
          ) : null}
          {withNav ? <BottomNav /> : null}
        </div>
      ) : null}

      {/* Sheets and dialogs, over everything else. Last in the DOM so it wins
          the stack against the bars above without needing a higher z-index. */}
      {overlay}
    </div>
  );
}
