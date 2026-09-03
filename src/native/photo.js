/**
 * Picking a photo — the OS picker where there is one.
 *
 * ── What this returns, and why it matters ────────────────────────────────────
 * A `File`. Exactly the object `<input type="file">` produced, because
 * everything downstream — utils/imageResize.js, firebase/storage.js, the
 * data-URL fallback, the byte budget — is written against a File and none of it
 * should have to learn about Capacitor. The native picker hands back a URI
 * instead, so that URI is fetched inside the WebView and rebuilt into a File
 * here. One conversion, in one place, and the upload pipeline is untouched.
 *
 * ── Why not leave the file input alone ───────────────────────────────────────
 * It does work in a WebView. What it does not do is behave like the phone: on
 * iOS a bare file input opens a document browser rather than the photo library,
 * on Android it opens whichever file manager is installed, and neither offers
 * the camera without extra attributes that the two platforms read differently.
 * `Camera.getPhoto` opens the picker a person recognises, and asks for the
 * camera permission properly instead of failing silently when it is refused.
 *
 * ── Source ───────────────────────────────────────────────────────────────────
 * `Prompt` by default: the OS asks camera-or-library in its own sheet, in the
 * system language, and the answer is not ours to guess. An admin adding a book
 * is standing in front of the shelf and wants the camera; someone setting an
 * avatar wants the library. Both are one tap either way.
 */

import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { isNative, hasPlugin } from "./platform.js";
import { IMAGE_SIZES } from "../utils/imageResize.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/** A dismissed picker and a broken one throw alike; only the first is normal. */
function looksCancelled(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("denied access") ||
    message.includes("no image picked") ||
    message.includes("user cancelled")
  );
}

/**
 * The WebView can read the URI the picker returns — that is the whole reason
 * `webPath` exists — so `fetch` is the shortest path from it to bytes.
 */
async function uriToFile(webPath, format) {
  const response = await fetch(webPath);
  const blob = await response.blob();
  const type = blob.type || `image/${format || "jpeg"}`;
  const extension = (type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  return new File([blob], `photo-${Date.now()}.${extension}`, { type });
}

/**
 * Open the picker and return a File, or null if the reader backed out.
 *
 * @param {{ kind?: "avatar" | "cover", source?: "prompt" | "camera" | "library" }} options
 * @returns {Promise<File | null>}
 */
export async function pickPhoto({ kind = "cover", source = "prompt" } = {}) {
  if (!isNative || !hasPlugin("Camera")) return null;

  const sources = {
    prompt: CameraSource.Prompt,
    camera: CameraSource.Camera,
    library: CameraSource.Photos,
  };

  try {
    const photo = await Camera.getPhoto({
      // Uri, not Base64: a base64 round trip through the bridge for a 4 MB
      // camera frame is a visible freeze on a mid-range Android, and the very
      // next thing that happens to this file is being shrunk anyway.
      resultType: CameraResultType.Uri,
      source: sources[source] ?? CameraSource.Prompt,
      // The native downscale is free — it happens in the picker, before the
      // bytes ever cross the bridge — so asking for it here means
      // utils/imageResize.js usually has nothing left to do. It stays in the
      // pipeline regardless, because the web path has no such help.
      width: IMAGE_SIZES[kind] ?? IMAGE_SIZES.cover,
      quality: 90,
      correctOrientation: true,
      // Cropping is the reader's call, not ours: an avatar is squared by CSS
      // and a cover is `object-cover`, so forcing an editor in front of every
      // pick would be a step that changes nothing.
      allowEditing: false,
      promptLabelHeader: t.addPhoto,
      promptLabelPhoto: t.photoFromLibrary,
      promptLabelPicture: t.photoFromCamera,
      promptLabelCancel: t.cancel,
    });

    if (!photo?.webPath) return null;
    return await uriToFile(photo.webPath, photo.format);
  } catch (err) {
    if (looksCancelled(err)) return null;
    logger.warn("photo.pick", err?.message);
    return null;
  }
}

/**
 * Does this build have a native picker at all?
 *
 * The components below keep their hidden `<input type="file">` for the web
 * build and ask this before choosing which one a tap opens — so one component
 * serves both, and neither branch is a second copy of the surrounding screen.
 */
export const hasNativePicker = isNative && hasPlugin("Camera");
