import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { resetSystemBars, syncStatusBarInset, syncSystemBars } from "../utils/systemBars.js";

/**
 * Keeps the status bar and the Android navigation bar the colour of whatever
 * the app is painting against them. Renders nothing; see utils/systemBars.js
 * for how the two colours are arrived at.
 *
 * When to re-measure, and why each one is here:
 *
 *   scroll         a header that scrolls out from under the status bar changes
 *                  the answer. Captured on the document rather than the window
 *                  because the page scrolls inside MobileShell's <main>, and a
 *                  scroll event on an element does not reach the window.
 *   route change   the new screen is a new set of colours — and it arrives in
 *                  stages, so this samples again as the transition settles and
 *                  once more after lazily-loaded content has had time to land.
 *   theme          the palette moved under everything.
 *   resize         the rotate/keyboard case: the bottom edge is somewhere else
 *                  now, and it may be over something different.
 *   visibility     coming back from the background, where the OS may have
 *                  repainted its bars for somebody else.
 *
 * Every one of those ends in the same measurement, and the measurement writes
 * nothing when the answer has not changed — which is what makes it safe to run
 * it on a scroll frame.
 */
export default function SystemBars() {
  const { pathname } = useLocation();
  const { theme } = useTheme();

  // The listeners outlive any one screen, so they are attached once.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The inset first: the bars' colours are sampled at y=0, and on the
        // frame the inset changes that point is over a strip that has only just
        // been given a height.
        syncStatusBarInset();
        syncSystemBars();
      });
    };

    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    document.addEventListener("visibilitychange", measure);

    // The safety net for content that arrives late — a query that took two
    // seconds, an image that finally decoded. It changes the page's height, and
    // there is no scroll or route event to notice that it also changed what is
    // sitting against the top of the screen.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.body);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      document.removeEventListener("visibilitychange", measure);
    };
  }, []);

  useEffect(() => {
    // The palette or the screen changed, so the cached answer is worthless —
    // the colour may be new while the *measurement point* is identical.
    resetSystemBars();

    // Once now, then just past the end of the page-transition animation (220ms
    // in index.css — until it finishes, the new screen is still sliding down
    // and the old colour is what is under the top edge), and once more for a
    // lazy route whose first frame is a spinner.
    const frame = requestAnimationFrame(() => {
      syncStatusBarInset();
      syncSystemBars();
    });
    const timers = [240, 600].map((ms) => setTimeout(syncSystemBars, ms));

    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
    };
  }, [pathname, theme]);

  return null;
}
