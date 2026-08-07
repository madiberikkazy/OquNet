// App-level constants shown on the settings screens.
//
// Kept here rather than read from package.json so the bundle doesn't carry the
// whole manifest, and so the support address has exactly one place to change.

export const APP_NAME = "OquNet";
export const APP_VERSION = "0.1.0";

/**
 * Support runs through Telegram, not email — it is where the community already
 * is, and it works the same on a phone with no mail client configured.
 *
 * `?direct` is carried through from the channel's own link; Telegram ignores
 * query parameters it doesn't recognise, so the link opens the channel either
 * way — in the installed app if there is one, in the web client otherwise.
 */
export const SUPPORT_TELEGRAM = "@oqunetapp";
export const SUPPORT_TELEGRAM_URL = "https://t.me/oqunetapp?direct";

/** Terms of Use — served from public/drawable. */
export const TERMS_URL = "/drawable/TermsofUse.docx.pdf";
