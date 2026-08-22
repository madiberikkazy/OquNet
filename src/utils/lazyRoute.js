// Route-level code splitting helper.
//
// Every deploy emits fresh hashed chunk filenames and drops the previous ones.
// A tab still running the OLD index.html only knows the old names, so the first
// lazy route it opens after a deploy requests a file that no longer exists. The
// dynamic import rejects and React renders nothing — a blank screen with no way
// back. Reloading pulls the new index.html and fixes it permanently, so that's
// what we do. The timestamp guard stops a genuinely broken build (or a route
// that is 404ing for some other reason) from turning that into a reload loop.

import { lazy } from "react";
import { safeGet, safeSet } from "./safeStorage.js";
import { registerRoute } from "./prefetch.js";
import { logger } from "./logger.js";

const RELOAD_KEY = "oqunet:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

function reloadOnce() {
  const last = Number(safeGet(RELOAD_KEY, "0"));
  if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
  safeSet(RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

/**
 * Like React.lazy, but recovers from the post-deploy stale-chunk 404 instead of
 * blanking the route. Use for every route component.
 *
 * `path` is optional and is purely for prefetching: giving a route its own
 * path here files the importer in the registry that `preloadRoute` reads, so
 * the tab bar can pull a screen's chunk down while the reader is still looking
 * at the previous one. Registering the *same* importer the router uses is the
 * point — Rollup emits one chunk for it, so a preload and the real navigation
 * are the same request, and a route that is renamed cannot fall out of sync
 * with its own preloader.
 */
export function lazyRoute(importer, path) {
  registerRoute(path, importer);
  return lazy(() =>
    importer().catch((err) => {
      logger.warn("router", "lazy chunk failed to load", { err: err?.message });
      if (reloadOnce()) {
        // location.reload() doesn't stop execution. Hand back a promise that
        // never settles so React keeps showing the Suspense fallback for the
        // moment before the page is torn down, rather than flashing an error.
        return new Promise(() => {});
      }
      throw err;
    })
  );
}
