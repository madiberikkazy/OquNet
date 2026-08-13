/**
 * Proving a phone number, by SMS.
 *
 * The number on a profile is not a detail — it is how a stranger finds the
 * person holding their book. Two screens show it to somebody who is about to
 * walk across a city to meet its owner (PickupBook, ReturnBook), and until now
 * it was whatever text someone typed into a field. This module is the step that
 * makes it mean something: a six-digit code sent to the number, typed back in.
 *
 * ── Why Firebase's own phone provider, and not an SMS API ────────────────────
 * Because it needs no server. An SMS gateway's key cannot live in a PWA where
 * anyone can read it, so any other route means a backend this project does not
 * have. Firebase does the sending from the client and — the part that actually
 * matters — writes the proven number into the caller's **ID token**, where the
 * security rules can read it. That is what turns "verified" from a boolean the
 * client sets about itself into something the server checks (see
 * `phoneChangeAllowed` in firestore.rules).
 *
 * ── The two shapes of the same act ───────────────────────────────────────────
 * A first number is *linked* to the account; a replacement *updates* it. Both
 * end at the same place — the account carries exactly one proven number — so
 * the difference is settled here rather than by the screen asking for it.
 *
 * ── The token has to be refreshed ────────────────────────────────────────────
 * Linking a number does not retroactively change the token already in memory.
 * Writing the profile before forcing a refresh is a write the rules refuse, for
 * a number that was genuinely just proven. `getIdToken(true)` between the two
 * is not an optimisation; it is the reason this works.
 */

import {
  PhoneAuthProvider,
  RecaptchaVerifier,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePhoneNumber,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "./config.js";
import { updateUser } from "./firestore.js";
import { getMockSession } from "./auth.js";
import { isE164, toE164 } from "../utils/validators.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/** How long a code is worth typing. Firebase expires its own at five minutes. */
export const PHONE_CODE_TTL_MS = 5 * 60 * 1000;

/** Digits in the SMS. Firebase's codes are six; the mock's match so the UI is one shape. */
export const PHONE_CODE_LENGTH = 6;

// ── reCAPTCHA ────────────────────────────────────────────────────────────────
//
// Firebase will not send an SMS from a browser without proof that a person
// asked for it — otherwise a script could spend the project's SMS budget in a
// loop. The invisible widget resolves on its own for ordinary traffic and only
// shows a challenge when Google is unconvinced.
//
// It is kept in a module-level slot rather than rebuilt per render, because
// rendering a second widget into the same element throws, and a screen that
// remounts (a re-render, a language switch, going back and forward) would do
// exactly that.

let verifier = null;
let verifierContainerId = null;

function getVerifier(containerId) {
  if (verifier && verifierContainerId === containerId) return verifier;
  clearPhoneVerifier();
  verifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
  verifierContainerId = containerId;
  return verifier;
}

/** Tear the widget down — on unmount, and after a failure that invalidates it. */
export function clearPhoneVerifier() {
  try { verifier?.clear(); } catch { /* already gone */ }
  verifier = null;
  verifierContainerId = null;
}

// ── Mock mode ────────────────────────────────────────────────────────────────
//
// No Firebase, no SMS, no reCAPTCHA. The code is generated locally and handed
// back to the caller so the screen can show it during development — the same
// bargain the rest of mock mode makes, where the app is fully usable and
// nothing is actually proven.

let mockChallenge = null;

function newCode() {
  return String(Math.floor(Math.random() * 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, "0");
}

/** The message for a Firebase auth error, in the user's language. */
export function phoneAuthError(err) {
  switch (err?.code) {
    case "auth/invalid-phone-number":        return t.phoneInvalidError;
    case "auth/missing-phone-number":        return t.phoneRequiredError;
    case "auth/invalid-verification-code":   return t.phoneCodeWrong;
    case "auth/missing-verification-code":   return t.phoneCodeMissing;
    case "auth/code-expired":                return t.phoneCodeExpired;
    case "auth/session-expired":             return t.phoneCodeExpired;
    // The number is already proven by somebody else's account. Said plainly:
    // one number, one member, or the handover contact means nothing.
    case "auth/credential-already-in-use":   return t.phoneTakenError;
    case "auth/account-exists-with-different-credential": return t.phoneTakenError;
    case "auth/provider-already-linked":     return t.phoneAlreadyLinked;
    case "auth/requires-recent-login":       return t.phoneNeedsPassword;
    case "auth/too-many-requests":           return t.phoneTooManyRequests;
    case "auth/quota-exceeded":              return t.phoneTooManyRequests;
    case "auth/captcha-check-failed":        return t.phoneCaptchaFailed;
    case "auth/operation-not-allowed":       return t.phoneNotEnabled;
    case "auth/wrong-password":
    case "auth/invalid-credential":          return t.wrongPassword;
    default:                                 return err?.message || t.error;
  }
}

/** True once this member has a number they have proven. */
export function hasVerifiedPhone(user) {
  return Boolean(user?.phone) && Boolean(user?.phoneVerifiedAt);
}

/**
 * Send the code.
 *
 * @param phone        whatever the person typed; normalised to E.164 here
 * @param containerId  the id of an empty element for the invisible reCAPTCHA
 * @returns `{ phone, verificationId, devCode }` — `devCode` only in mock mode
 * @throws with a translated message
 */
export async function startPhoneVerification({ phone, containerId = "recaptcha-holder" } = {}) {
  const e164 = toE164(phone);
  if (!e164 || !isE164(e164)) throw new Error(t.phoneInvalidError);

  if (!isFirebaseConfigured) {
    const code = newCode();
    mockChallenge = { phone: e164, code, at: Date.now() };
    logger.info("phoneAuth.mock", `verification code for ${e164}: ${code}`);
    return { phone: e164, verificationId: "mock", devCode: code };
  }

  const user = auth?.currentUser;
  if (!user) throw new Error(t.sessionExpired);

  try {
    const provider = new PhoneAuthProvider(auth);
    const verificationId = await provider.verifyPhoneNumber(e164, getVerifier(containerId));
    return { phone: e164, verificationId, devCode: null };
  } catch (err) {
    // A spent widget cannot be reused, and Firebase will not say so twice.
    clearPhoneVerifier();
    logger.error("phoneAuth.send", err?.message, { code: err?.code });
    throw new Error(phoneAuthError(err));
  }
}

/**
 * Type the code back in, and — if it is the right one — attach the number to
 * the account and write it onto the profile.
 *
 * `password` is only consulted when Firebase refuses a replacement on a session
 * that has been sitting for a while: changing the number people reach you on is
 * exactly the kind of act an unlocked phone left on a table should not be
 * enough for.
 *
 * @returns `{ phone, phoneVerifiedAt }` — the patch that landed on the profile
 */
export async function confirmPhoneVerification({
  phone, verificationId, code, password = null,
} = {}) {
  const e164 = toE164(phone);
  const digits = String(code || "").replace(/\D/g, "");
  if (!e164) throw new Error(t.phoneInvalidError);
  if (digits.length !== PHONE_CODE_LENGTH) throw new Error(t.phoneCodeMissing);

  const patch = { phone: e164, phoneVerifiedAt: Date.now() };

  if (!isFirebaseConfigured) {
    const session = getMockSession();
    if (!session?.uid) throw new Error(t.sessionExpired);
    if (!mockChallenge || mockChallenge.phone !== e164) throw new Error(t.phoneCodeExpired);
    if (Date.now() - mockChallenge.at > PHONE_CODE_TTL_MS) throw new Error(t.phoneCodeExpired);
    if (mockChallenge.code !== digits) throw new Error(t.phoneCodeWrong);
    // One number, one member is not enforced here. Firebase Auth guarantees it
    // on a linked credential — mock mode has no auth service to guarantee
    // anything, which is the same bargain it already makes about passwords and
    // security rules.
    mockChallenge = null;
    await updateUser(session.uid, patch);
    return patch;
  }

  const user = auth?.currentUser;
  if (!user) throw new Error(t.sessionExpired);

  const credential = PhoneAuthProvider.credential(verificationId, digits);
  const hasPhoneProvider = user.providerData.some((p) => p.providerId === "phone");

  try {
    if (hasPhoneProvider) {
      await replacePhoneNumber(user, credential, password);
    } else {
      await linkWithCredential(user, credential);
    }
  } catch (err) {
    logger.error("phoneAuth.confirm", err?.message, { code: err?.code });
    throw new Error(phoneAuthError(err));
  } finally {
    // The code is spent either way, and so is the widget that sent it.
    clearPhoneVerifier();
  }

  // The claim the security rules read lives in the token, and the token in
  // memory predates the number. Refresh before the write, or the rules refuse a
  // number that was proven one line ago.
  try {
    await user.getIdToken(true);
  } catch (err) {
    logger.warn("phoneAuth.refreshToken", err?.message, { code: err?.code });
  }

  await updateUser(user.uid, patch);
  return patch;
}

/**
 * Swap one proven number for another. Kept apart from the link path because it
 * is the one that can be refused for staleness, and the password prompt that
 * answers that has no business being in the happy path.
 */
async function replacePhoneNumber(user, credential, password) {
  try {
    await updatePhoneNumber(user, credential);
  } catch (err) {
    if (err?.code !== "auth/requires-recent-login") throw err;
    if (!password) throw err;                      // the screen asks, then retries
    const usesPassword = user.providerData.some((p) => p.providerId === "password");
    if (!usesPassword) throw err;                  // Google accounts: sign in again
    await reauthenticateWithCredential(
      user, EmailAuthProvider.credential(user.email, password)
    );
    await updatePhoneNumber(user, credential);
  }
}

