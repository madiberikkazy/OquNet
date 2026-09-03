/**
 * Sharing a link, and copying one — the OS sheet where there is an OS.
 *
 * Three implementations behind one call, in the order they are preferred:
 *
 *   native    @capacitor/share — the real UIActivityViewController / Android
 *             chooser. This is the only one that can reach WhatsApp, Telegram
 *             and the rest, which on a phone is the entire point of a share
 *             button.
 *   web share `navigator.share`, for an installed PWA and for Android Chrome.
 *   clipboard everywhere else, with the caller told so it can say so — a share
 *             button that appears to do nothing is worse than no share button.
 *
 * The return value says which happened: `"shared"` when a sheet took it,
 * `"copied"` when the link went to the clipboard, `"cancelled"` when the reader
 * dismissed the sheet. Callers only ever need to distinguish `"copied"`, and
 * that is exactly why the distinction is returned rather than logged.
 */

import { Share } from "@capacitor/share";
import { Clipboard } from "@capacitor/clipboard";
import { isNative, hasPlugin } from "./platform.js";
import { logger } from "../utils/logger.js";

/**
 * A cancelled share and a broken share reject identically on every platform,
 * and the cancel is by far the more common of the two. Guessing from the
 * message is the only thing available; guessing wrong only costs a log line.
 */
function looksCancelled(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("abort") ||
    err?.name === "AbortError"
  );
}

/**
 * Put text on the clipboard.
 *
 * The Capacitor plugin rather than `navigator.clipboard` inside the binary:
 * the async clipboard API needs a secure context and a live user gesture, and
 * in a WKWebView it fails often enough that a "copy" button that silently does
 * nothing is a real outcome. Returns whether it worked.
 */
export async function copyText(text) {
  try {
    if (isNative && hasPlugin("Clipboard")) {
      await Clipboard.write({ string: text });
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    logger.warn("share.copy", err?.message);
    return false;
  }
}

/**
 * Hand a link to whatever the platform has.
 *
 * @param {{title?: string, text?: string, url: string, dialogTitle?: string}} payload
 * @returns {Promise<"shared" | "copied" | "cancelled" | "failed">}
 */
export async function shareLink({ title, text, url, dialogTitle }) {
  if (isNative && hasPlugin("Share")) {
    try {
      // `canShare` reports whether the OS has anything to share *with*. It is
      // true on every real phone; the check is here so an emulator with no
      // share targets falls through to the clipboard rather than throwing.
      const { value } = await Share.canShare();
      if (value) {
        await Share.share({ title, text, url, dialogTitle: dialogTitle || title });
        return "shared";
      }
    } catch (err) {
      if (looksCancelled(err)) return "cancelled";
      logger.warn("share.native", err?.message);
      // Fall through: a failed sheet should still leave the reader with a link.
    }
  } else if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      if (looksCancelled(err)) return "cancelled";
      logger.warn("share.web", err?.message);
    }
  }

  return (await copyText(url)) ? "copied" : "failed";
}
