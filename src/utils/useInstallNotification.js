import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { isAppInstalled } from "./pwaUtils.js";
import { announceInstall, PENDING_KEY } from "./installNotification.js";
import { safeGet, safeSet } from "./safeStorage.js";
import { logger } from "./logger.js";

// Two different signals, because no single one covers both platforms.
//
// `appinstalled` is Chrome's: it fires in the tab the moment the install
// finishes, while the app is still open and, usually, someone is signed in.
// index.html also records it on `window`, since it can fire before React has
// mounted and the event does not replay.
//
// iOS has no such event at all — "Add to Home Screen" happens inside Safari's
// share sheet and the page is never told. What the page can see is the result:
// a launch from the home-screen icon runs in standalone display mode. So that
// is the second signal, and it is the one that fires on iPhones.
//
// Both are noisy in the same way — `appinstalled` can fire twice, and
// standalone is true on every launch forever after — so neither is trusted to
// be once-only. The keys in installNotification.js are what make this happen
// once, per account, per device.

/** Has this device been added to the home screen, one way or another? */
function hasInstallSignal() {
  return Boolean(window.appInstalled) || Boolean(safeGet(PENDING_KEY)) || isAppInstalled();
}

/**
 * Watches for the app being added to the home screen and announces it.
 *
 * Mounted once, from <App>. Signed out, it only remembers that the install
 * happened — the message needs an account to belong to, and it is sent as soon
 * as someone signs in.
 */
export function useInstallNotification() {
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    let cancelled = false;

    function announce() {
      if (cancelled) return;
      if (!userId) {
        // Nobody to address it to yet. The flag survives the sign-in.
        safeSet(PENDING_KEY, "1");
        return;
      }
      announceInstall(userId).catch((err) =>
        logger.error("install.notify", err?.message, { code: err?.code })
      );
    }

    // Either signal may already have happened: the event fired before React
    // mounted, an earlier visit recorded it while signed out, or this very
    // launch came from the home-screen icon.
    if (hasInstallSignal()) announce();

    window.addEventListener("appinstalled", announce);
    return () => {
      cancelled = true;
      window.removeEventListener("appinstalled", announce);
    };
  }, [userId]);
}
