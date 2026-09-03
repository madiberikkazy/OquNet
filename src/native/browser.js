/**
 * Leaving the app on purpose.
 *
 * In a browser tab `target="_blank"` opens a tab and the app is still there
 * behind it. In a WebView there is no "behind": an ordinary link navigates the
 * one WebView the app lives in, and the reader is now looking at t.me with no
 * way back except killing the app. Every outbound link therefore has to say
 * that it is outbound, and this is how it says it.
 *
 * Two destinations, two behaviours, which is why there are two functions:
 *
 *   openInApp     an in-app browser sheet (SFSafariViewController / Chrome
 *                 Custom Tab). For reading something and coming back — terms,
 *                 a help page. The app stays alive underneath.
 *   openExternal  hand the URL to the OS and let it choose. This is the one
 *                 the Telegram flows need: `tg://` and `t.me` must reach the
 *                 *Telegram app*, and an in-app browser would open the web
 *                 client instead and lose the contact-card step entirely.
 */

import { Browser } from "@capacitor/browser";
import { isNative, hasPlugin } from "./platform.js";
import { logger } from "../utils/logger.js";

/** Read it and come back. Falls back to a new tab on web. */
export async function openInApp(url, { toolbarColor } = {}) {
  try {
    if (isNative && hasPlugin("Browser")) {
      await Browser.open({ url, toolbarColor, presentationStyle: "popover" });
      return true;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch (err) {
    logger.warn("browser.openInApp", err?.message);
    return false;
  }
}

/**
 * Leave, properly — the OS picks the handler, so an installed app wins over
 * its website. Anything with a custom scheme, or anything whose whole value is
 * that the native app handles it, goes through here.
 */
export async function openExternal(url) {
  try {
    if (isNative) {
      // `_system` is the Capacitor WebView's escape hatch: it is intercepted
      // before navigation and handed to the platform's URL opener, which is
      // what makes `tg://` and `mailto:` work. The Browser plugin cannot do
      // this — it only ever opens http(s) in a browser view.
      window.open(url, "_system");
      return true;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch (err) {
    logger.warn("browser.openExternal", err?.message);
    return false;
  }
}

/**
 * Wire an anchor up to leave the app.
 *
 * Spread onto an `<a href=…>` it keeps the element a real link — the href is
 * still there to be long-pressed, copied, or read by a screen reader — while
 * taking the navigation away from the WebView on native. On web it adds
 * nothing and the anchor behaves as it always did.
 *
 *   <a href={link} {...externalLink(link)}>…</a>
 */
export function externalLink(url, onClick) {
  return {
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (!isNative || !url) return;
      event.preventDefault();
      openExternal(url);
    },
  };
}
