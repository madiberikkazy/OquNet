// Firebase Storage helpers — uploads return a public URL.
//
// Strategy:
//  1. Shrink the picked image first (utils/imageResize.js). Every path below
//     benefits: less to upload where Storage works, and — where it does not —
//     a fallback small enough to live inside a Firestore document, which is
//     what the data-URL below actually becomes.
//  2. If Firebase Storage is configured, attempt the real upload with a
//     30-second timeout.  If it fails for ANY reason (CORS not configured,
//     Storage rules blocking, network error, timeout) we fall back to the
//     data-URL so the rest of the flow always completes.
//  3. The Storage SDK is imported dynamically, inside the upload path. Register,
//     Settings and CreateCommunity are the only screens that can reach it, and
//     none of them upload until the user actually picks a file — so it stays out
//     of the initial bundle. A failed chunk load lands in the same catch as any
//     other upload failure and degrades to the data-URL.
//
// ── The one failure that is NOT silent ───────────────────────────────────────
// The data-URL fallback is stored in a document, and Firestore refuses any
// document over 1,048,487 bytes. An image that cannot be shrunk under the
// budget therefore cannot be saved at all, and pretending otherwise produced
// the bug this comment outlives: the write failed later, somewhere else, as
// "saving failed" with nothing naming the photo as the cause. That case throws
// an ImageTooLargeError here, carrying an i18n key the screen can show.

import { app, isFirebaseConfigured } from "./config.js";
import { assertWithinBudget, IMAGE_SIZES, shrinkImage } from "../utils/imageResize.js";

export { IMAGE_SIZES } from "../utils/imageResize.js";

/**
 * How long to wait for Storage before giving up and inlining the image.
 *
 * A prepared image is at most a few hundred KB, so a real upload finishes in
 * seconds even on a slow phone connection. The old ceiling was thirty seconds,
 * which is only ever reached when Storage cannot work at all — and this project
 * has no Storage bucket provisioned, so that was every single upload: the SDK
 * retried against a bucket that does not exist while the user watched a spinner
 * for half a minute before the fallback quietly rescued them.
 */
const UPLOAD_TIMEOUT_MS = 12_000;
/** Told to the SDK as well, so it stops retrying instead of racing the clock. */
const SDK_RETRY_MS = 10_000;

/**
 * Set once Storage has proved unavailable in this session.
 *
 * Waiting out the timeout on the first upload is unavoidable — nothing else
 * distinguishes "not provisioned" from "slow". Waiting it out again on the
 * second is just cruelty, so the answer is remembered. Deliberately in memory
 * rather than in storage: a reload asks again, which is what makes provisioning
 * a bucket take effect without a code change.
 */
let storageUnavailable = false;

/** Convert a File to a base-64 data-URL synchronously in the browser. */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Upload an image file and return a URL.
 * Falls back to a data-URL if Firebase Storage is unavailable or times out.
 *
 * @param maxDimension the long edge to shrink to — IMAGE_SIZES.avatar for a
 *   profile photo, IMAGE_SIZES.cover (the default) for a book or a community.
 */
export async function uploadImage(file, path, { maxDimension = IMAGE_SIZES.cover } = {}) {
  // Step 1: down to something worth sending, and worth storing.
  const prepared = await shrinkImage(file, { maxDimension });

  // Step 2: if Firebase isn't configured, or Storage has already failed once
  // this session, go straight to the data-URL rather than waiting again.
  if (!isFirebaseConfigured || storageUnavailable) {
    return fileToDataUrl(assertWithinBudget(prepared));
  }

  // Step 3: attempt the real upload, with a ceiling on both the SDK's retries
  // and the wait as a whole.
  let timer;
  try {
    const uploadPromise = (async () => {
      const { getStorage, ref, uploadBytes, getDownloadURL } = await import("firebase/storage");
      // getStorage memoises per app instance, so repeated uploads reuse one.
      const storage = getStorage(app);
      storage.maxUploadRetryTime = SDK_RETRY_MS;
      storage.maxOperationRetryTime = SDK_RETRY_MS;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, prepared);
      return getDownloadURL(storageRef);
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Storage upload timed out after ${UPLOAD_TIMEOUT_MS} ms`)),
        UPLOAD_TIMEOUT_MS
      );
    });

    return await Promise.race([uploadPromise, timeoutPromise]);
  } catch (err) {
    // Log but don't surface to the user — the data-URL keeps the flow working,
    // provided it is small enough to be stored at all.
    console.warn("[OquNet] Firebase Storage upload failed, using data-URL fallback:", err?.message ?? err);
    storageUnavailable = true;
    return fileToDataUrl(assertWithinBudget(prepared));
  } finally {
    clearTimeout(timer);
  }
}
