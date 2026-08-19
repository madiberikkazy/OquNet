/**
 * The two strips the app does not draw: the status bar above it and the
 * Android navigation bar below it.
 *
 * A phone app has no seam there — the status bar is whatever colour the top of
 * the screen is, and it changes as you move between screens. A web app gets
 * that only if it says so, and the two halves are said in different ways:
 *
 *   top     `<meta name="theme-color">`. Android reads it live, so writing a
 *           new value repaints the status bar immediately.
 *   bottom  the *document* background colour — the canvas, which is the root
 *           element's background (and only falls through to <body> when the
 *           root has none of its own). Chrome paints a standalone PWA's
 *           navigation bar with it. On Android 15 and later the bar is
 *           transparent instead and the page simply shows through, which lands
 *           in the same place: our bottom navigation already extends its own
 *           background into `env(safe-area-inset-bottom)`.
 *
 * Neither colour is declared per screen anywhere. They are *measured*: this
 * module asks what is actually painted at the top and bottom edges of the
 * viewport and hands those two answers to the OS. A new screen, a header that
 * scrolls away, a themed banner, a screen with no bottom bar at all — all of
 * them are already correct, because none of them has to remember to say so.
 *
 * iOS takes no part in the *colour* half of this:
 * `apple-mobile-web-app-status-bar-style` is read once at launch and has three
 * fixed values, so a standalone iOS install keeps the bar it was given. It does
 * take part in the second half of this file, which is about the bar's *height*
 * — under `black-translucent` the page runs underneath it and has to say so.
 */

const THEME_COLOR = 'meta[name="theme-color"]';

/** rgb()/rgba() as numbers, or null for `transparent` and anything unparseable. */
function parseColor(value) {
  const m = /^rgba?\(([^)]+)\)$/.exec(value || "");
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = parts;
  const a = parts.length > 3 ? parts[3] : 1;
  return { r, g, b, a };
}

/** `over` composited onto `under` — the two colours a translucent layer makes. */
function composite(over, under) {
  const a = over.a + under.a * (1 - over.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (o, u) => Math.round((o * over.a + u * under.a * (1 - over.a)) / a);
  return { r: mix(over.r, under.r), g: mix(over.g, under.g), b: mix(over.b, under.b), a };
}

function toHex({ r, g, b }) {
  return "#" + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}

/**
 * Does this element reach both sides of the screen?
 *
 * Only such an element counts towards a bar's colour, and the restriction is
 * the difference between a bar that tracks the screen and one that flickers. A
 * card, a button, a chip — anything with a margin — passes under the top edge
 * as the page scrolls, and a status bar that took its colour would strobe
 * between the page and every card that went by. A full-bleed band, a header, a
 * docked bottom bar: those *are* the edge of the screen, and they are what a
 * person means when they say the bar should match what is next to it.
 *
 * A tolerance of one pixel, because layout arithmetic lands on fractions.
 */
function spansViewport(node) {
  const rect = node.getBoundingClientRect();
  return rect.left <= 1 && rect.right >= window.innerWidth - 1;
}

/**
 * What is actually painted at (x, y), as an opaque colour.
 *
 * The element under the point is usually a label or an icon with no background
 * of its own, so this walks up its ancestors collecting whatever each one
 * paints and composites them back down. Translucent layers matter: an overlay
 * at 15% over a blue band is neither white nor blue, and the bar should be the
 * colour a person actually sees.
 */
export function paintedColorAt(x, y) {
  if (typeof document === "undefined" || !document.elementFromPoint) return null;
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;

  // A bar that paints itself in a pseudo-element has to *say* what colour it
  // is, because nothing below can see it: elementFromPoint returns real
  // elements only, so the frosted strip at the top of the screen is invisible
  // to the walk below and the page behind it would be reported instead. The
  // property inherits, so it answers wherever inside the bar the point landed.
  const declared = window.getComputedStyle(hit).getPropertyValue("--bar-tint").trim();
  if (declared) return declared;

  const layers = [];
  for (let node = hit; node; node = node.parentElement) {
    if (!spansViewport(node)) continue;
    const style = window.getComputedStyle(node);
    // An element the page has faded out — mid route transition, say — paints
    // less than its background says it does.
    const opacity = Number(style.opacity);
    const colour = parseColor(style.backgroundColor);
    if (colour && colour.a > 0) {
      layers.push(Number.isFinite(opacity) ? { ...colour, a: colour.a * opacity } : colour);
      if (colour.a >= 1 && opacity >= 1) break;
    }
  }
  if (!layers.length) return null;

  // Bottom-most first, then everything above it painted on in order.
  let result = layers[layers.length - 1];
  for (let i = layers.length - 2; i >= 0; i -= 1) result = composite(layers[i], result);
  return result.a >= 0.99 ? toHex(result) : null;
}

/** The theme's own page colour — the answer when nothing is painted yet. */
function baseColour() {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--bg-base");
  return value.trim() || "#ffffff";
}

let lastTop = null;
let lastBottom = null;

/**
 * Measure both edges and hand them to the OS.
 *
 * Writes are skipped when nothing changed: this runs on every scroll frame, and
 * re-setting `theme-color` to the value it already has still costs Android a
 * repaint of the bar.
 */
export function syncSystemBars() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // Nothing to measure and nothing on screen to be wrong: a hidden page has no
  // layout to hit-test, so every sample would come back empty and be "corrected"
  // to the plain page colour — which is how a backgrounded app comes back to a
  // white bar over a blue header. The visibilitychange listener re-measures.
  if (document.hidden) return;
  if (!window.innerWidth || !window.innerHeight) return;

  const x = Math.round(window.innerWidth / 2);
  const bottomY = Math.max(0, window.innerHeight - 1);
  const fallback = baseColour();

  const top = paintedColorAt(x, 0) || fallback;
  const bottom = paintedColorAt(x, bottomY) || fallback;

  if (top !== lastTop) {
    lastTop = top;
    let meta = document.querySelector(THEME_COLOR);
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", top);
  }

  if (bottom !== lastBottom) {
    lastBottom = bottom;
    // The root element, not <body>. Body still paints `--bg-base` over the whole
    // viewport exactly as before — this only decides what the canvas *behind* it
    // is, which is the value the browser hands to the navigation bar.
    document.documentElement.style.backgroundColor = bottom;
  }
}

/** Forget the last measurement — for a change that repaints without moving. */
export function resetSystemBars() {
  lastTop = null;
  lastBottom = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// How far the status bar reaches into the page
//
// `env(safe-area-inset-top)` is the answer wherever a platform gives one, and
// this asks CSS for it rather than assuming — the value is not knowable from
// the user agent, only from the window the OS actually handed us.
//
// The awkward part is that **zero is two different facts**:
//
//   a. the window already begins below the status bar, so there is nothing to
//      reach under and nothing to draw — Android with `display: standalone`,
//      and iOS before this app moved to `black-translucent`; or
//   b. we are edge-to-edge and the platform simply did not report the inset,
//      which some Android builds do.
//
// Padding a fixed 24-32px in case it is (b) would put a dead band across the
// top of every screen where it is really (a) — a visible gap, on the far more
// common case, to fix the rarer one. So the two are told apart instead, by the
// one thing that actually distinguishes them: in (b) our viewport reaches the
// top of the display, and in (a) something has already been taken off it.
//
// Where that test is not conclusive the answer stays 0, because a bar that is
// slightly too short is invisible and a gap is not.
// ─────────────────────────────────────────────────────────────────────────────

/** A plausible Android status bar, used only once (b) has been established. */
const ANDROID_STATUS_BAR_PX = 28;

/**
 * The smallest slice off the viewport that counts as "the system already took
 * its share". A gesture-navigation handle alone is around 24px, a status bar
 * around 24-32, so anything at or above this means we are not edge-to-edge.
 */
const INSET_EVIDENCE_PX = 16;

let probe = null;

/** `env(safe-area-inset-top)` in CSS pixels — asked of the engine, not guessed. */
function envInsetTop() {
  if (!probe) {
    probe = document.createElement("div");
    // Laid out but invisible and untouchable: it needs a real box for
    // offsetHeight to mean anything, and nothing else about it may matter.
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;" +
      "height:env(safe-area-inset-top,0px)";
    probe.setAttribute("aria-hidden", "true");
  }
  if (!probe.isConnected) document.body.appendChild(probe);
  return probe.offsetHeight || 0;
}

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    // iOS predates the display-mode media query for installed web apps.
    window.navigator.standalone === true
  );
}

/**
 * The inset to paint under, in CSS pixels.
 *
 * @returns a number ≥ 0. Zero means "draw nothing" and is a real answer.
 */
export function measureStatusBarInset() {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;

  const reported = envInsetTop();
  if (reported > 0) return reported;

  // A tab in a browser is below the browser's own chrome; the status bar is the
  // browser's problem there, not ours.
  if (!isStandalone()) return 0;

  const screenHeight = window.screen?.height || 0;
  const viewport = window.innerHeight || 0;
  if (!screenHeight || !viewport) return 0;

  // Something already came off the top (or the bottom): the system has taken
  // its share and we are not the ones drawing over it.
  if (screenHeight - viewport >= INSET_EVIDENCE_PX) return 0;

  return ANDROID_STATUS_BAR_PX;
}

let lastInset = null;

/** Publish the inset as `--status-bar-height`, skipping an unchanged write. */
export function syncStatusBarInset() {
  if (typeof document === "undefined") return;
  const inset = measureStatusBarInset();
  if (inset === lastInset) return;
  lastInset = inset;
  document.documentElement.style.setProperty("--status-bar-height", `${inset}px`);
}
