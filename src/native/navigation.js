/**
 * Navigation, as a phone means it.
 *
 * A browser tab has one back affordance and it is the browser's. A phone has
 * two — the Android system back gesture, and whatever the app draws — and they
 * are expected to agree. Getting that agreement is what this file is for; the
 * `useNativeNavigation` hook in bridge.jsx is what installs it.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * System back does what the in-app back arrow does, one step at a time, until
 * there is nothing left to pop. Then — and this is the part a WebView gets
 * wrong on its own — it does *not* navigate the WebView off the app and leave a
 * blank white screen. It either lands on the home tab, or it closes the app.
 *
 * ── Why the tab roots are a special case ─────────────────────────────────────
 *
 * The four tabs are switched with `navigate`, so they stack: Home → Books →
 * Chats leaves three entries, and popping them one by one walks the reader
 * backwards through their own tab history before anything closes. That is
 * correct on the web, where the back button *is* history. It is wrong on a
 * phone, where every app in the drawer treats back from a tab root as "go to
 * the first tab", and back from the first tab as "leave".
 *
 * So: on a tab root, back is a tab decision. Anywhere else, back is a pop.
 */

import { App } from "@capacitor/app";
import { isAndroid, isNative, hasPlugin, publicOrigin } from "./platform.js";
import { logger } from "../utils/logger.js";

/** The tab bar, in the order BottomNav draws it. Index 0 is where back lands. */
export const TAB_ROUTES = ["/", "/books", "/chats", "/profile"];

export function isTabRoot(pathname) {
  return TAB_ROUTES.includes(pathname);
}

/**
 * How long a second back press still counts as "I meant it".
 *
 * Closing an app on one stray gesture is the kind of thing that loses a draft.
 * Two presses inside two seconds is the convention every Android app uses, and
 * the reader already knows it.
 */
export const EXIT_CONFIRM_MS = 2000;

/**
 * Turn an incoming URL into a route this app can navigate to.
 *
 * Handles the two shapes a deep link arrives in:
 *
 *   https://oqunet.app/users/abc   an App Link / Universal Link — a real web
 *                                  URL that the OS decided this app owns. This
 *                                  is what the share sheet puts in a chat, and
 *                                  it has to work whether or not the app is
 *                                  installed, which is exactly why the shared
 *                                  link is an https one.
 *   oqunet://users/abc             the custom scheme, for anything that cannot
 *                                  use a verified domain — an OAuth return, a
 *                                  notification payload.
 *
 * Returns null for a URL that is not ours, and the caller ignores it rather
 * than navigating somewhere arbitrary. A deep link is untrusted input: it comes
 * from whatever app handed it over, so nothing here treats it as more than a
 * path to look up.
 */
export function routeFromUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const isOurScheme = url.protocol === "oqunet:";
  const isOurDomain = `${url.protocol}//${url.host}` === publicOrigin;
  if (!isOurScheme && !isOurDomain) return null;

  // A custom-scheme URL puts the first segment in `host` ("oqunet://users/abc"
  // parses as host "users", pathname "/abc"), so the two shapes have to be
  // reassembled differently to arrive at the same route.
  const path = isOurScheme ? `/${url.host}${url.pathname}` : url.pathname;
  const route = `${path}${url.search}${url.hash}`.replace(/\/{2,}/g, "/");

  // Never hand back something that would leave the app, and never hand back
  // the bare root — a link to "/" is the app opening normally, not a deep link.
  if (!route.startsWith("/") || route.startsWith("//")) return null;
  return route === "/" ? null : route;
}

/**
 * The URL the app was cold-started with, if it was started by a link.
 *
 * `appUrlOpen` fires for a link that arrives while the app is *running*. A link
 * that launched the app from nothing may have been delivered before any
 * listener existed, and this is the only way to see it.
 */
export async function initialDeepLink() {
  if (!isNative || !hasPlugin("App")) return null;
  try {
    // Resolves to `undefined`, not `{ url: undefined }`, when the app was
    // started normally — which is every launch that is not a deep link, so
    // destructuring it directly threw on startup every single time. Caught, and
    // therefore harmless, but it logged a warning on every cold start and hid
    // any real failure behind noise.
    const launch = await App.getLaunchUrl();
    return routeFromUrl(launch?.url);
  } catch (err) {
    logger.warn("nav.launchUrl", err?.message);
    return null;
  }
}

/** Close the app — the real thing, not a history navigation. Android only. */
export function exitApp() {
  // iOS has no API for this and Apple rejects apps that fake one: an iPhone is
  // left with the home indicator, which is how every iOS app is left.
  if (!isAndroid || !hasPlugin("App")) return;
  App.exitApp().catch((err) => logger.warn("nav.exit", err?.message));
}
