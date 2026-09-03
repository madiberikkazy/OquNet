import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { Network } from "@capacitor/network";
import { SplashScreen } from "@capacitor/splash-screen";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { isNative, isAndroid, isIOS, hasPlugin } from "./platform.js";
import {
  EXIT_CONFIRM_MS, exitApp, initialDeepLink, isTabRoot, routeFromUrl, TAB_ROUTES,
} from "./navigation.js";
import { onNotificationTapped } from "./push.js";
import { syncSystemBars, resetSystemBars } from "../utils/systemBars.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/**
 * NativeBridge — everything the OS says to the app, in one place.
 *
 * Rendered once, from <App>, inside the router because half of what it does is
 * navigate. On web every effect below short-circuits on the first line and the
 * component renders nothing, so there is no second version of the app and no
 * screen has to know which build it is in.
 *
 * The five conversations it handles:
 *
 *   back        the Android system gesture — see native/navigation.js for the
 *               rule it implements and why a tab root is different.
 *   deep links  a URL handed over by another app, cold or warm.
 *   push taps   a notification the OS drew while the app was closed, and where
 *               tapping it should land.
 *   splash      taking the launch image down on the frame the app is ready.
 *   lifecycle   background and foreground, which is what tells TanStack Query
 *               that "the window regained focus" — an event a WebView does not
 *               reliably fire on its own.
 *   network     the same, for online/offline: `navigator.onLine` lies inside a
 *               WebView, and the plugin asks the platform instead.
 *   keyboard    whether it is up, so the tab bar can get out of its way.
 */
export default function NativeBridge() {
  useBackButton();
  useDeepLinks();
  usePushRouting();
  useSplash();
  useLifecycle();
  useNativeNetwork();
  useKeyboardState();
  return <ExitHint />;
}

// ── Back ─────────────────────────────────────────────────────────────────────

/**
 * A ref rather than state for the exit timestamp: nothing renders from it, and
 * a state write here would re-register the listener on every back press.
 */
function useBackButton() {
  const navigate = useNavigate();
  const location = useLocation();
  // The listener is registered once, but it has to see the *current* route.
  // Reading it from a ref keeps one registration instead of one per navigation
  // — and a listener re-registered mid-gesture is a back press that gets lost.
  const routeRef = useRef(location.pathname);
  routeRef.current = location.pathname;

  useEffect(() => {
    if (!isAndroid || !hasPlugin("App")) return;

    let handle;
    let lastExitPress = 0;

    const onBack = ({ canGoBack }) => {
      const pathname = routeRef.current;

      if (!isTabRoot(pathname)) {
        // Anywhere below a tab: pop, exactly like the in-app arrow. `canGoBack`
        // is the WebView's own answer and it is the honest one — a screen
        // reached by a deep link has nothing behind it even though it is four
        // levels deep by name.
        if (canGoBack && window.history.state?.idx > 0) navigate(-1);
        else navigate(TAB_ROUTES[0], { replace: true });
        return;
      }

      // On a tab root. Not the first tab: go to the first tab.
      if (pathname !== TAB_ROUTES[0]) {
        navigate(TAB_ROUTES[0], { replace: true });
        return;
      }

      // On the first tab. Twice inside the window means leave.
      const now = Date.now();
      if (now - lastExitPress < EXIT_CONFIRM_MS) {
        exitApp();
        return;
      }
      lastExitPress = now;
      window.dispatchEvent(new CustomEvent("oqunet:exit-hint"));
    };

    CapApp.addListener("backButton", onBack)
      .then((h) => { handle = h; })
      .catch((err) => logger.warn("nav.back", err?.message));

    return () => { handle?.remove(); };
  }, [navigate]);
}

/** "Press back again to exit" — the second half of the gesture above. */
function ExitHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isAndroid) return;
    let timer;
    const show = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), EXIT_CONFIRM_MS);
    };
    window.addEventListener("oqunet:exit-hint", show);
    return () => {
      window.removeEventListener("oqunet:exit-hint", show);
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  // Above the tab bar rather than centred: it answers a gesture made at the
  // bottom of the screen, and it must not cover the thing the reader is looking
  // at. Not a Modal — it takes no taps and steals no focus.
  return (
    <div
      className="fixed inset-x-0 z-[300] flex justify-center pointer-events-none"
      style={{ bottom: "calc(84px + env(safe-area-inset-bottom))" }}
      role="status"
      aria-live="polite"
    >
      <div className="rounded-full bg-ink-900/85 text-white text-[13px] px-4 py-2 shadow-lg">
        {t.pressBackToExit}
      </div>
    </div>
  );
}

// ── Deep links ───────────────────────────────────────────────────────────────

function useDeepLinks() {
  const navigate = useNavigate();

  const go = useCallback((route) => {
    if (!route) return;
    // Not `replace`: the reader arrived from somewhere else entirely, and a
    // back press should leave them where the link put them rather than
    // silently swapping it for whatever the app happened to be showing.
    navigate(route);
  }, [navigate]);

  useEffect(() => {
    if (!isNative || !hasPlugin("App")) return;

    let handle;
    let cancelled = false;

    // A link that launched the app from cold was delivered before this listener
    // existed, so it has to be asked for rather than waited on.
    initialDeepLink().then((route) => { if (!cancelled) go(route); });

    CapApp.addListener("appUrlOpen", ({ url }) => go(routeFromUrl(url)))
      .then((h) => { handle = h; })
      .catch((err) => logger.warn("nav.deepLink", err?.message));

    return () => { cancelled = true; handle?.remove(); };
  }, [go]);
}

// ── Push taps ────────────────────────────────────────────────────────────────

/**
 * Where a tapped notification lands.
 *
 * The route is chosen in native/push.js — from `data.route` on the payload, or
 * the notifications list when the payload does not say — because that is where
 * the payload is understood. This is only the half that can navigate.
 */
function usePushRouting() {
  const navigate = useNavigate();
  useEffect(() => onNotificationTapped((route) => navigate(route)), [navigate]);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Take the splash down once React has actually painted something.
 *
 * Its own effect, gated on its own plugin, and deliberately not folded into
 * `useLifecycle` below: hiding the splash is the one thing here that the app
 * cannot afford to skip. Tied to the App plugin's availability, a missing or
 * failed plugin would leave the launch image on screen forever, which looks
 * exactly like a frozen app.
 *
 * `launchShowDuration` in capacitor.config.json is the floor under that — the
 * OS takes the splash down on its own after three seconds no matter what
 * happens in here. This effect is what makes it come down in three hundred
 * milliseconds instead, on the frame the first screen is ready.
 */
function useSplash() {
  useEffect(() => {
    if (!isNative || !hasPlugin("SplashScreen")) return;
    // After paint, not on mount: `hide()` on the mount pass would uncover a
    // tree React has committed but the compositor has not drawn yet — which is
    // the blank frame the splash exists to cover.
    const frame = requestAnimationFrame(() => {
      SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, []);
}

function useLifecycle() {
  useEffect(() => {
    if (!isNative || !hasPlugin("App")) return;

    let handle;

    CapApp.addListener("appStateChange", ({ isActive }) => {
      // What `refetchOnWindowFocus` is waiting for. A WebView's own
      // `visibilitychange` is unreliable across a home-button press on iOS, so
      // the platform event drives it instead.
      focusManager.setFocused(isActive);
      if (isActive) {
        // The OS may have repainted its bars for another app while this one was
        // away; the measurement has to be redone rather than trusted.
        resetSystemBars();
        requestAnimationFrame(syncSystemBars);
      }
    })
      .then((h) => { handle = h; })
      .catch((err) => logger.warn("app.state", err?.message));

    return () => {
      handle?.remove();
      // Hand focus tracking back to the browser's own default, or a later web
      // render would inherit whatever the last native value happened to be.
      focusManager.setFocused(undefined);
    };
  }, []);
}

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * `navigator.onLine` inside a WebView reports whether the WebView has a network
 * interface, not whether the phone can reach anything — it stays true on a
 * plane. The plugin asks the OS, which knows.
 */
function useNativeNetwork() {
  useEffect(() => {
    if (!isNative || !hasPlugin("Network")) return;

    let handle;

    const apply = ({ connected }) => {
      onlineManager.setOnline(connected);
      window.dispatchEvent(new CustomEvent("oqunet:network", { detail: { connected } }));
    };

    Network.getStatus().then(apply).catch((err) => logger.warn("net.status", err?.message));
    Network.addListener("networkStatusChange", apply)
      .then((h) => { handle = h; })
      .catch((err) => logger.warn("net.listen", err?.message));

    return () => {
      handle?.remove();
      onlineManager.setOnline(undefined);
    };
  }, []);
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

/**
 * Marks the document while the on-screen keyboard is up.
 *
 * That is all it does, and the restraint is deliberate. Capacitor is configured
 * with `resize: "native"`, so the platform shrinks the WebView to the space the
 * keyboard leaves — every `position: fixed` bottom bar in the app is already
 * carried up with it, and any padding added here would move them all a second
 * time, by the height of a keyboard that is no longer under them.
 *
 * What the resize does not fix is the tab bar, which ends up wedged against the
 * keys. `.keyboard-open` in index.css hides it, the way every phone app does.
 */
function useKeyboardState() {
  useEffect(() => {
    if (!isNative || !hasPlugin("Keyboard")) return;

    const root = document.documentElement;
    const handles = [];

    // `will` rather than `did`: the class has to land with the keyboard's own
    // animation, not a frame after it has finished sliding up.
    Keyboard.addListener("keyboardWillShow", () => root.classList.add("keyboard-open"))
      .then((h) => handles.push(h)).catch(() => {});
    Keyboard.addListener("keyboardWillHide", () => root.classList.remove("keyboard-open"))
      .then((h) => handles.push(h)).catch(() => {});

    // The accessory bar is the grey strip with "Done" over the iOS keyboard. It
    // covers the top of the keyboard and belongs to a form with several fields
    // to step between; this app's inputs are one to a screen.
    //
    // iOS only, and the guard is not cosmetic: on Android the method rejects
    // with UNIMPLEMENTED, and Capacitor's bridge writes that to console.error
    // on its way out — before this code's own `.catch` ever sees it. Caught or
    // not, it was a red error on every single launch.
    if (isIOS) Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});

    return () => {
      handles.forEach((h) => h.remove());
      root.classList.remove("keyboard-open");
    };
  }, []);
}
