/**
 * Web Push — the half of notifications that works when the app is closed.
 *
 * ── What already existed, and what was missing ──────────────────────────────
 *
 * The app has had a `push` handler in public/sw.js and a `notificationclick`
 * handler beside it for a long time. Both are correct. Nothing ever reached
 * them, because two pieces were absent: nobody subscribed the browser to a
 * push service, and nothing on a server ever sent a message. Notifications
 * therefore only appeared while the app was open, which is exactly when a
 * notification is least needed — a reader who is looking at the app can see
 * the thing that happened.
 *
 * This module is those two pieces.
 *
 * ── Why Web Push rather than FCM, on the web ────────────────────────────────
 *
 * FCM would mean the Firebase Messaging SDK in the client bundle and a second
 * service worker file (firebase-messaging-sw.js) alongside the one this app
 * already ships. Web Push is a browser API: the client cost is zero bytes, the
 * service worker already handles the event, and this server already holds the
 * admin credential it needs to know who to send to. Safari 16.4+ supports it
 * for installed PWAs, which is how most of this app is used on the web.
 *
 * It cannot reach the iOS and Android store builds — a WebView has no
 * `PushManager` — so those are served by fcm.js, and notify.js feeds both.
 *
 * ── The flow ────────────────────────────────────────────────────────────────
 *
 * 1. The app asks the browser for a subscription — an endpoint URL at the
 *    browser vendor's push service, plus two keys the payload is encrypted to.
 * 2. It POSTs that to `/push/subscribe` with a Firebase ID token. This server
 *    verifies the token, so a subscription can only ever be filed against the
 *    account that actually holds the session; the client does not get to say
 *    whose it is.
 * 3. New unread notifications reach `pushToUser` below through the Firestore
 *    trigger in index.js. Each is encrypted to every subscription its recipient
 *    has registered and handed to the push service; the device wakes the
 *    service worker, and the service worker draws the notification.
 *
 * ── Why the fan-out is not in the app ───────────────────────────────────────
 *
 * Notifications are written by the app, straight into Firestore, by whichever
 * reader caused one. That client cannot send the push: it does not have the
 * VAPID private key, and it must not — anybody holding it can send a
 * notification to any subscriber of this app. So something trusted has to
 * react to the collection, which is what the trigger in index.js is.
 *
 * ── Configuration ───────────────────────────────────────────────────────────
 *
 * Generate a key pair once:
 *
 *   npx web-push generate-vapid-keys
 *
 * The public half goes to the app as VITE_VAPID_PUBLIC_KEY, the private half
 * stays here as VAPID_PRIVATE_KEY. With either unset this module does nothing
 * at all — the routes answer 503 and the watcher never starts — which is the
 * correct behaviour for a deployment that has not opted in, and is why nothing
 * here throws at import time.
 */

import crypto from "node:crypto";
import webpush from "web-push";
import { db } from "./config.js";
import { callerUid } from "./auth.js";

const {
  VAPID_PUBLIC_KEY = "",
  VAPID_PRIVATE_KEY = "",
  // The `mailto:` the push service contacts if this application starts
  // misbehaving. Required by the VAPID spec; a real inbox, not a placeholder.
  VAPID_SUBJECT = "mailto:support@oqunet.app",
} = process.env;

export const pushReady = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushReady) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const SUBS = "pushSubscriptions";

/**
 * One document per device, at a deterministic id.
 *
 * The id is a hash of the endpoint rather than a random one, and that is what
 * makes re-subscribing idempotent: a browser hands back the same endpoint for
 * the same installation, so a reader who enables notifications twice, or opens
 * the app on Monday and again on Friday, overwrites one row instead of
 * accumulating duplicates that would each deliver the same notification.
 *
 * Hashed rather than stored raw because an endpoint URL is long, contains
 * characters Firestore ids may not, and is a bearer capability in its own
 * right — anybody holding it can push to that device.
 */
function subscriptionId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 40);
}

/** Reject anything that is not a well-formed PushSubscription. */
function validSubscription(sub) {
  return Boolean(
    sub &&
      typeof sub.endpoint === "string" &&
      /^https:\/\//.test(sub.endpoint) &&
      sub.endpoint.length < 1000 &&
      sub.keys &&
      typeof sub.keys.p256dh === "string" &&
      typeof sub.keys.auth === "string"
  );
}

/**
 * Mount `/push/subscribe` and `/push/unsubscribe`.
 *
 * `db` and `admin` are passed in rather than imported so that this module has
 * no opinion about how Firebase was initialised — server.js owns that, and the
 * emulator test drives the same app object.
 */
export function mountPushRoutes(app) {
  app.post("/push/subscribe", async (req, res) => {
    if (!pushReady) return res.status(503).json({ error: "push-not-configured" });

    const uid = await callerUid(req);
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const sub = req.body?.subscription;
    if (!validSubscription(sub)) return res.status(400).json({ error: "bad-subscription" });

    try {
      await db.collection(SUBS).doc(subscriptionId(sub.endpoint)).set(
        {
          userId: uid,
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          // Which browser, roughly — enough to tell a reader's phone from
          // their laptop on the settings screen, and nothing more.
          userAgent: String(req.get("user-agent") || "").slice(0, 200),
          updatedAt: Date.now(),
        },
        { merge: true }
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("push: subscribe failed", err);
      res.status(500).json({ error: "store-failed" });
    }
  });

  app.post("/push/unsubscribe", async (req, res) => {
    const uid = await callerUid(req);
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      return res.status(400).json({ error: "bad-endpoint" });
    }

    try {
      const ref = db.collection(SUBS).doc(subscriptionId(endpoint));
      const snap = await ref.get();
      // Only the owner may remove it. Without this check, knowing an endpoint
      // — which is not a secret from the device it belongs to — would be
      // enough to silence somebody else's notifications.
      if (snap.exists && snap.data()?.userId === uid) await ref.delete();
      res.json({ ok: true });
    } catch (err) {
      console.error("push: unsubscribe failed", err);
      res.status(500).json({ error: "delete-failed" });
    }
  });
}

/**
 * Send one notification to every device a reader has registered.
 *
 * Returns the number of pushes the service accepted. Dead subscriptions are
 * deleted as they are discovered: a 404 or 410 from a push service is that
 * service telling us the endpoint is permanently gone — the browser was
 * uninstalled, the data cleared, the subscription rotated — and keeping it
 * costs a failed request on every future notification.
 */
export async function pushToUser(userId, payload) {
  if (!pushReady || !userId) return 0;

  const snap = await db.collection(SUBS).where("userId", "==", userId).get();
  if (snap.empty) return 0;

  const body = JSON.stringify(payload);
  let sent = 0;

  await Promise.all(
    snap.docs.map(async (doc) => {
      const d = doc.data();
      try {
        await webpush.sendNotification(
          { endpoint: d.endpoint, keys: d.keys },
          body,
          // Time to live at the push service. A day: a phone that has been off
          // overnight should still get the notification, and one that has been
          // off for a week should not be greeted by a stack of stale ones.
          { TTL: 86_400 }
        );
        sent += 1;
      } catch (err) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          await doc.ref.delete().catch(() => {});
        } else {
          console.error("push: send failed", { code, message: err?.message });
        }
      }
    })
  );

  return sent;
}
