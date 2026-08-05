// Firebase Storage helpers — uploads return a public URL.
//
// Strategy:
//  1. Always convert the file to a data-URL first (instant, works offline).
//  2. If Firebase Storage is configured, attempt the real upload with a
//     30-second timeout.  If it fails for ANY reason (CORS not configured,
//     Storage rules blocking, network error, timeout) we silently fall back
//     to the data-URL so the rest of the flow always completes.
//  3. The Storage SDK is imported dynamically, inside the upload path. Register,
//     Settings and CreateCommunity are the only screens that can reach it, and
//     none of them upload until the user actually picks a file — so it stays out
//     of the initial bundle. A failed chunk load lands in the same catch as any
//     other upload failure and degrades to the data-URL.

import { app, isFirebaseConfigured } from "./config.js";

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
 */
export async function uploadImage(file, path) {
  // Step 1: generate local data-URL as instant fallback.
  const dataUrl = await fileToDataUrl(file);

  // Step 2: if Firebase isn't configured at all, use data-URL directly.
  if (!isFirebaseConfigured) return dataUrl;

  // Step 3: attempt Firebase Storage upload with a 30-second hard timeout.
  try {
    const uploadPromise = (async () => {
      const { getStorage, ref, uploadBytes, getDownloadURL } = await import("firebase/storage");
      // getStorage memoises per app instance, so repeated uploads reuse one.
      const storageRef = ref(getStorage(app), path);
      await uploadBytes(storageRef, file);
      return getDownloadURL(storageRef);
    })();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Storage upload timed out after 30 s")), 30_000)
    );

    return await Promise.race([uploadPromise, timeoutPromise]);
  } catch (err) {
    // Log but don't surface to the user — data-URL fallback keeps the flow working.
    console.warn("[OquNet] Firebase Storage upload failed, using data-URL fallback:", err?.message ?? err);
    return dataUrl;
  }
}
