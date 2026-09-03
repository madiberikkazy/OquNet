/**
 * Firebase Cloud Messaging — the transport that reaches the store builds.
 *
 * ── Why this exists beside webpush.js ───────────────────────────────────────
 *
 * webpush.js speaks Web Push: the browser hands out a subscription, this server
 * encrypts to it, and the app's service worker draws the notification. That is
 * the right and only mechanism for a browser tab and for the installed PWA, and
 * it is unavailable inside the Capacitor binaries — a WKWebView and an Android
 * WebView have no `PushManager` and no service worker doing this job.
 *
 * A native app registers a *token* with APNs or FCM instead, and the OS draws
 * the notification without the app running at all. Same idea, different wire.
 * So the two transports live side by side, both fed by the Firestore trigger in
 * index.js, and a reader signed in on a laptop and a phone is reached on both.
 *
 * ── Why FCM needs no configuration of its own ───────────────────────────────
 *
 * Web Push needs a VAPID key pair, which is why push.js can be switched off by
 * leaving one unset. FCM does not: it authenticates with the same service
 * account the function already runs as. Inside Cloud Functions that credential
 * is always present — the function *is* the project — so there is nothing to
 * configure and nothing that can be left half-set.
 *
 * What *is* configured elsewhere is the receiving end — google-services.json in
 * the Android app, GoogleService-Info.plist plus an APNs key for iOS. Without
 * those a device never gets a token, never registers, and this module simply
 * finds nobody to send to.
 */

import crypto from "node:crypto";
import { db, messaging } from "./config.js";
import { callerUid } from "./auth.js";

/** One document per device. Mirrors `pushSubscriptions` for the web half. */
const DEVICES = "pushDevices";

/**
 * A deterministic id, hashed from the token — the same trick push.js uses on
 * the endpoint, and for the same reason. FCM hands back the same token for the
 * same install, so re-registering overwrites one row rather than accumulating
 * duplicates that would each deliver the same notification. Hashed because a
 * raw token is long, and is a bearer capability: whoever holds it can push to
 * that device.
 */
function deviceId(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 40);
}

/** Cheap shape check. A real token is a long opaque string; nothing else is. */
function validToken(token) {
  return typeof token === "string" && token.length >= 32 && token.length <= 4096;
}

const PLATFORMS = new Set(["ios", "android"]);

/** Mount `/push/fcm/subscribe` and `/push/fcm/unsubscribe`. */
export function mountFcmRoutes(app) {
  app.post("/push/fcm/subscribe", async (req, res) => {
    const uid = await callerUid(req);
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const { token, platform } = req.body || {};
    if (!validToken(token)) return res.status(400).json({ error: "bad-token" });
    if (!PLATFORMS.has(platform)) return res.status(400).json({ error: "bad-platform" });

    try {
      await db.collection(DEVICES).doc(deviceId(token)).set(
        { userId: uid, token, platform, updatedAt: Date.now() },
        { merge: true }
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("fcm: subscribe failed", err);
      res.status(500).json({ error: "store-failed" });
    }
  });

  app.post("/push/fcm/unsubscribe", async (req, res) => {
    const uid = await callerUid(req);
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const { token } = req.body || {};
    if (!validToken(token)) return res.status(400).json({ error: "bad-token" });

    try {
      const ref = db.collection(DEVICES).doc(deviceId(token));
      const snap = await ref.get();
      // Only the owner may remove it. A token is not a secret from the device
      // that holds it, so without this check knowing one would be enough to
      // silence somebody else's notifications.
      if (snap.exists && snap.data()?.userId === uid) await ref.delete();
      res.json({ ok: true });
    } catch (err) {
      console.error("fcm: unsubscribe failed", err);
      res.status(500).json({ error: "delete-failed" });
    }
  });
}

/**
 * Errors that mean "this token is permanently gone".
 *
 * The app was uninstalled, the data cleared, the token rotated. Keeping such a
 * row costs a failed send on every future notification and, worse, hides real
 * failures in the noise — so they are deleted the moment FCM says so. Anything
 * else (a network blip, a quota) is logged and the row is kept.
 */
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Send one notification to every native device a reader has registered.
 *
 * Returns how many the service accepted.
 *
 * ── Why the message carries both halves ─────────────────────────────────────
 *
 * `notification` is what makes the OS draw something while the app is closed or
 * backgrounded — without it a message is data-only and, on iOS especially, may
 * never be shown at all. `data` is what the app reads when the notification is
 * tapped: `route` is the in-app path to open, and src/native/push.js refuses
 * anything that is not a path inside the app.
 *
 * Every `data` value must be a string. FCM rejects the whole message otherwise,
 * and a number that slipped in would fail the send for every device at once.
 */
export async function pushToDevices(userId, payload) {
  if (!userId) return 0;

  const snap = await db.collection(DEVICES).where("userId", "==", userId).get();
  if (snap.empty) return 0;

  const docs = snap.docs;
  const tokens = docs.map((d) => d.data().token).filter(validToken);
  if (!tokens.length) return 0;

  const message = {
    notification: {
      title: String(payload.title || "OquNet").slice(0, 120),
      body: String(payload.body || "").slice(0, 300),
    },
    data: {
      route: String(payload.route || "/notifications"),
      type: String(payload.type || ""),
      notificationId: String(payload.notificationId || ""),
    },
    android: {
      // The notification survives a phone that has been off overnight, and is
      // dropped rather than delivered stale after a day — the same TTL the web
      // half uses, so both transports behave alike.
      ttl: 86_400_000,
      notification: {
        // Must match the channel the app creates in src/native/push.js and the
        // `default_notification_channel_id` in AndroidManifest.xml. A message
        // naming a channel that does not exist is dropped by Android silently,
        // which is the commonest way for push to look broken when every other
        // piece is right.
        channelId: "oqunet-default",
        // Collapses re-sends of the same notification into one row in the shade
        // instead of stacking duplicates.
        tag: `oqunet-${payload.notificationId || "general"}`,
        // The white silhouette in the status bar, and the colour Android tints
        // it with. Named without the @drawable/ prefix, which is what FCM wants.
        icon: "ic_stat_notify",
        color: "#032081",
      },
      priority: "high",
    },
    apns: {
      headers: { "apns-expiration": String(Math.floor(Date.now() / 1000) + 86_400) },
      payload: { aps: { sound: "default", "content-available": 1 } },
    },
  };

  let response;
  try {
    response = await messaging.sendEachForMulticast({ ...message, tokens });
  } catch (err) {
    console.error("fcm: send failed", err?.message);
    return 0;
  }

  // `sendEachForMulticast` answers per token, in the order they were sent, so
  // a failure can be traced back to the exact row that caused it.
  await Promise.all(
    response.responses.map(async (result, i) => {
      if (result.success) return;
      const code = result.error?.code;
      if (DEAD_TOKEN_CODES.has(code)) {
        await docs[i].ref.delete().catch(() => {});
        return;
      }
      console.error("fcm: delivery failed", { code, message: result.error?.message });
    })
  );

  return response.successCount;
}
