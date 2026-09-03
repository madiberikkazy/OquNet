/**
 * The handful of things every function here shares.
 */

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

/**
 * Where these functions run.
 *
 * It is not a free choice: a Firestore trigger has to live in a region
 * compatible with the database it watches, and this project's Firestore is in
 * `eur3` — the European multi-region, set in firebase.json. `europe-west1` is
 * the trigger region for it.
 *
 * It is also the right answer for latency. The readers are in Kazakhstan;
 * `us-central1`, the default, would send every registration round trip across
 * the Atlantic and back for no reason.
 *
 * If a deploy ever fails with a region complaint, this constant is the one
 * thing to change — and firebase.json's `firestore.location` is what it has to
 * agree with.
 */
export const REGION = "europe-west1";

// One Admin app for the whole codebase. Cloud Functions reuses a warm instance
// across invocations, so initialising at module scope means most calls skip it
// entirely — and initialising it twice throws.
initializeApp();

export const db = getFirestore();
export const messaging = getMessaging();

/**
 * Origins allowed to call the registration endpoints.
 *
 * The three the app actually runs as:
 *   https://oqunet.app     the deployed site and the installed PWA
 *   https://localhost      the Android WebView's own scheme
 *   capacitor://localhost  the iOS WebView's
 *
 * A wildcard would work too — these endpoints verify a Firebase ID token and
 * trust nothing about the caller's origin — but an allowlist means a stray
 * page on another domain cannot quietly make requests as somebody's browser.
 */
export const ALLOWED_ORIGINS = new Set([
  "https://oqunet.app",
  "https://www.oqunet.app",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:5173",
]);
