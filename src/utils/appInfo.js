// App-level constants shown on the settings screens.
//
// Kept here rather than read from package.json so the bundle doesn't carry the
// whole manifest, and so the support address has exactly one place to change.

export const APP_NAME = "OquNet";
export const APP_VERSION = "0.1.0";

/** Where "Написать в поддержку" sends mail. Change this to the real inbox. */
export const SUPPORT_EMAIL = "support@oqunet.kz";

/** Terms of Use — served from public/drawable. */
export const TERMS_URL = "/drawable/TermsofUse.docx.pdf";
