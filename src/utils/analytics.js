// Product analytics — what readers actually do with the app.
//
// This is deliberately not a third-party SDK. One would cost 30–60 kB on the
// critical path of a phone app whose entire vendor bundle is 250 kB, would
// need a cookie banner, and would ship every event to somebody else's server.
// What is needed here is smaller than that: a name, a few scalar properties,
// and a reliable way to get them off the device.
//
// ── The shape of an event ───────────────────────────────────────────────────
//
//   { name, ts, sessionId, userId, props: { … } }
//
// `props` carries ids and enums only. Never a title, never a message body,
// never a phone number, never a search term — see `sanitize`, which drops
// anything that is not a short scalar and is the last line of defence rather
// than the first. The first is not passing them in.
//
// ── Getting them off the device ─────────────────────────────────────────────
//
// Events are buffered and flushed in batches, because one request per tap is
// both wasteful and unreliable on a phone that is about to be locked. The
// buffer is mirrored to localStorage on every write, so events survive a
// reload, a crash, or a tab closed mid-session — the next launch picks up
// whatever the last one did not manage to send.
//
// Flushes happen on: a full batch, a 15-second timer, the tab being hidden
// (which on mobile is the *only* reliable "app is closing" signal — `unload`
// does not fire on iOS), and coming back online. The hidden-tab flush uses
// `sendBeacon`, which is the one transport the browser promises to finish
// after the page is gone.
//
// ── Consent ─────────────────────────────────────────────────────────────────
//
// No endpoint configured means no network, and that is the default: with
// `VITE_ANALYTICS_ENDPOINT` unset the whole module degrades to a dev-console
// mirror and drops everything else. Do Not Track disables it outright.

import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { logger } from "./logger.js";

const ENDPOINT = import.meta.env?.VITE_ANALYTICS_ENDPOINT || "";
const IS_DEV = !import.meta.env?.PROD;

// IndexedDB, not localStorage, and for one specific reason: the service
// worker has to be able to read this. A Background Sync wakeup happens with
// no page open — that is the entire point of it — and a service worker has no
// localStorage. Both sides agree on this key and on the shape stored under it
// (see the `sync` handler in public/sw.js).
//
// The stored value carries the endpoint alongside the events. public/sw.js is
// served verbatim and never passes through Vite, so it cannot read
// `VITE_ANALYTICS_ENDPOINT`; writing the endpoint next to the batch is what
// lets the worker send it without being configured separately.
const QUEUE_KEY = "oqunet:analytics:outbox";
const SESSION_KEY = "oqunet:analytics:session";

// Batch size and interval are a trade between request count and how much is
// lost when a device disappears without a hidden event (a hard crash, a
// battery dying). Fifteen seconds is small enough that the loss is a handful
// of taps.
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 15_000;
// A hard ceiling on the persisted queue. An endpoint that has been down for a
// day must not fill the reader's storage quota — and once a backlog is this
// old it has stopped being useful anyway. Oldest go first.
const MAX_QUEUE = 200;

/** Honour the browser-level opt-out before anything else. */
function trackingAllowed() {
  if (typeof navigator === "undefined") return false;
  const dnt =
    navigator.doNotTrack ?? window.doNotTrack ?? navigator.msDoNotTrack;
  return dnt !== "1" && dnt !== "yes";
}

const enabled = trackingAllowed();

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * A session is one visit. It lives in sessionStorage, so a second tab is a
 * second session and closing the tab ends it — which is what makes "events in
 * this session" mean something. Not a device id: nothing here is designed to
 * follow a reader between visits.
 */
function currentSessionId() {
  try {
    const existing = window.sessionStorage?.getItem(SESSION_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage?.setItem(SESSION_KEY, id);
    return id;
  } catch {
    // Private mode with storage disabled. A per-load id is still better than
    // none — the events just cannot be stitched across a reload.
    return `s_${Date.now().toString(36)}`;
  }
}

const sessionId = enabled ? currentSessionId() : "";

// The signed-in user, set by AuthContext once the session resolves. Held in a
// module variable rather than read from a context so that `track` can be
// called from anywhere — a mutation handler, a utility, the service-worker
// bridge — without threading React state through it.
let userId = null;

/** Called from AuthContext when the session resolves or ends. */
export function setAnalyticsUser(id) {
  userId = id || null;
}

// ── Sanitising ──────────────────────────────────────────────────────────────

const MAX_STRING = 64;

/**
 * Reduce a props object to short scalars.
 *
 * Numbers and booleans pass. Strings are truncated. Everything else — objects,
 * arrays, functions, anything that could be a whole document — is dropped
 * rather than serialised, because the failure mode of "serialise whatever you
 * were given" is a post's body ending up in an analytics payload.
 */
function sanitize(props) {
  if (!props || typeof props !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, MAX_STRING);
  }
  return out;
}

// ── The queue ───────────────────────────────────────────────────────────────

// Held in memory and mirrored to IndexedDB. In memory because `track` is
// called from render paths and must not await anything; mirrored because a
// phone that is locked mid-session should not lose the events, and because
// the service worker drains the mirror when the app is gone.
let queue = [];
let timer = null;

function persist() {
  if (!enabled) return;
  // Fire and forget. A failed mirror write costs at most the events since the
  // last successful one — the in-memory queue is unaffected, and the flush
  // paths do not read from disk.
  const write = queue.length === 0
    ? idbDel(QUEUE_KEY)
    : idbSet(QUEUE_KEY, { endpoint: ENDPOINT, events: queue });
  write.catch((err) => logger.debug("analytics", "persist failed", { err: err?.message }));
}

/**
 * Adopt whatever the previous session left behind.
 *
 * Prepended, not appended: those events are older than anything this session
 * has recorded, and a batch that arrives out of order is a session that reads
 * backwards at the other end.
 */
async function restore() {
  if (!enabled) return;
  try {
    const stored = await idbGet(QUEUE_KEY);
    const events = Array.isArray(stored?.events) ? stored.events : [];
    if (events.length === 0) return;
    queue = events.concat(queue).slice(-MAX_QUEUE);
    scheduleFlush();
  } catch (err) {
    logger.debug("analytics", "restore failed", { err: err?.message });
  }
}

function scheduleFlush() {
  if (timer || queue.length === 0) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Record one event.
 *
 * Never throws and never awaits — a call site should be able to drop this in
 * next to a mutation without thinking about failure. `name` is a dotted
 * identifier: `book.pickup.start`, `post.create`, `screen.view`.
 */
export function track(name, props) {
  if (!enabled || !name) return;
  try {
    queue.push({
      name: String(name).slice(0, MAX_STRING),
      ts: Date.now(),
      sessionId,
      userId,
      props: sanitize(props),
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    persist();

    if (IS_DEV) logger.debug("analytics", name, props);
    if (queue.length >= BATCH_SIZE) flush();
    else scheduleFlush();
  } catch (err) {
    // Analytics failing is never a reason for the app to fail.
    logger.warn("analytics", "track failed", { err: err?.message });
  }
}

/**
 * Send everything buffered.
 *
 * `useBeacon` is for the hidden/pagehide path: `sendBeacon` hands the payload
 * to the browser, which delivers it after the page is gone. It cannot report
 * success, so the queue is cleared optimistically — losing a batch is a much
 * smaller problem than a queue that grows for ever because nothing ever
 * confirms it.
 */
export function flush({ useBeacon = false } = {}) {
  if (!enabled || queue.length === 0) return;
  if (timer) { clearTimeout(timer); timer = null; }

  // No endpoint: this is a build with analytics switched off. Events were
  // still mirrored to the dev console above; drop them rather than growing a
  // queue nothing will ever drain.
  if (!ENDPOINT) { queue = []; persist(); return; }

  // Offline. Keep the batch, and hand the problem to Background Sync: the
  // browser will wake the service worker once connectivity is back, whether or
  // not this page still exists. The `online` listener below covers the case
  // where it does.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    requestBackgroundSync();
    return;
  }

  const batch = queue;
  queue = [];
  persist();

  const body = JSON.stringify({ events: batch });

  if (useBeacon && typeof navigator?.sendBeacon === "function") {
    const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    // A beacon is refused when the payload exceeds the browser's cap (64 kB in
    // Chrome). Put the batch back so the timer path can try it as a real
    // request instead of it vanishing silently.
    if (!ok) { queue = batch.concat(queue).slice(-MAX_QUEUE); persist(); }
    return;
  }

  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    // Survives the navigation that may be in flight behind this call.
    keepalive: true,
  }).catch((err) => {
    // Requeue at the front: these events are older than anything added since.
    queue = batch.concat(queue).slice(-MAX_QUEUE);
    persist();
    logger.debug("analytics", "flush failed, requeued", { err: err?.message, n: batch.length });
    requestBackgroundSync();
  });
}

/**
 * Ask the browser to retry this batch later, from the service worker.
 *
 * `SyncManager` is Chromium-only. Where it is missing — every version of
 * Safari, which is most of this app's install base — the queue simply waits on
 * disk for the next launch, which `restore` picks up. That is a worse
 * guarantee, not a broken one, and it is the reason the online listener and
 * the restore path both still exist rather than deferring to the worker.
 */
function requestBackgroundSync() {
  if (!ENDPOINT || typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.sync?.register("oqunet-analytics"))
    .catch((err) => logger.debug("analytics", "sync register failed", { err: err?.message }));
}

// ── Lifecycle wiring ────────────────────────────────────────────────────────

let installed = false;

/**
 * Attach the flush triggers. Called once from main.jsx; safe to call again.
 */
export function installAnalytics() {
  if (installed || !enabled || typeof window === "undefined") return;
  installed = true;

  // `visibilitychange` → hidden is the only signal iOS reliably gives before
  // an app is backgrounded or killed. `pagehide` covers desktop navigation
  // away. `beforeunload` is deliberately not used: registering it disqualifies
  // the page from the back/forward cache on every browser that has one.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush({ useBeacon: true });
  });
  window.addEventListener("pagehide", () => flush({ useBeacon: true }));
  window.addEventListener("online", () => flush());

  // Anything the last session left behind goes out now. Async, unlike the old
  // localStorage read — nothing depends on it having finished, and events
  // recorded in the meantime are simply appended after it.
  restore();
}

// Every path segment the router treats as a fixed word. Anything else in a
// URL is an id of some kind, and an id in an analytics payload is exactly the
// linkage this module is built to avoid — "this session opened books/AbC123"
// is a fact about a person, not about a screen.
//
// A whitelist rather than a shape test (`/^[A-Za-z0-9]{20}$/` and friends),
// because the test is the part that fails silently: a short slug or a numeric
// id would sail straight through it and out to the endpoint. An unrecognised
// word here is masked, which is the safe direction to be wrong in — the cost
// is a screen name reading `:id` until somebody adds the segment below.
const STATIC_SEGMENTS = new Set([
  "auth", "login", "register",
  "books", "add", "edit", "journey", "pickup", "return", "confirm",
  "chats", "new",
  "posts", "share",
  "notifications",
  "profile", "owned", "timer", "reading", "completed", "saved", "liked",
  "settings", "phone", "security", "theme", "language", "about", "support",
  "community", "create", "join", "leave", "members", "remove", "delete",
  "users", "followers", "following",
]);

/**
 * Turn a live URL into the route pattern behind it.
 *
 *   /books/AbC123xyz/journey  →  /books/:id/journey
 *   /users/u_42/followers     →  /users/:id/followers
 */
export function screenName(pathname) {
  if (!pathname || pathname === "/") return "/";
  const parts = pathname.split("/").filter(Boolean);
  return "/" + parts.map((p) => (STATIC_SEGMENTS.has(p) ? p : ":id")).join("/");
}

/**
 * One screen view. Pass the live pathname; the id segments are masked here so
 * that no call site has to remember to do it.
 */
export function trackScreen(pathname, props) {
  track("screen.view", { path: screenName(pathname), ...props });
}
