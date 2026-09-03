/**
 * Push, the native way.
 *
 * ── Why this exists beside utils/webPush.js rather than replacing it ─────────
 *
 * Web Push is a browser API and a WebView is not a browser: `PushManager` is
 * absent in a WKWebView and in an Android WebView, so every line of
 * utils/webPush.js correctly reports "unsupported" inside the binary and does
 * nothing. That is the right answer for a *web* build — an installed PWA on
 * Safari 16.4+ still uses it, and that build has not gone anywhere. It is a
 * dead end for the store builds, which is what this file is for.
 *
 * The two are the same shape on purpose. utils/push.js picks between them once,
 * so AuthContext and the settings screen call `enablePush()` and never learn
 * which transport carried it.
 *
 *   web     browser → push service → service worker → notification
 *   native  APNs / FCM → the OS → notification, no WebView involved
 *
 * ── What the server has to do ───────────────────────────────────────────────
 *
 * The same thing it already does for Web Push, addressed differently. Today
 * server/push.js watches new unread notifications and encrypts each one to
 * every VAPID subscription the recipient registered. Native devices register a
 * *token* instead, at `/push/fcm/subscribe`, and are sent to through the
 * Firebase Admin SDK the server already holds a credential for:
 *
 *     admin.messaging().sendEachForMulticast({ tokens, notification, data })
 *
 * The fan-out, the recipient lookup and the dead-registration cleanup are all
 * the shape they already are — only the wire changes. `data.route` is the one
 * field this file needs back: it is what a tapped notification opens.
 *
 * ── What has to exist outside the code ──────────────────────────────────────
 *
 * Android  google-services.json in android/app/, from the Firebase console's
 *          Android app registered under this bundle id.
 * iOS      GoogleService-Info.plist in ios/App/App/, an APNs key uploaded to
 *          Firebase, and the Push Notifications + Background Modes
 *          capabilities on the Xcode target.
 *
 * Without them `register()` fails at launch, `registrationError` fires, and the
 * settings toggle reports itself unavailable — which is the correct behaviour
 * for a build that has not been configured yet, and is what happens right now.
 */

import { PushNotifications } from "@capacitor/push-notifications";
import { isNative, isAndroid, hasPlugin, platform } from "./platform.js";
import { safeGet, safeSet, safeRemove } from "../utils/safeStorage.js";
import { logger } from "../utils/logger.js";
import { track } from "../utils/analytics.js";
import { t } from "../utils/i18n.js";

const PUSH_SERVER = (import.meta.env?.VITE_PUSH_SERVER || "").replace(/\/+$/, "");

/**
 * Whether the reader asked for push, as opposed to whether a token exists.
 * The same distinction utils/webPush.js draws, and for the same reason: only a
 * device that was deliberately turned on should silently re-register when the
 * OS rotates its token.
 */
const WANTED_KEY = "oqunet:push:wanted";
/** The last token filed with the server, so a rotation can be recognised. */
const TOKEN_KEY = "oqunet:push:token";

export function isNativePushSupported() {
  return Boolean(isNative && hasPlugin("PushNotifications") && PUSH_SERVER);
}

/**
 * The Android notification channel.
 *
 * From Android 8 every notification belongs to a channel, and one that names no
 * existing channel is dropped by the system without a word — the commonest way
 * for push to look broken when everything else is right. The id here matches
 * `default_notification_channel_id` in AndroidManifest.xml and the `channelId`
 * the server puts on each message, so all three agree.
 *
 * Created before registering rather than at launch: it only matters once
 * notifications are actually turned on, and creating it is idempotent — calling
 * it again updates the name, which is what makes the channel follow the app's
 * language after the reader changes it.
 *
 * The importance and the sound are the reader's to change from here on. Android
 * deliberately does not let an app override a channel a person has adjusted,
 * which is the point of channels.
 */
async function ensureChannel() {
  if (!isAndroid || !hasPlugin("PushNotifications")) return;
  await PushNotifications.createChannel({
    id: "oqunet-default",
    name: t.notifications,
    description: t.pushNotificationsHint,
    importance: 4, // heads-up: it appears briefly over whatever is on screen
    visibility: 1, // shown on the lock screen, contents and all
    vibration: true,
  }).catch((err) => logger.warn("push.channel", err?.message));
}

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
 * Wait for the token the OS issues in response to `register()`.
 *
 * `register()` resolves as soon as the request is *made*; the token arrives
 * later, on a listener, and on a cold device that round trip to APNs or FCM can
 * take a couple of seconds. So the two are stitched back into one promise —
 * with a ceiling, because a device with no network never answers at all and the
 * settings toggle cannot spin forever.
 */
function registerForToken({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handles = [];

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handles.forEach((h) => h?.remove?.());
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error("push registration timed out")),
      timeoutMs
    );

    PushNotifications.addListener("registration", ({ value }) => finish(resolve, value))
      .then((h) => handles.push(h));
    PushNotifications.addListener("registrationError", (err) =>
      finish(reject, new Error(err?.error || "registration failed"))
    ).then((h) => handles.push(h));

    PushNotifications.register().catch((err) => finish(reject, err));
  });
}

/**
 * Turn push on. Same contract as the web one: resolves to `{ ok, reason }`,
 * never throws, and every reason is a different sentence on the settings
 * screen.
 */
export async function enablePush() {
  if (!isNativePushSupported()) return { ok: false, reason: "unsupported" };

  try {
    // `checkPermissions` first: on Android 13+ and on iOS the *request* can only
    // be made once, and asking again after a refusal resolves immediately with
    // "denied" rather than showing anything. Distinguishing the two is what
    // lets the screen say "turn it on in Settings" instead of "try again".
    let status = await PushNotifications.checkPermissions();
    if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
      status = await PushNotifications.requestPermissions();
    }
    if (status.receive !== "granted") {
      track("push.enable.denied");
      return { ok: false, reason: "denied" };
    }

    await ensureChannel();
    const token = await registerForToken();
    await postToServer("/push/fcm/subscribe", { token, platform });

    safeSet(WANTED_KEY, "1");
    safeSet(TOKEN_KEY, token);
    track("push.enable");
    return { ok: true, reason: null };
  } catch (err) {
    logger.error("push.enable.native", err?.message);
    return { ok: false, reason: "failed" };
  }
}

/**
 * Turn push off.
 *
 * The server row goes first, for the reason utils/webPush.js gives: a device
 * that unregistered locally while the server kept its token is a notification
 * sent into nothing, and the server only finds out on the next send. Failing
 * with both halves still on is a state the reader can retry out of.
 */
export async function disablePush() {
  const token = safeGet(TOKEN_KEY);
  safeRemove(WANTED_KEY);
  if (!isNativePushSupported()) return { ok: true };

  try {
    if (token) {
      await postToServer("/push/fcm/unsubscribe", { token }).catch((err) =>
        logger.warn("push.disable.native", "server unsubscribe failed", { err: err?.message })
      );
    }
    safeRemove(TOKEN_KEY);
    // Drops the OS-level registration, so the platform stops delivering even if
    // a stale token survives somewhere on the server.
    await PushNotifications.unregister().catch(() => {});
    track("push.disable");
    return { ok: true };
  } catch (err) {
    logger.error("push.disable.native", err?.message);
    return { ok: false };
  }
}

/** Is push on for this device right now? */
export async function isPushEnabled() {
  if (!isNativePushSupported()) return false;
  try {
    const status = await PushNotifications.checkPermissions();
    return status.receive === "granted" && safeGet(WANTED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Reconcile with the server once per launch — the native twin of
 * `syncSubscription` in utils/webPush.js, and it exists for the same drift.
 *
 * FCM and APNs both rotate tokens without telling anybody: a reinstall, a
 * restore from backup, or simply time. The first symptom is notifications
 * stopping. Re-registering on every launch fixes it, costs one small request,
 * and is idempotent — the server keys the row on the token.
 *
 * Quiet by construction: no permission is requested and no prompt can appear,
 * because it returns early unless permission is *already* granted.
 */
export async function syncSubscription() {
  if (!isNativePushSupported()) return;
  if (safeGet(WANTED_KEY) !== "1") return;

  try {
    const status = await PushNotifications.checkPermissions();
    if (status.receive !== "granted") return;

    await ensureChannel();
    const token = await registerForToken();
    await postToServer("/push/fcm/subscribe", { token, platform });
    safeSet(TOKEN_KEY, token);
  } catch (err) {
    logger.debug("push.sync.native", "reconcile failed", { err: err?.message });
  }
}

/**
 * What happens when a notification is tapped.
 *
 * The OS drew it while the app was closed or backgrounded, so this is the only
 * moment the app learns anything happened. `data.route` is the in-app path the
 * server put on the message; anything else falls back to the notifications
 * list, which is never wrong — it is where the thing that was announced lives.
 *
 * Returns an unsubscribe function. Called from bridge.jsx, which owns the
 * router and so is the only thing that can act on it.
 */
export function onNotificationTapped(handler) {
  if (!isNative || !hasPlugin("PushNotifications")) return () => {};

  let handle;
  PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
    const route = notification?.data?.route;
    // A route out of a push payload is untrusted input, exactly like a deep
    // link: it is only ever used if it names a path inside this app.
    handler(typeof route === "string" && route.startsWith("/") ? route : "/notifications");
  })
    .then((h) => { handle = h; })
    .catch((err) => logger.warn("push.tap", err?.message));

  return () => handle?.remove();
}

/**
 * Clear the badge and the shade.
 *
 * A reader who has just read the notifications list should not still have six
 * of them stacked in the pull-down. Called from the notifications screen.
 */
export async function clearDelivered() {
  if (!isNative || !hasPlugin("PushNotifications")) return;
  await PushNotifications.removeAllDeliveredNotifications().catch(() => {});
}
