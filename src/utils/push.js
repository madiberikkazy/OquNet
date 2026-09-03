/**
 * The app's one push switch.
 *
 * Two transports, one API. Which one is in play is decided here, once, by the
 * platform — and nowhere else. `AuthContext` calls `syncSubscription()` on
 * launch and `NotificationSettings` calls `enablePush()` from the toggle;
 * neither has ever needed to know how a notification reaches the phone, and
 * adding a second way of reaching it should not be the thing that teaches them.
 *
 *   native   ../native/push.js — APNs / FCM through the OS. The store builds.
 *   web      ./webPush.js — VAPID Web Push through the service worker. A
 *            browser tab, and the installed PWA on Safari 16.4+ and on Chrome.
 *
 * Both halves stay real. This is not a migration: the PWA is still shipped,
 * still installable, and still gets notifications the way it always did.
 *
 * Every function below has the same contract in both:
 *   enablePush()        → { ok, reason } where reason ∈ unsupported|denied|failed
 *   disablePush()       → { ok }
 *   isPushEnabled()     → boolean
 *   isPushSupported()   → boolean, synchronous — the settings screen draws or
 *                         hides the toggle from it before anything is awaited
 *   syncSubscription()  → void, quiet, never prompts
 */

import { isNative } from "../native/platform.js";
import * as nativePush from "../native/push.js";
import * as webPush from "./webPush.js";

const channel = isNative ? nativePush : webPush;

export const isPushSupported = isNative
  ? nativePush.isNativePushSupported
  : webPush.isWebPushSupported;

export const enablePush = channel.enablePush;
export const disablePush = channel.disablePush;
export const isPushEnabled = channel.isPushEnabled;
export const syncSubscription = channel.syncSubscription;

/**
 * Clearing the shade is native-only — a browser owns its own notifications and
 * offers no way to retract them. A no-op on web, so the notifications screen
 * calls it unconditionally rather than asking first.
 */
export const clearDelivered = isNative ? nativePush.clearDelivered : async () => {};
