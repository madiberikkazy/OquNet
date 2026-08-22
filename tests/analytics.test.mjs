// The id-masking in src/utils/analytics.js.
//
// This is the privacy boundary of the whole module, and it is one function. A
// `screen.view` event carries a path; if that path is the live URL then the
// analytics stream records which book each reader opened, which profile they
// looked at, and who they messaged — a per-person behavioural log, assembled
// by accident, out of a feature meant to count screens.
//
// So the test that matters is not "does it mask ids" but "does it mask
// everything it does not recognise". `screenName` works off a whitelist of
// route words precisely so that the failure direction is a screen name reading
// `:id` rather than a leaked identifier, and that is what is pinned here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// analytics.js reads these at module scope.
//
// `navigator` is not stubbed: Node 20+ defines it as a getter-only global, so
// assigning to it throws. The real one is enough — it has no `doNotTrack`, and
// the module falls through to `window.doNotTrack` below. Which value wins does
// not matter here anyway: `enabled` gates the queue, not `screenName`, and the
// masking has to be correct either way.
globalThis.window = {
  doNotTrack: "0",
  sessionStorage: { getItem: () => null, setItem: () => {} },
};

const { screenName } = await import("../src/utils/analytics.js");

describe("analytics screen names", () => {
  it("leaves a static route alone", () => {
    assert.equal(screenName("/"), "/");
    assert.equal(screenName("/books"), "/books");
    assert.equal(screenName("/settings/notifications"), "/settings/notifications");
  });

  it("masks the id out of a detail route", () => {
    assert.equal(screenName("/books/AbC123xyz"), "/books/:id");
    assert.equal(screenName("/posts/9kQm2"), "/posts/:id");
    assert.equal(screenName("/notifications/n_88"), "/notifications/:id");
  });

  it("masks an id in the middle of a route", () => {
    assert.equal(screenName("/books/AbC123xyz/journey"), "/books/:id/journey");
    assert.equal(screenName("/users/u_42/followers"), "/users/:id/followers");
    assert.equal(
      screenName("/community/c1/members/u2/remove"),
      "/community/:id/members/:id/remove"
    );
  });

  it("masks an unrecognised segment even when it looks like a word", () => {
    // The whole point of a whitelist. A short slug, a numeric id, or a route
    // word somebody forgot to register are all masked — the safe direction to
    // be wrong in. A shape test would let every one of these through.
    assert.equal(screenName("/books/42"), "/books/:id");
    assert.equal(screenName("/books/abay"), "/books/:id");
    assert.equal(screenName("/somewhere-new"), "/:id");
  });

  it("is not confused by trailing or repeated slashes", () => {
    assert.equal(screenName("/books/"), "/books");
    assert.equal(screenName("//books//AbC123//"), "/books/:id");
  });

  it("handles an empty path", () => {
    assert.equal(screenName(""), "/");
    assert.equal(screenName(undefined), "/");
  });
});
