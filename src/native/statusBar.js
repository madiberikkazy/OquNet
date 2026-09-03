/**
 * The native half of utils/systemBars.js.
 *
 * That module answers the hard question — *what colour is actually painted
 * against the top edge of this screen right now* — by hit-testing the viewport,
 * and then hands the answer to the web platform as `<meta name="theme-color">`.
 * A WebView ignores that meta tag entirely: the status bar belongs to the
 * activity, not the page. So the measurement stays exactly where it is and only
 * the delivery changes, which is all this file is.
 *
 * ── The two halves of a status bar, and what each platform gives us ──────────
 *
 *   icon colour   `setStyle`. Works everywhere, always, and it is the half that
 *                 actually matters: dark icons on a white header, light icons
 *                 on the blue one. Getting this wrong makes the clock invisible.
 *   background    `setBackgroundColor`. Android only, and only below Android 15
 *                 — from 15 the system bar is transparent by decree and the
 *                 call is a no-op. iOS never had it. So it is attempted and its
 *                 failure is not interesting.
 *
 * Because the background is the half that cannot be relied on, the style is
 * derived from the *measured* colour rather than from the theme: whatever ends
 * up behind the icons, light or dark, the icons are legible against it.
 */

import { StatusBar, Style } from "@capacitor/status-bar";
import { isNative, hasPlugin, isAndroid } from "./platform.js";
import { logger } from "../utils/logger.js";

export const canControlStatusBar = isNative && hasPlugin("StatusBar");

/**
 * Perceived brightness of a hex colour, 0–1.
 *
 * The sRGB luminance coefficients, same as the ones Android uses internally to
 * make this decision — so a colour near the boundary is judged the way the OS
 * would have judged it.
 */
function luminance(hex) {
  const value = String(hex || "").replace("#", "");
  if (value.length !== 6) return 1;
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// Both writes are skipped when the answer has not moved. syncSystemBars runs on
// every scroll frame, and each of these crosses the JS↔native bridge — cheap
// once, not cheap sixty times a second.
let lastStyle = null;
let lastColor = null;

/**
 * Paint the status bar to match `hexColor`.
 *
 * Called by utils/systemBars.js with the colour it just measured at the top of
 * the viewport. Never throws: a status bar that could not be repainted is a
 * cosmetic problem, and it must not take a scroll handler down with it.
 */
export function applyStatusBarColor(hexColor) {
  if (!canControlStatusBar || !hexColor) return;

  // > 0.5 is "this is a light background", so the icons must be dark — which
  // the plugin, confusingly, calls Style.Light. The name describes the
  // background it is meant for, not the icons it produces.
  const style = luminance(hexColor) > 0.5 ? Style.Light : Style.Dark;

  if (style !== lastStyle) {
    lastStyle = style;
    StatusBar.setStyle({ style }).catch((err) => logger.warn("statusBar.style", err?.message));
  }

  // Android only, and only where the platform still honours it. Attempted
  // rather than feature-detected: there is no way to ask, and the failure is a
  // rejected promise with nothing to do about it.
  if (isAndroid && hexColor !== lastColor) {
    lastColor = hexColor;
    StatusBar.setBackgroundColor({ color: hexColor }).catch(() => {});
  }
}

/** Forget the last write — for a theme change, which repaints without moving. */
export function resetStatusBar() {
  lastStyle = null;
  lastColor = null;
}
