/**
 * Push delivery for OquNet.
 *
 * ── Why this is a Cloud Function and not a server ───────────────────────────
 *
 * It used to be a long-lived Express process that held a Firestore listener
 * open and pushed whatever arrived. That design cannot survive the hosting it
 * was on: a free instance sleeps after fifteen minutes of quiet, the listener
 * dies with it, and the cursor that stops a restart re-pushing the whole
 * database also means everything written during the sleep is skipped for good.
 * Notifications would have arrived only while somebody happened to be keeping
 * the process awake.
 *
 * A notification is an *event*, so it is delivered by an event trigger. There
 * is nothing to keep alive, nothing to wake up, no cursor, and no window during
 * which a notification can be missed — Firestore invokes `onNotificationCreated`
 * below, and retries it if it fails.
 *
 * ── The two exports ─────────────────────────────────────────────────────────
 *
 *   api                     the registration endpoints. A device tells us its
 *                           push token or Web Push subscription; this is what
 *                           VITE_PUSH_SERVER points at.
 *   onNotificationCreated   the delivery itself, one invocation per new
 *                           notification document.
 *
 * The phone-verification webhook stays in server/ — that one really is
 * request/response, and a sleeping instance only makes it slow, not wrong.
 */

import express from "express";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { REGION, ALLOWED_ORIGINS } from "./config.js";
import { mountPushRoutes, pushReady, pushToUser } from "./webpush.js";
import { mountFcmRoutes, pushToDevices } from "./fcm.js";

// ── The registration API ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "16kb" }));

/**
 * CORS, by allowlist.
 *
 * The endpoints verify a Firebase ID token and trust nothing about the origin,
 * so a wildcard would be safe enough — but naming the three origins the app
 * actually runs as means a stray page elsewhere cannot quietly make requests
 * from somebody's browser session.
 */
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Max-Age", "3600");
  }
  // The browser's preflight. Answered here rather than by each route, and
  // answered even for an origin we do not allow — the refusal is the missing
  // Allow-Origin header, not a hung request.
  if (req.method === "OPTIONS") return res.status(204).send("");
  return next();
});

mountPushRoutes(app);  // /push/subscribe,     /push/unsubscribe      — web
mountFcmRoutes(app);   // /push/fcm/subscribe, /push/fcm/unsubscribe  — native

app.get("/health", (_req, res) => {
  // Two transports, reported separately: "push is broken" is almost always one
  // of them being unconfigured, and one flag cannot say which. FCM is always
  // ready inside a function — the credential is the project's own.
  res.json({ ok: true, push: { web: pushReady, fcm: true } });
});

export const api = onRequest(
  {
    region: REGION,
    // The endpoints are called before anything else can happen on a fresh
    // install, and a cold start there is the reader waiting on a settings
    // toggle. One warm instance is pennies and removes that wait.
    minInstances: 0,
    maxInstances: 10,
    // Auth is the ID token in the header, checked per route. The function
    // itself has to be publicly reachable for that header to arrive at all.
    invoker: "public",
    cors: false,
  },
  app
);

// ── Delivery ────────────────────────────────────────────────────────────────

/**
 * Where a tap should land, for one notification document.
 *
 * The detail screen rather than the list: the notification announced one thing,
 * and that is the thing the reader is trying to get to. Both transports carry
 * it — `data.url` for the service worker, `data.route` for src/native/push.js —
 * and both refuse anything that is not a path inside the app.
 */
function routeFor(id) {
  return `/notifications/${id}`;
}

export const onNotificationCreated = onDocumentCreated(
  {
    document: "notifications/{notificationId}",
    region: REGION,
    // A notification nobody can be told about is not worth retrying forever;
    // the document is in Firestore either way and the app shows it on next
    // open. Failures are logged and dropped rather than looping.
    retry: false,
    maxInstances: 20,
  },
  async (event) => {
    const n = event.data?.data();
    if (!n) return;

    // Only additions reach this trigger at all, so there is no "was it just
    // marked read" case to filter — but a notification created already-read
    // (a backfill, a migration) should still stay silent.
    if (!n.recipientId || n.read === true) return;

    const id = event.params.notificationId;
    const title = String(n.title || "OquNet").slice(0, 120);
    const body = String(n.body || "").slice(0, 300);
    const route = routeFor(id);

    // Both transports, in parallel, and neither can take the other down: a
    // reader with a laptop and a phone must not lose the phone notification
    // because their browser subscription had expired.
    const results = await Promise.allSettled([
      pushReady
        ? pushToUser(n.recipientId, {
            title,
            body,
            tag: `oqunet-${id}`,
            // The service worker's `notificationclick` handler reads
            // `data.url`, focuses an open window if there is one, and
            // navigates it here.
            data: { url: route, type: n.type || "" },
          })
        : Promise.resolve(0),
      pushToDevices(n.recipientId, {
        title,
        body,
        route,
        type: n.type || "",
        notificationId: id,
      }),
    ]);

    const [web, native] = results;
    if (web.status === "rejected") logger.error("web push failed", web.reason);
    if (native.status === "rejected") logger.error("fcm failed", native.reason);

    logger.info("notification delivered", {
      notificationId: id,
      web: web.status === "fulfilled" ? web.value : "failed",
      native: native.status === "fulfilled" ? native.value : "failed",
    });
  }
);
