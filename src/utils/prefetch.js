// Fetching things slightly before they are asked for.
//
// Two different costs are being hidden here, and they are worth keeping apart:
//
//   1. The *chunk*. Every screen behind the auth gate is a separate JS file
//      (see lazyRoute), so the first tap on a tab pays a network round trip
//      before React can render anything — on a phone on 3G that is the whole
//      of the delay, and it happens on a screen that is already idle.
//   2. The *data*. Opening a book runs `getBook` from cold even though the row
//      the reader just touched came from a list that already knows the book's
//      id, and the detail query has a cache entry waiting to be filled.
//
// Both are speculative work, so both follow the same two rules. Do it when the
// browser is idle or when the reader has signalled intent (a hover, a finger
// landing on a row), never on a timer; and do it once — a registry of what has
// already been asked for, because a list of thirty rows will fire the same
// hover handler thirty times as a thumb travels down it.
//
// Nothing here is allowed to throw into the app. A prefetch that fails is a
// prefetch that did not happen, and the real fetch behind it will report the
// error properly when the reader actually arrives.

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getBook, getPost } from "../firebase/firestore.js";
import { qk } from "../lib/queryKeys.js";
import { logger } from "./logger.js";

/** Run `fn` when the main thread has nothing better to do. */
export function onIdle(fn, timeout = 2000) {
  if (typeof window === "undefined") return () => {};
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback?.(id);
  }
  // Safari has no requestIdleCallback. A timeout is a poor substitute — it
  // fires whether or not the thread is busy — so it is deliberately long
  // enough to land after the current screen has finished painting.
  const id = setTimeout(fn, 300);
  return () => clearTimeout(id);
}

/**
 * Is this connection one we should be spending speculative bytes on?
 *
 * `saveData` is the reader explicitly asking us not to, and 2g means a
 * prefetch would be competing with the fetch it is meant to be helping.
 * Both are Chromium-only; everywhere else the answer is yes, which is the
 * right default — the feature degrades to "always prefetch", which is what
 * every browser did before the API existed.
 */
export function shouldPrefetch() {
  const c = typeof navigator !== "undefined" ? navigator.connection : null;
  if (!c) return true;
  if (c.saveData) return false;
  return !/(^|-)2g$/.test(c.effectiveType || "");
}

// ── Route chunks ────────────────────────────────────────────────────────────

// Path → the dynamic import behind that route, filled in by lazyRoute as
// App.jsx is evaluated. A registry rather than a second copy of the import
// list: the alternative is writing every `() => import("./pages/...")` twice
// and having the two drift the first time a route is renamed.
const routeImporters = new Map();
const startedRoutes = new Set();

/** Called by lazyRoute. Not part of the public surface. */
export function registerRoute(path, importer) {
  if (path) routeImporters.set(path, importer);
}

/**
 * Pull a route's JS down now. Safe to call as often as you like — the second
 * call for a path is a no-op, and so is a call for an unregistered one.
 */
export function preloadRoute(path) {
  if (!path || startedRoutes.has(path) || !shouldPrefetch()) return;
  const importer = routeImporters.get(path);
  if (!importer) return;
  startedRoutes.add(path);
  importer().catch((err) => {
    // A failed *pre*load must not poison anything: drop it from the started
    // set so the real navigation gets a clean attempt, where lazyRoute's
    // stale-chunk recovery can do its job.
    startedRoutes.delete(path);
    logger.debug("prefetch.route", "preload failed", { path, err: err?.message });
  });
}

/** Preload several routes in order, one idle slot each. */
export function preloadRoutes(paths) {
  paths.forEach((path, i) => {
    // Staggered rather than fired together: four parallel chunk requests on a
    // phone contend with whatever the screen the reader is actually looking at
    // is still fetching.
    onIdle(() => preloadRoute(path), 2000 + i * 500);
  });
}

// ── Query data ──────────────────────────────────────────────────────────────

// The prefetched-data equivalent of `startedRoutes`. React Query dedupes
// in-flight fetches by key already; this is about not re-entering the whole
// path (and re-reading a document) once a cached entry has gone stale under a
// hover handler that keeps firing.
const primed = new Set();

/**
 * Hover/touch handlers that warm one book's detail query.
 *
 * Returns props to spread onto the row. `onPointerEnter` covers a mouse,
 * `onTouchStart` covers a thumb landing before it lifts — roughly 80–150 ms of
 * head start on a tap, which is most of a Firestore round trip on a warm
 * connection — and `onFocus` covers keyboard navigation.
 */
export function useBookPrefetch() {
  const queryClient = useQueryClient();

  return useCallback(
    (bookId) => {
      if (!bookId) return {};
      const warm = () => {
        const key = `book:${bookId}`;
        if (primed.has(key) || !shouldPrefetch()) return;
        primed.add(key);
        // The detail screen's chunk is as much of the wait as the document is.
        preloadRoute("/books/:id");
        queryClient
          .prefetchQuery({
            queryKey: qk.books.detail(bookId),
            queryFn: () => getBook(bookId),
            // Matches the global staleTime, so arriving on the screen a moment
            // later reads this entry instead of immediately refetching it.
            staleTime: 60_000,
          })
          .catch(() => primed.delete(key));
      };
      return { onPointerEnter: warm, onTouchStart: warm, onFocus: warm };
    },
    [queryClient]
  );
}

/** The same, for a post row in the feed. */
export function usePostPrefetch() {
  const queryClient = useQueryClient();

  return useCallback(
    (postId) => {
      if (!postId) return {};
      const warm = () => {
        const key = `post:${postId}`;
        if (primed.has(key) || !shouldPrefetch()) return;
        primed.add(key);
        preloadRoute("/posts/:id");
        queryClient
          .prefetchQuery({
            queryKey: qk.posts.detail(postId),
            queryFn: () => getPost(postId),
            staleTime: 60_000,
          })
          .catch(() => primed.delete(key));
      };
      return { onPointerEnter: warm, onTouchStart: warm, onFocus: warm };
    },
    [queryClient]
  );
}

/**
 * Warm a list of routes once, after the current screen has settled.
 *
 * Call it from a screen that knows where its readers go next — the tab bar
 * knows all four tabs are one tap away, the shelf knows the next tap is a book.
 */
export function useRoutePreload(paths) {
  // The array is almost always an inline literal, so depending on it directly
  // would re-run this on every render. The paths a screen preloads do not
  // change over its life, so the first one wins.
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    preloadRoutes(paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
