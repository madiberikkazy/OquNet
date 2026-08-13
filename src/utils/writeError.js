import { t } from "./i18n.js";

/**
 * What to show when a write is refused.
 *
 * Three kinds of failure end up here, and only the middle one is interesting:
 *
 *   a SchemaError      names the i18n key for the field it refused, so the
 *                      screen can point at the field rather than at a stack;
 *   permission-denied  is Firestore's own, and it arrives as raw English in the
 *                      middle of a Kazakh screen, which is the one thing worth
 *                      translating. In this project it nearly always means the
 *                      deployed ruleset is older than the build asking it for
 *                      something — a lane added in the app but not yet pushed
 *                      with `firebase deploy --only firestore:rules`. That is
 *                      not a sentence to put in front of a reader, so they get
 *                      "you may not do this" and the caller's logger keeps the
 *                      code, which is what actually names the cause;
 *   anything else      is passed through.
 *
 * It lives here rather than in a screen because four of them need it, and the
 * two copies it replaces had already started to drift.
 */
export function writeError(err) {
  if (err?.errorKey && t[err.errorKey]) return t[err.errorKey];
  if (err?.code === "permission-denied") return t.notAuthorized;
  return err?.message || t.error;
}
