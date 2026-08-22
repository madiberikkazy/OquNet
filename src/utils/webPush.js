// The client half of Web Push. The server half is server/push.js, which is
// where the whole design is written down — read that first.
//
// In one paragraph: the browser hands out a *subscription* (an endpoint at its
// vendor's push service plus two keys), the app files that with the server
// against the reader's account, and the server encrypts notifications to it.
// The service worker's `push` handler in public/sw.js then draws them, whether
// or not the app is open. That last clause is the whole point — everything the
// app already had only worked while it was running.
//
// ── Two switches, and they are not the same switch ──────────────────────────
//
// `Notification.permission` is the browser's. A push subscription is this
// app's. Permission can be granted with no subscription (the usual state
// before a reader turns notifications on), and a subscription can outlive the
// app's own idea of whether it wants one. `syncSubscription` exists to
// reconcile the two on launch.
//
// ── Configuration ───────────────────────────────────────────────────────────
//
// VITE_VAPID_PUBLIC_KEY and VITE_PUSH_SERVER. With either missing this module
// reports unsupported and does nothing, so a build with no push server behaves
// exactly as the app did before.

import { safeGet, safeSet, safeRemove } from "./safeStorage.js";
import { logger } from "./logger.js";
import { track } from "./analytics.js";

const VAPID_PUBLIC_KEY = import.meta.env?.VITE_VAPID_PUBLIC_KEY || "";
const PUSH_SERVER = (import.meta.env?.VITE_PUSH_SERVER || "").replace(/\/+$/, "");

// Whether the reader has asked for push, as opposed to whether the browser
// currently holds a subscription. Kept locally so that a launch can tell
// "never turned it on" apart from "turned it on, and the browser has since
// rotated or dropped the subscription" — only the second should silently
// re-subscribe.
const WANTED_KEY = "oqunet:push:wanted";

/**
 * Is push actually available here?
 *
 * `PushManager` is the capability test that matters. On iOS it is present only
 * for an app installed to the home screen — Safari in a tab does not have it —
 * so this correctly answers false for most of the iOS visits this app gets,
 * and the settings screen can say so rather than offering a switch that
 * cannot work.
 */
export function isWebPushSupported() {
  return Boolean(
    VAPID_PUBLIC_KEY &&
      PUSH_SERVER &&
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
  );
}

/** VAPID keys are base64url; `applicationServerKey` wants raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * The caller's Firebase ID token.
 *
 * Taken from the live auth session rather than passed in, because the server
 * verifies it and a stale one is a 401. `getIdToken()` refreshes it if it is
 * close to expiry, which is exactly the behaviour wanted on a launch after the
 * app has been closed for a day.
 *
 * Imported dynamically: this module is reached from the settings screen and
 * from a launch-time reconciliation, and neither should pull the Auth SDK into
 * a chunk that does not already have it.
 */
async function idToken() {
  const { auth } = await import("../firebase/config.js");
  const user = auth?.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

async function postToServer(path, body) {
  const token = await idToken();
  if (!token) throw new Error("not-signed-in");

  const res = await fetch(`${PUSH_SERVER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json().catch(() => ({}));
}

/**
 * Turn push on.
 *
 * Must be called from a user gesture: `Notification.requestPermission()` is
 * only accepted during one on Safari, which includes the installed iOS PWA
 * this app largely runs as. The settings toggle is that gesture.
 *
 * Resolves to `{ ok, reason }` rather than throwing, because every failure
 * here is something the settings screen has to be able to say out loud —
 * "your browser cannot", "you said no", "the server is unreachable" are three
 * different sentences.
 */
export async function enablePush() {
  if (!isWebPushSupported()) return { ok: false, reason: "unsupported" };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      track("push.enable.denied");
      return { ok: false, reason: "denied" };
    }

    const registration = await navigator.serviceWorker.ready;

    // Reuse the existing subscription if there is one. Calling `subscribe`
    // again with the same key returns it anyway, but an existing subscription
    // made with a *different* VAPID key throws — which happens exactly once,
    // to whoever is holding a subscription when the keys are rotated, so it
    // has to be recovered from rather than reported.
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const current = subscription.options?.applicationServerKey;
      const wanted = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      if (!current || !sameKey(new Uint8Array(current), wanted)) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser: a push may not be silent, it
        // has to result in a visible notification. The service worker always
        // calls `showNotification`, so this holds.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await postToServer("/push/subscribe", { subscription: subscription.toJSON() });
    safeSet(WANTED_KEY, "1");
    track("push.enable");
    return { ok: true, reason: null };
  } catch (err) {
    logger.error("push.enable", err?.message);
    return { ok: false, reason: "failed" };
  }
}

function sameKey(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Turn push off.
 *
 * The server row goes first. If the order were reversed and the network failed
 * in between, the device would be unsubscribed locally while the server kept
 * pushing to a dead endpoint — which it would only discover on the next
 * notification. This way a failure leaves both halves on, which is a state the
 * reader can retry out of.
 */
export async function disablePush() {
  safeRemove(WANTED_KEY);
  if (!isWebPushSupported()) return { ok: true };

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ok: true };

    await postToServer("/push/unsubscribe", { endpoint: subscription.endpoint }).catch((err) => {
      // Best effort. A subscription the server still holds but the browser has
      // dropped is deleted on the first failed send — see pushToUser.
      logger.warn("push.disable", "server unsubscribe failed", { err: err?.message });
    });
    await subscription.unsubscribe();
    track("push.disable");
    return { ok: true };
  } catch (err) {
    logger.error("push.disable", err?.message);
    return { ok: false };
  }
}

/** Is push on for this device right now? */
export async function isPushEnabled() {
  if (!isWebPushSupported() || Notification.permission !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Reconcile browser state with the server's, once per launch.
 *
 * Two things drift, and neither produces an error anybody sees:
 *
 *   · A push service may rotate a subscription — the endpoint changes and the
 *     old one stops working. The browser does this silently, and the first
 *     symptom is notifications quietly stopping.
 *   · The server row is not permanent either: `pushToUser` deletes a
 *     subscription the push service reports as gone.
 *
 * Re-POSTing the current subscription on every launch fixes both. It is one
 * small request, it is idempotent — the row's id is derived from the endpoint,
 * so this overwrites rather than duplicates — and it only happens for a reader
 * who has actually turned push on.
 *
 * Deliberately quiet: no permission is requested, nothing is subscribed that
 * was not already, and every failure is swallowed. A launch is not a moment to
 * ask anybody anything.
 */
export async function syncSubscription() {
  if (!isWebPushSupported()) return;
  if (safeGet(WANTED_KEY) !== "1") return;
  if (Notification.permission !== "granted") return;

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    // Permission is granted and the reader wants push, but the browser has no
    // subscription — it was dropped or rotated away. Re-subscribing needs no
    // gesture, because there is no prompt to show.
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await postToServer("/push/subscribe", { subscription: subscription.toJSON() });
  } catch (err) {
    logger.debug("push.sync", "reconcile failed", { err: err?.message });
  }
}
