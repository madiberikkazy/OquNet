// The sliding window in src/utils/rateLimit.js.
//
// What is worth testing here is not that a limit exists but the three
// properties the call sites rely on, each of which is easy to get wrong:
//
//   · the minimum gap and the window are separate guards, and the *first* one
//     to refuse wins — a double-tap is caught even where the window has plenty
//     of room left;
//   · the window slides. A fixed bucket would let 2×max through across a
//     boundary, which is precisely the burst this is meant to catch;
//   · `release` gives an attempt back, so a write that failed before it
//     happened does not count against the retry.
//
// Time is controlled rather than waited on: a test that sleeps for the real
// two-minute post window is a test nobody runs.

import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// safeStorage reaches through `window.localStorage`; installed before the
// module under test is imported, as in the other suites here.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
globalThis.window = { localStorage: globalThis.localStorage };

const { LIMITS, attempt, check, release, resetLimits, retryAfterSeconds } =
  await import("../src/utils/rateLimit.js");

// A clock the tests move by hand.
let now = 1_700_000_000_000;
mock.method(Date, "now", () => now);
const advance = (ms) => { now += ms; };

describe("rate limiting", () => {
  beforeEach(() => {
    resetLimits();
    store.clear();
    now = 1_700_000_000_000;
  });

  it("lets the first attempt through", () => {
    const verdict = attempt("post.create");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, null);
  });

  it("refuses a second attempt inside the minimum gap", () => {
    attempt("post.create");
    advance(500);

    const verdict = attempt("post.create");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, "too-fast");
    // Says how long to wait, not merely that it is too soon.
    assert.equal(verdict.retryAfterMs, LIMITS["post.create"].minGapMs - 500);
  });

  it("allows it again once the gap has passed", () => {
    attempt("post.create");
    advance(LIMITS["post.create"].minGapMs);
    assert.equal(attempt("post.create").allowed, true);
  });

  it("refuses once the window is full, and says when it frees up", () => {
    const { max, minGapMs, windowMs } = LIMITS["post.create"];
    for (let i = 0; i < max; i += 1) {
      assert.equal(attempt("post.create").allowed, true, `attempt ${i} should pass`);
      advance(minGapMs);
    }

    const verdict = attempt("post.create");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, "too-many");
    // The window frees up when the OLDEST attempt in it ages out, which is
    // (max-1) gaps ago — not a full window from now.
    assert.equal(verdict.retryAfterMs, windowMs - minGapMs * max);
  });

  it("slides: an old attempt stops counting once the window has moved past it", () => {
    const { max, minGapMs, windowMs } = LIMITS["post.create"];
    for (let i = 0; i < max; i += 1) { attempt("post.create"); advance(minGapMs); }
    assert.equal(check("post.create").allowed, false);

    // Far enough that the first attempt is outside the window. A fixed bucket
    // would still be counting it, or would have reset all of them at once.
    advance(windowMs - minGapMs * max);
    assert.equal(check("post.create").allowed, true);
  });

  it("counts each action separately", () => {
    const { max, minGapMs } = LIMITS["post.create"];
    for (let i = 0; i < max; i += 1) { attempt("post.create"); advance(minGapMs); }

    assert.equal(check("post.create").allowed, false);
    assert.equal(attempt("comment.create").allowed, true);
  });

  it("gives an attempt back on release", () => {
    const { max, minGapMs } = LIMITS["post.create"];
    for (let i = 0; i < max; i += 1) { attempt("post.create"); advance(minGapMs); }
    assert.equal(check("post.create").allowed, false, "window should be full");

    // The write failed, so it never happened.
    release("post.create");
    advance(minGapMs);
    assert.equal(attempt("post.create").allowed, true);
  });

  it("allows an action with no configured limit", () => {
    // Adding a call site must never be able to block a feature silently
    // because nobody added a limit for it.
    assert.equal(attempt("something.brand.new").allowed, true);
    assert.equal(attempt("something.brand.new").allowed, true);
  });

  it("survives a reload", async () => {
    const { max, minGapMs } = LIMITS["post.create"];
    for (let i = 0; i < max; i += 1) { attempt("post.create"); advance(minGapMs); }
    assert.equal(check("post.create").allowed, false);

    // A fresh module instance reading the same storage — which is what a
    // refresh is, and the reason the windows are persisted at all: a limit
    // that resets on reload is no limit, because a reload is exactly what
    // somebody does when a button appears not to work.
    const reloaded = await import("../src/utils/rateLimit.js?reload=1");
    assert.equal(reloaded.check("post.create").allowed, false);
  });

  it("rounds the wait up to whole seconds, never to zero", () => {
    assert.equal(retryAfterSeconds(1), 1);
    assert.equal(retryAfterSeconds(1001), 2);
    assert.equal(retryAfterSeconds(3000), 3);
  });
});
