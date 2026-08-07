// Auth helpers — email + password + Google.
// Uses Firebase Authentication when configured. Falls back to a localStorage-based
// mock so the UI is fully usable during development without a backend.

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  GoogleAuthProvider,
  signInWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  deleteUser,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  verifyBeforeUpdateEmail,
  EmailAuthProvider,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "./config.js";
import {
  createUserDoc,
  claimUsername,
  releaseUsername,
  getUsernameEntry,
  getUserByEmail,
  getUserByNickname,
  getUserById,
  isNicknameTaken,
  updateUser,
  deleteUserDoc,
} from "./firestore.js";
import { isEmail, isNickname, normalizeEmail, normalizeNickname, LIMITS } from "../utils/validators.js";
import { safeGet, safeSet, safeRemove } from "../utils/safeStorage.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

const STORE_KEY = "oqunet:auth";

function readMock() {
  const raw = safeGet(STORE_KEY, null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function writeMock(value) {
  if (value) safeSet(STORE_KEY, JSON.stringify(value));
  else safeRemove(STORE_KEY);
}

/**
 * Step 1 of registration — create the Firebase Auth account and send the
 * verification email. We don't write the Firestore profile yet because the
 * user still hasn't picked a nickname; the profile is created in
 * `finalizeRegistration()` once they've verified their email and filled out
 * the rest of the form.
 *
 * If the auth user already exists with the same password (i.e. the user is
 * resuming a half-finished registration), we sign them in instead of
 * surfacing `email-already-in-use` — but only if no Firestore profile has
 * been written for that uid yet. A completed profile means the email is
 * genuinely taken.
 *
 * Note there is no pre-flight "is this email registered?" lookup: `users` is
 * readable only to signed-in callers, and this runs before anyone is signed in.
 * Firebase Auth answers the same question itself via `email-already-in-use`,
 * which the resume path below already handles — and unlike a Firestore query it
 * is rate-limited, so it is not an account-enumeration oracle.
 *
 * Returns `{ uid, verified, mock }`.
 *   mock=true when running without Firebase — verification is skipped.
 */
export async function startEmailRegistration({ email, password }) {
  const cleanEmail = normalizeEmail(email);
  if (!isEmail(cleanEmail)) throw new Error(t.emailInvalid);
  if (typeof password !== "string" ||
      password.length < LIMITS.PASSWORD_MIN ||
      password.length > LIMITS.PASSWORD_MAX) {
    throw new Error(t.passwordWeak);
  }

  if (!isFirebaseConfigured) {
    // Mock mode only: without Firebase Auth there is nothing that knows the
    // email is taken, so the local store has to be asked.
    if (await getUserByEmail(cleanEmail)) throw new Error(t.emailAlreadyInUse);
    // Mock mode: pretend we sent a verification email; auto-pass.
    return { uid: "mock-" + cleanEmail, verified: true, mock: true };
  }

  let uid;
  let sendErr = null; // surface this to the UI so the user knows what went wrong
  try {
    const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
    uid = cred.user.uid;
    try {
      await sendEmailVerification(cred.user);
    } catch (verErr) {
      sendErr = verErr;
      logger.error("auth.sendVerification", verErr?.message, { code: verErr?.code });
    }
  } catch (err) {
    // Allow resume: if the auth account exists but no profile was ever written,
    // sign in to it with the supplied password.
    if (err?.code === "auth/email-already-in-use") {
      try {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        uid = cred.user.uid;
        const profile = await getUserById(uid);
        if (profile) {
          // Profile already exists — registration was completed before. Stop.
          throw new Error(t.emailAlreadyInUse);
        }
        if (!cred.user.emailVerified) {
          try { await sendEmailVerification(cred.user); }
          catch (verErr) {
            sendErr = verErr;
            logger.error("auth.sendVerification.resume", verErr?.message, { code: verErr?.code });
          }
        }
      } catch (signInErr) {
        if (signInErr?.message === t.emailAlreadyInUse) throw signInErr;
        if (signInErr?.code === "auth/wrong-password" || signInErr?.code === "auth/invalid-credential") {
          throw new Error(t.emailAlreadyInUse);
        }
        throw signInErr;
      }
    } else {
      throw err;
    }
  }

  const fbUser = auth?.currentUser || null;
  return {
    uid,
    verified: !!fbUser?.emailVerified,
    mock: false,
    // null when the verification email was accepted by Firebase, otherwise
    // a short user-friendly diagnostic the UI can show on the gate screen.
    sendError: sendErr ? humanizeSendError(sendErr) : null,
  };
}

function humanizeSendError(err) {
  const code = err?.code || "";
  if (code === "auth/too-many-requests") return t.loginErrorTooMany;
  if (code === "auth/operation-not-allowed") return t.emailPasswordDisabled;
  if (code === "auth/network-request-failed") return t.offlineWarning;
  if (code === "auth/invalid-recipient-email") return t.emailInvalid;
  return err?.message || t.resetPasswordError;
}

/**
 * Re-fetch the current Firebase user and return whether their email is now verified.
 * Called by the "I clicked the link" button on the verification gate screen.
 */
export async function refreshEmailVerified() {
  if (!isFirebaseConfigured) return true;
  const u = auth?.currentUser;
  if (!u) return false;
  try {
    await u.reload();
    return !!auth.currentUser?.emailVerified;
  } catch (err) {
    logger.warn("auth.refreshVerified", err?.message, { code: err?.code });
    return false;
  }
}

/** Resend the verification email to the currently-pending auth user. */
export async function resendVerificationEmail() {
  if (!isFirebaseConfigured) return;
  const u = auth?.currentUser;
  if (!u) throw new Error(t.sessionExpired);
  if (u.emailVerified) return;
  try {
    await sendEmailVerification(u);
  } catch (err) {
    logger.error("auth.resendVerification", err?.message, { code: err?.code });
    throw new Error(humanizeSendError(err));
  }
}

/**
 * Send a Firebase password-reset email. Always resolves successfully (we
 * intentionally don't reveal whether the email is registered, so we can't
 * be used as an account-enumeration oracle).
 */
export async function sendPasswordReset(email) {
  const cleanEmail = normalizeEmail(email);
  if (!isEmail(cleanEmail)) throw new Error(t.emailInvalid);
  if (!isFirebaseConfigured) {
    // Mock mode: nothing to send. Pretend it worked so the UX is consistent.
    return;
  }
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
  } catch (err) {
    // Treat "user-not-found" as a non-error to avoid leaking which emails exist.
    if (err?.code === "auth/user-not-found") return;
    logger.warn("auth.passwordReset", err?.message, { code: err?.code });
    throw err;
  }
}

/**
 * Step 2 of registration — write the Firestore profile for an already-created
 * (and verified) auth user. Requires `uid` returned from startEmailRegistration().
 */
export async function finalizeRegistration({
  uid, email, password, nickname, firstName, lastName, phone, address,
  notificationsEnabled, photoURL,
}) {
  const cleanEmail = normalizeEmail(email);
  const cleanNick = normalizeNickname(nickname);

  if (!uid) throw new Error(t.sessionExpired);
  if (!isEmail(cleanEmail)) throw new Error(t.emailInvalid);
  if (!isNickname(cleanNick)) throw new Error(t.registerErrNickname);

  // Verification must have completed for real Firebase users.
  if (isFirebaseConfigured) {
    const u = auth?.currentUser;
    if (!u) throw new Error(t.sessionExpired);
    // Reload one final time to defend against a stale flag.
    try { await u.reload(); } catch { /* network blips don't block — flag check below is authoritative */ }
    if (!auth.currentUser?.emailVerified) {
      throw new Error(t.emailNotVerified);
    }
  }

  // Nickname uniqueness — checked at finalize time too, not just at the picker.
  if (await isNicknameTaken(cleanNick, uid)) throw new Error(t.nicknameTaken);

  const profile = {
    id: uid,
    email: cleanEmail,
    nickname: cleanNick,
    firstName: (firstName || "").toString().trim().slice(0, 60),
    lastName: (lastName || "").toString().trim().slice(0, 60),
    phone: (phone || "").toString().trim().slice(0, 20),
    // Shown to whoever comes to collect a book from this user, so it travels
    // with the profile rather than being asked for at every handoff.
    address: (address || "").toString().trim().slice(0, LIMITS.ADDRESS_MAX),
    notificationsEnabled: Boolean(notificationsEnabled),
    photoURL: photoURL || "",
    role: "user",
    communityId: null,
    // No `createdAt`: createUserDoc stamps it server-side.
  };
  if (!isFirebaseConfigured) {
    // Mock-only: keep the password for nickname-login support.
    profile.password = password;
  }
  await createUserDoc(profile);
  // The public index is what makes signing in with a nickname possible at all,
  // so it is written as part of creating the profile rather than lazily.
  await claimUsername(cleanNick, { uid, email: cleanEmail });
  writeMock({ uid });
  return profile;
}

/**
 * Cancel a half-finished registration: deletes the auth user we created in
 * startEmailRegistration() so the email becomes available again if the user
 * gives up before verifying.
 */
export async function cancelPendingRegistration() {
  if (!isFirebaseConfigured) return;
  const u = auth?.currentUser;
  if (!u || u.emailVerified) return;
  try { await deleteUser(u); }
  catch (err) { logger.warn("auth.cancelPending", err?.message, { code: err?.code }); }
}

/**
 * Sign in with either an email or a nickname, plus password.
 *
 * An email goes straight to Firebase Auth — there is nothing to look up, and
 * asking Firestore first would only be a signed-out read of `users` that the
 * security rules (rightly) refuse. A nickname is resolved through the public
 * `usernames` index, which exists precisely because this one lookup has to
 * happen before there is anybody to authorise. The profile is then read back
 * *after* sign-in, when the caller is allowed to read it.
 */
export async function signInWithIdentifier({ identifier, password }) {
  const idRaw = (identifier || "").toString().trim();
  if (!idRaw) throw new Error(t.registerErrEmail);
  if (typeof password !== "string" || password.length === 0) {
    throw new Error(t.loginErrorGeneric);
  }
  const looksLikeEmail = idRaw.includes("@");

  if (!isFirebaseConfigured) {
    // Mock mode has no auth service, so the local store is still the oracle.
    const user = looksLikeEmail
      ? await getUserByEmail(normalizeEmail(idRaw))
      : await getUserByNickname(normalizeNickname(idRaw));
    if (!user) throw new Error(t.loginErrorUserNotFound);
    if (user.password !== password) throw new Error(t.loginErrorWrongPassword);
    writeMock({ uid: user.id });
    return user;
  }

  let email;
  if (looksLikeEmail) {
    email = normalizeEmail(idRaw);
  } else {
    const entry = await getUsernameEntry(normalizeNickname(idRaw));
    if (!entry?.email) throw new Error(t.loginErrorUserNotFound);
    email = entry.email;
  }

  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profile = await getUserById(cred.user.uid);
  if (!profile) throw new Error(t.loginErrorUserNotFound);
  writeMock({ uid: profile.id });
  return profile;
}

/**
 * Start an email change.
 *
 * The new address is not written anywhere yet. `verifyBeforeUpdateEmail` sends
 * a confirmation link to it and Firebase moves the account only once that link
 * is opened — which is the whole point: an unverified address typed into a form
 * is a way to lock yourself out of your own account, or to point somebody
 * else's inbox at a password reset. Re-authentication comes first for the same
 * reason it does on delete: an unlocked phone should not be enough.
 *
 * The Firestore profile is deliberately NOT touched here. It catches up in
 * `syncEmailFromAuth`, after the change is real; the security rules refuse any
 * profile email that doesn't match the account's own token.
 *
 * Returns the normalized address the link went to.
 */
export async function requestEmailChange({ newEmail, password }) {
  const cleanEmail = normalizeEmail(newEmail);
  if (!isEmail(cleanEmail)) throw new Error(t.emailInvalid);

  if (!isFirebaseConfigured) {
    // Mock mode has no mail and no auth service, so the check that matters —
    // is this address free? — is the only one that can be enforced, and the
    // change applies immediately.
    const session = readMock();
    const uid = session?.uid;
    if (!uid) throw new Error(t.sessionExpired);
    const profile = await getUserById(uid);
    if (profile?.email === cleanEmail) throw new Error(t.emailSameAsCurrent);
    if (profile?.password && password !== profile.password) throw new Error(t.wrongPassword);
    const taken = await getUserByEmail(cleanEmail);
    if (taken && taken.id !== uid) throw new Error(t.emailAlreadyInUse);
    await updateUser(uid, { email: cleanEmail });
    if (profile?.nickname) await reindexUsername(profile.nickname, uid, cleanEmail);
    return cleanEmail;
  }

  const fbUser = auth?.currentUser;
  if (!fbUser) throw new Error(t.sessionExpired);
  if (normalizeEmail(fbUser.email) === cleanEmail) throw new Error(t.emailSameAsCurrent);

  try {
    if (!password) throw new Error(t.deleteAccountNeedPassword);
    const credential = EmailAuthProvider.credential(fbUser.email, password);
    await reauthenticateWithCredential(fbUser, credential);
  } catch (err) {
    const code = err?.code || "";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      throw new Error(t.wrongPassword);
    }
    if (code === "auth/too-many-requests") throw new Error(t.loginErrorTooMany);
    throw err;
  }

  try {
    await verifyBeforeUpdateEmail(fbUser, cleanEmail);
  } catch (err) {
    const code = err?.code || "";
    if (code === "auth/email-already-in-use") throw new Error(t.emailAlreadyInUse);
    if (code === "auth/invalid-email") throw new Error(t.emailInvalid);
    if (code === "auth/too-many-requests") throw new Error(t.loginErrorTooMany);
    logger.error("auth.requestEmailChange", err?.message, { code });
    throw new Error(humanizeSendError(err));
  }
  return cleanEmail;
}

/** Move a nickname's index entry to a new email. The rules allow create and
 *  delete on `usernames` but never update, so a change is delete-then-create. */
async function reindexUsername(nickname, uid, email) {
  await releaseUsername(nickname).catch(() => {});
  await claimUsername(nickname, { uid, email }).catch((err) => {
    logger.warn("auth.reindexUsername", err?.message, { nickname });
  });
}

/**
 * Bring the profile in line after an email change has actually landed.
 *
 * Called on every session load. Firebase Auth is the source of truth for the
 * address, so when the account says one thing and the profile says another, the
 * profile is stale — the user confirmed the change from their new inbox, which
 * happens outside this app entirely and possibly on another device.
 *
 * Two things have to move: the profile document, and the public nickname index,
 * which is what login-by-nickname resolves an email through. Leaving the index
 * behind is what would quietly break signing in by @nickname.
 *
 * Returns the corrected profile, or the one it was given when nothing changed.
 */
export async function syncEmailFromAuth(profile) {
  if (!isFirebaseConfigured || !profile?.id) return profile;
  const accountEmail = normalizeEmail(auth?.currentUser?.email || "");
  if (!accountEmail || accountEmail === normalizeEmail(profile.email || "")) return profile;

  try {
    await updateUser(profile.id, { email: accountEmail });
    if (profile.nickname) await reindexUsername(profile.nickname, profile.id, accountEmail);
    logger.info("auth.syncEmail", "profile email caught up with the account");
    return { ...profile, email: accountEmail };
  } catch (err) {
    // Not fatal: the account is fine, the profile is merely behind, and the
    // next load tries again.
    logger.warn("auth.syncEmail", err?.message, { code: err?.code });
    return profile;
  }
}

/**
 * Delete the signed-in account, permanently.
 *
 * Three things have to happen, in this order, and the order is the whole point:
 *
 *  1. Re-authenticate. Firebase refuses `deleteUser` on a stale session, and
 *     re-auth is also what stops someone deleting an account from a phone that
 *     was left unlocked. Password accounts re-auth with the password; a Google
 *     account has no password to ask for, so it re-auths through the popup.
 *  2. Scrub the profile and give the nickname back. The `users` document is NOT
 *     deleted — the rules deny that, and rightly so: books, borrowings and
 *     notifications belonging to other people still reference this id, and a
 *     missing document would leave those screens with a dangling pointer. What
 *     goes is everything personal, plus the public nickname index entry, which
 *     is what actually frees the name for someone else.
 *  3. Delete the auth user. This is the irreversible step and it goes last,
 *     because after it the caller can no longer write to Firestore at all.
 *
 * Throws with a translated message on a wrong password.
 */
export async function deleteAccount({ password } = {}) {
  if (!isFirebaseConfigured) {
    // Mock mode: no rules, no auth service — just drop the row.
    const session = readMock();
    const uid = session?.uid;
    if (!uid) throw new Error(t.sessionExpired);
    const profile = await getUserById(uid);
    // The screen asks for the password in mock mode too, so honour it — an
    // ignored confirmation field trains people to ignore the real one.
    if (profile?.password && password !== profile.password) {
      throw new Error(t.wrongPassword);
    }
    if (profile?.nickname) {
      await releaseUsername(profile.nickname).catch(() => {});
    }
    await deleteUserDoc(uid);
    writeMock(null);
    return;
  }

  const fbUser = auth?.currentUser;
  if (!fbUser) throw new Error(t.sessionExpired);

  const usesPassword = fbUser.providerData.some((p) => p.providerId === "password");
  try {
    if (usesPassword) {
      if (!password) throw new Error(t.deleteAccountNeedPassword);
      const credential = EmailAuthProvider.credential(fbUser.email, password);
      await reauthenticateWithCredential(fbUser, credential);
    } else {
      await reauthenticateWithPopup(fbUser, new GoogleAuthProvider());
    }
  } catch (err) {
    const code = err?.code || "";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      throw new Error(t.wrongPassword);
    }
    if (code === "auth/too-many-requests") throw new Error(t.loginErrorTooMany);
    throw err;
  }

  const uid = fbUser.uid;
  const profile = await getUserById(uid).catch(() => null);

  if (profile?.nickname) {
    await releaseUsername(profile.nickname).catch((err) => {
      logger.warn("auth.deleteAccount.releaseUsername", err?.message, { code: err?.code });
    });
  }

  await updateUser(uid, {
    firstName: "",
    lastName: "",
    // The nickname column still has to hold a string, and it has to be unique
    // enough that a later reader can tell this was a deleted account rather
    // than an empty profile. The index entry is already gone, so the name
    // itself is free again.
    nickname: `deleted_${uid.slice(0, 8)}`,
    phone: "",
    address: "",
    photoURL: "",
    savedBookIds: [],
    // Leaving the community is part of leaving entirely — the rules allow a
    // member to null their own membership, and `role: "user"` is always allowed.
    communityId: null,
    role: "user",
    deleted: true,
    deletedAt: Date.now(),
  }).catch((err) => {
    logger.error("auth.deleteAccount.scrub", err?.message, { code: err?.code });
    throw err;
  });

  await deleteUser(fbUser);
  writeMock(null);
}

export async function signOut() {
  if (isFirebaseConfigured) {
    try { await fbSignOut(auth); }
    catch (err) { logger.warn("auth.signOut", err?.message, { code: err?.code }); }
  }
  writeMock(null);
}

export function getMockSession() {
  return readMock();
}

/**
 * Sign in (or register) with Google via popup.
 * - Returning users: loads existing profile from Firestore.
 * - New users: auto-creates a profile with data from the Google account.
 *   Nickname is derived from the email prefix (unique suffix added if needed).
 *   The user can update nickname/photo in Settings afterwards.
 */
export async function signInWithGoogle() {
  if (!isFirebaseConfigured) {
    throw new Error("Google sign-in requires Firebase. Configure .env first.");
  }
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  const fbUser = cred.user;

  // Check if this Google account already has a profile
  let profile = await getUserById(fbUser.uid);

  if (!profile) {
    // New user — build a profile from Google account data
    const nameParts = (fbUser.displayName || "").split(" ");
    const firstName = nameParts[0] || "";
    const lastName  = nameParts.slice(1).join(" ") || "";

    // Derive a unique nickname from the email prefix
    const base = (fbUser.email || "user").split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    let nickname = base || "user";
    let suffix = 1;
    while (await isNicknameTaken(nickname, fbUser.uid)) {
      nickname = base + suffix++;
    }

    profile = {
      id: fbUser.uid,
      email: (fbUser.email || "").toLowerCase(),
      nickname,
      firstName,
      lastName,
      photoURL: fbUser.photoURL || "",
      notificationsEnabled: true,
      role: "user",
      communityId: null,
      // No `createdAt`: createUserDoc stamps it server-side.
    };
    await createUserDoc(profile);
    await claimUsername(nickname, { uid: fbUser.uid, email: profile.email });
  }

  writeMock({ uid: fbUser.uid });
  return profile;
}
