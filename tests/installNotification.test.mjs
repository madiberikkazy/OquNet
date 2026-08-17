// The "OquNet is on your home screen" message, driven through the real
// announcement path: the Firestore write (the localStorage branch here) and the
// OS notification that goes with it.
//
// What is worth testing is not the copy but the promises around it — it happens
// exactly once per account however many times install is reported, it still
// lands in the in-app list when the browser refuses to show anything, it does
// not mark itself as told when the write failed, and it leaves behind the tag
// and destination the notification poll needs in order not to say it twice.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const LS_KEY = "oqunet:db";

// Same browser stand-ins as dataLayer.test.mjs — installed before any module
// that reads them is imported. safeStorage.js reaches through `window`, the
// data layer through the bare global, so both point at one store.
const store = new Map();
let failDbWrites = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    // Stands in for a full disk or a Firestore write that never lands.
    if (failDbWrites && k === LS_KEY) throw new Error("quota exceeded");
    store.set(k, String(v));
  },
  removeItem: (k) => void store.delete(k),
};
globalThis.window = { localStorage: globalThis.localStorage };

// Every notification handed to the OS, in order. The app shows them through the
// service worker registration — the only path that works on Android and in an
// installed iOS PWA — so that is what is stubbed here.
const shown = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    serviceWorker: {
      getRegistration: async () => ({
        showNotification: async (title, options) => void shown.push({ title, options }),
      }),
    },
  },
});

/** Stand in for the browser's notification permission. */
function setPermission(permission) {
  const api = {
    permission,
    requestPermission: async () => permission,
  };
  globalThis.Notification = api;
  globalThis.window.Notification = api;
}

setPermission("granted");

const { announceInstall, notifiedKey, PENDING_KEY } = await import(
  "../src/utils/installNotification.js"
);
const { listNotifications } = await import("../src/firebase/firestore.js");
const { wasNotificationAnnounced } = await import("../src/utils/notificationService.js");

describe("install announcement", () => {
  beforeEach(() => {
    store.clear();
    shown.length = 0;
    failDbWrites = false;
    setPermission("granted");
  });

  it("writes one notification the user can open", async () => {
    const created = await announceInstall("u1");

    const list = await listNotifications("u1");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].type, "app-installed");
    assert.equal(list[0].read, false);
    assert.ok(list[0].title.length > 0);
    assert.ok(list[0].body.length > 0);
  });

  it("shows it in the OS, tagged and pointing at itself", async () => {
    const created = await announceInstall("u1");
    const [stored] = await listNotifications("u1");

    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, stored.title);
    assert.equal(shown[0].options.body, stored.body);
    assert.equal(shown[0].options.tag, `notification-${created.id}`);
    assert.equal(shown[0].options.data.url, `/notifications/${created.id}`);
    // …and the poll in NotificationContext must not announce it a second time.
    assert.ok(wasNotificationAnnounced(created.id));
  });

  it("happens once, however many times install is reported", async () => {
    await announceInstall("u1");
    await announceInstall("u1");
    await Promise.all([announceInstall("u1"), announceInstall("u1")]);

    assert.equal((await listNotifications("u1")).length, 1);
    assert.equal(shown.length, 1);
  });

  it("is per account, not per device", async () => {
    await announceInstall("u1");
    await announceInstall("u2");

    assert.equal((await listNotifications("u1")).length, 1);
    assert.equal((await listNotifications("u2")).length, 1);
  });

  it("clears the flag left behind by installing while signed out", async () => {
    globalThis.localStorage.setItem(PENDING_KEY, "1");

    await announceInstall("u1");

    assert.equal(globalThis.localStorage.getItem(PENDING_KEY), null);
    assert.ok(globalThis.localStorage.getItem(notifiedKey("u1")));
  });

  it("still writes the message when the browser will not show one", async () => {
    setPermission("denied");

    const created = await announceInstall("u1");

    assert.ok(created);
    assert.equal((await listNotifications("u1")).length, 1);
    assert.equal(shown.length, 0);
  });

  it("says nothing, and forgets nothing, when the write fails", async () => {
    failDbWrites = true;
    const failed = await announceInstall("u1");
    failDbWrites = false;

    assert.equal(failed, null);
    assert.equal(shown.length, 0);
    // Nothing was told to anyone, so nothing may be marked as told.
    assert.equal(globalThis.localStorage.getItem(notifiedKey("u1")), null);

    // The next launch says it properly.
    const created = await announceInstall("u1");
    assert.ok(created);
    assert.equal((await listNotifications("u1")).length, 1);
    assert.equal(shown.length, 1);
  });

  it("does nothing without an account to address it to", async () => {
    assert.equal(await announceInstall(null), null);
    assert.equal(shown.length, 0);
  });
});
