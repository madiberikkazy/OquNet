/**
 * Which of the three apps is this?
 *
 * The same bundle now ships three ways — a browser tab, an installed PWA, and
 * a Capacitor binary in the two stores — and a handful of things have to be
 * decided differently in the third. Not many: the screens, the router, the data
 * layer and every Firebase call are identical, because a Capacitor app is a
 * WebView running exactly this code. What differs is the seam with the OS, and
 * that seam is what `src/native/` is.
 *
 * The rule for the rest of the app: never branch on the platform at a call
 * site. Import the wrapper from this directory — `share`, `photo`, `browser`,
 * `clipboard` — and let it decide. There is one implementation of "share a
 * link" and it knows about two worlds; there are not fifty screens that each
 * remember to check.
 *
 * `Capacitor.isNativePlatform()` is the only signal worth trusting here. The
 * user agent lies (a WebView reports Chrome or Safari), and `window.Capacitor`
 * exists on web too once the runtime is bundled — it is the *platform* it
 * reports that separates them.
 */

import { Capacitor } from "@capacitor/core";

/** Inside an actual iOS/Android binary, as opposed to any kind of browser. */
export const isNative = Capacitor.isNativePlatform();

/** "ios" | "android" | "web" — the three, spelled the way Capacitor spells them. */
export const platform = Capacitor.getPlatform();

export const isIOS = platform === "ios";
export const isAndroid = platform === "android";

/** Web, whether a plain tab or an installed PWA. The negation, named. */
export const isWeb = !isNative;

/**
 * Is a given Capacitor plugin actually present?
 *
 * A plugin's JS half is always importable — it is in the bundle — but on web
 * most of them are either a stub that throws `Unimplemented` or a genuine web
 * implementation, and the two are indistinguishable from the import alone.
 * Every wrapper in this directory asks this before reaching for a plugin, so a
 * web build that never installed the native half degrades to its fallback
 * instead of throwing inside a click handler.
 */
export function hasPlugin(name) {
  return Capacitor.isPluginAvailable(name);
}

/**
 * The origin a link shared out of this app should point at.
 *
 * On web this is where the app is already running. Inside the binary
 * `window.location.origin` is the WebView's own scheme — `capacitor://localhost`
 * on iOS, `https://localhost` on Android — which is a real URL to nobody. A
 * profile link built from it is dead on arrival in the chat it was pasted into,
 * and it was: this is the fix for the two places that built share URLs that way.
 *
 * VITE_PUBLIC_ORIGIN is baked in at build time. Unset, a web build still works
 * off its own origin — only a native build needs it, and a native build without
 * it falls back to the production domain rather than shipping `capacitor://`
 * links to real people.
 */
const FALLBACK_ORIGIN = "https://oqunet.app";

export const publicOrigin = (() => {
  const configured = import.meta.env?.VITE_PUBLIC_ORIGIN;
  if (configured) return String(configured).replace(/\/+$/, "");
  if (isNative) return FALLBACK_ORIGIN;
  // `window?.location?.origin`, not `window.location.origin`: the data-layer
  // tests run these modules under Node with a partial `window` shim that has
  // storage but no location, and reaching through it threw on import — which
  // took down every test in the file, not just the ones that share links.
  return window?.location?.origin || FALLBACK_ORIGIN;
})();

/** A public, shareable URL for an in-app path. Always pass paths through this. */
export function publicUrl(path) {
  return `${publicOrigin}${path.startsWith("/") ? path : `/${path}`}`;
}
