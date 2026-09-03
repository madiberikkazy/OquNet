/**
 * Google sign-in inside the store builds.
 *
 * ── The thing that was broken ────────────────────────────────────────────────
 *
 * `signInWithPopup` needs a popup. A WebView has no popups and no second
 * window, so on both platforms the call opens nothing and hangs, or throws
 * something unhelpful — a sign-in path that simply does not exist in the
 * shipped app. `signInWithRedirect` is no better: it navigates the one WebView
 * away to accounts.google.com and the return trip lands on a scheme Google
 * will not redirect to.
 *
 * The native flow is a different shape. The OS runs the account picker — the
 * one that already knows which Google accounts are on the phone — and hands
 * back a credential. Nothing navigates, and the app never leaves the screen.
 *
 * ── Why the credential is signed in twice, in a sense ────────────────────────
 *
 * `skipNativeAuth: true` in capacitor.config.json stops the plugin from
 * starting a Firebase session of its own on the native side. It returns the
 * Google ID token and nothing else. That token is then turned into an ordinary
 * `GoogleAuthProvider` credential and signed into the *JS* SDK — the same
 * `auth` object every other screen in this app reads from, the same
 * `onAuthStateChanged` that AuthContext is listening to, the same ID token
 * server/push.js verifies.
 *
 * The alternative — letting the plugin hold the session — would mean two
 * independent auth states in one app, and the first symptom is a native layer
 * that is signed in under a web layer that is signed out. There is one session
 * here, and it is the JS SDK's.
 *
 * ── What has to exist outside the code ──────────────────────────────────────
 *
 * Android  google-services.json in android/app/, and the app's SHA-1 and
 *          SHA-256 fingerprints registered on the Firebase Android app — debug
 *          *and* release, or sign-in works on your machine and fails in the
 *          store.
 * iOS      GoogleService-Info.plist in ios/App/App/, and its REVERSED_CLIENT_ID
 *          added as a URL scheme on the Xcode target.
 */

import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { isNative, hasPlugin } from "./platform.js";

/** Is the native picker available, or should the caller use the popup? */
export const hasNativeGoogleAuth = isNative && hasPlugin("FirebaseAuthentication");

/**
 * Run the OS account picker and return a Firebase credential.
 *
 * Returns null when the reader dismissed the picker — a cancellation is not an
 * error, and the caller should leave the screen exactly as it was.
 *
 * @returns {Promise<import("firebase/auth").OAuthCredential | null>}
 */
export async function googleCredential() {
  const { GoogleAuthProvider } = await import("firebase/auth");

  const result = await FirebaseAuthentication.signInWithGoogle();
  const idToken = result?.credential?.idToken;
  if (!idToken) return null;

  // The access token is optional — it is only needed to call Google's own APIs,
  // which this app does not — but passing it through costs nothing and keeps
  // the credential complete.
  return GoogleAuthProvider.credential(idToken, result?.credential?.accessToken);
}

/**
 * Clear the native side's idea of who is signed in.
 *
 * Even with `skipNativeAuth`, the plugin caches the last Google account so the
 * picker can skip straight past it. After a deliberate sign-out that is wrong:
 * the next tap on "continue with Google" would silently return the account the
 * reader just left, with no picker and no way to choose another. Best effort —
 * a failure here must not stop the JS SDK's sign-out, which is the one that
 * actually ends the session.
 */
export async function signOutNativeGoogle() {
  if (!hasNativeGoogleAuth) return;
  await FirebaseAuthentication.signOut().catch(() => {});
}
