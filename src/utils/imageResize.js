// Getting a picked photo down to a size the app can actually store.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// firebase/storage.js falls back to a base64 data-URL whenever the real upload
// fails, and that string is then written into a Firestore document — the user's
// profile, a book, a community. Firestore refuses any document over 1,048,487
// bytes outright, and base64 costs a third on top of the file itself, so a photo
// straight off a phone camera (2–5 MB) is rejected with an `invalid-argument`
// the screen can only report as "saving failed".
//
// That was the bug: avatars worked or did not work depending on how big the
// picked file happened to be. Shrinking first makes the answer the same every
// time — and it is worth doing even when Storage is working, because a 5 MB
// upload to show a 92-pixel avatar is a phone's data allowance spent on nothing.
//
// ── What it does ─────────────────────────────────────────────────────────────
// Decodes the image, scales the long edge down to `maxDimension`, and re-encodes
// as JPEG until the result fits the byte budget. A file that already fits, in a
// format browsers render natively, is returned untouched — that keeps a small
// PNG's transparency rather than matting it onto white for no reason.
//
// Every failure path returns the original file. A format this browser cannot
// decode is not something to refuse a user over: it may still upload fine, and
// if it does not, the caller's own budget check is what says so.

import { logger } from "./logger.js";

/** The long edge, per kind of picture. Avatars are never shown large. */
export const IMAGE_SIZES = Object.freeze({
  avatar: 512,
  cover: 1024,
});

/**
 * The most an image may weigh once stored.
 *
 * Firestore's document ceiling is 1,048,487 bytes and a data-URL is ~4/3 of the
 * file, so this leaves the document room for its actual fields and still lands
 * comfortably clear. It is a binary size — the base64 of it is about 640 KB.
 */
export const MAX_IMAGE_BYTES = 480_000;

const ENCODE_TYPE = "image/jpeg";
/** Tried in order; the first that fits wins. The last is the floor. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];
/** Formats worth leaving alone when they already fit. */
const PASSTHROUGH_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** An image that cannot be squeezed under the budget. Carries an i18n key. */
export class ImageTooLargeError extends Error {
  constructor(bytes) {
    super(`image is ${bytes} bytes after resizing; budget is ${MAX_IMAGE_BYTES}`);
    this.name = "ImageTooLargeError";
    this.errorKey = "photoTooLarge";
    this.bytes = bytes;
  }
}

function canResize() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Decode to something drawable.
 *
 * `createImageBitmap` where it exists, an <img> and an object URL where it does
 * not — which is the older-Safari path, and Safari is most of this app's
 * traffic. Both hand the browser's own decoder the file, so whatever the phone
 * can display (HEIC included, on iOS) is whatever this can read.
 */
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return { image: await createImageBitmap(file), release: (img) => img.close?.() };
    } catch {
      // Fall through — some browsers refuse formats here that <img> accepts.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image could not be decoded"));
      el.src = url;
    });
    return { image, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function drawToCanvas(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha, and an unpainted canvas is transparent black — which is
  // what turns a logo with a transparent background into a black square.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

function encode(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, ENCODE_TYPE, quality));
}

function jpegName(name) {
  const base = String(name || "photo").replace(/\.[^.]+$/, "");
  return `${base}.jpg`;
}

/**
 * Shrink `file` until it fits, or return it unchanged if it already does.
 *
 * @param maxDimension the long edge, in pixels — see IMAGE_SIZES.
 * @returns a File. Never throws: the original is the answer when anything here
 *   cannot run, and `assertWithinBudget` is what refuses an image for real.
 */
export async function shrinkImage(file, { maxDimension = IMAGE_SIZES.cover } = {}) {
  if (!file || typeof file !== "object") return file;
  if (!String(file.type || "").startsWith("image/")) return file;
  if (!canResize()) return file;

  let decoded;
  try {
    decoded = await decode(file);
  } catch (err) {
    logger.warn("image.resize", "could not decode; using the file as picked", {
      type: file.type, err: err?.message,
    });
    return file;
  }

  const { image, release } = decoded;
  try {
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) return file;

    // Already small enough, in a format every browser draws: leave it be rather
    // than re-encoding — that costs quality and, for a PNG, its transparency.
    const longEdge = Math.max(width, height);
    if (longEdge <= maxDimension && file.size <= MAX_IMAGE_BYTES && PASSTHROUGH_TYPES.has(file.type)) {
      return file;
    }

    let scale = Math.min(1, maxDimension / longEdge);
    // Two rounds of halving below the target, so a photograph that is enormous
    // in pixels *and* dense in detail still lands under the budget.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = drawToCanvas(image, w, h);

      for (const quality of QUALITY_STEPS) {
        const blob = await encode(canvas, quality);
        if (!blob) return file;                       // toBlob unsupported
        if (blob.size <= MAX_IMAGE_BYTES) {
          return new File([blob], jpegName(file.name), { type: ENCODE_TYPE });
        }
      }
      scale /= 2;
    }

    // Three rounds at the lowest quality and it still does not fit. Hand back
    // the smallest thing produced rather than the original, and let the budget
    // check refuse it with a sentence a reader can act on.
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const blob = await encode(drawToCanvas(image, w, h), QUALITY_STEPS[QUALITY_STEPS.length - 1]);
    return blob ? new File([blob], jpegName(file.name), { type: ENCODE_TYPE }) : file;
  } catch (err) {
    logger.warn("image.resize", "resize failed; using the file as picked", { err: err?.message });
    return file;
  } finally {
    release(image);
  }
}

/**
 * Refuse an image that cannot be stored inline.
 *
 * Only meaningful on the data-URL path: a file going to Storage may be any size
 * Storage accepts. Called there rather than here so the check sits next to the
 * thing it protects.
 */
export function assertWithinBudget(file) {
  if (file?.size > MAX_IMAGE_BYTES) throw new ImageTooLargeError(file.size);
  return file;
}
