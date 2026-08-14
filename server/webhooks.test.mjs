// Drives server.js end to end against the Firestore emulator: both webhooks,
// the signature checks, the mismatch path and the one-shot token.
//
//   npm run test:emulator          (from this folder)

import crypto from "node:crypto";
import assert from "node:assert/strict";

const PROJECT = "demo-oqunet-server";
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_SECRET = "tg-secret";
const WA_SECRET = "wa-app-secret";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = PROJECT;
process.env.PORT = String(PORT);
process.env.TELEGRAM_BOT_TOKEN = "tg-token";
process.env.TELEGRAM_WEBHOOK_SECRET = TG_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = "wa-verify";
process.env.WHATSAPP_APP_SECRET = WA_SECRET;
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account", project_id: PROJECT,
  private_key: "x", client_email: `sa@${PROJECT}.iam.gserviceaccount.com`,
});

// The emulator needs no real credential; stub the cert so admin boots.
const admin = (await import("firebase-admin")).default;
admin.credential.cert = () => admin.credential.applicationDefault();

await import("./server.js");
await new Promise((r) => setTimeout(r, 700));

const db = admin.firestore();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (err) { results.push(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

async function seedAttempt(token, over = {}) {
  await db.collection("users").doc("u1").set({ phone: "", phoneVerifiedAt: null });
  await db.collection("phoneVerifications").doc(token).set({
    userId: "u1", phone: "+77771234567", channel: "whatsapp",
    status: "pending", expiresAt: Date.now() + 900000, ...over,
  });
}
const waPost = (body, secret = WA_SECRET) => {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return fetch(`${BASE}/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
};
const waMessage = (from, text) => ({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn1" }, messages: [{ from, text: { body: text } }] } }] }],
});
const tgPost = (body, secret = TG_SECRET) =>
  fetch(`${BASE}/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });

await check("health reports both channels configured", async () => {
  const res = await fetch(`${BASE}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.channels, { telegram: true, whatsapp: true });
});

await check("whatsapp verifies a message from the claimed number", async () => {
  await seedAttempt("TOKEN1ABCDEF");
  const res = await waPost(waMessage("77771234567", "VERIFY_TOKEN1ABCDEF"));
  assert.equal(res.status, 200);
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "+77771234567");
  assert.ok(user.phoneVerifiedAt > 0);
  const attempt = (await db.collection("phoneVerifications").doc("TOKEN1ABCDEF").get()).data();
  assert.equal(attempt.status, "verified");
});

await check("whatsapp refuses a message from a different number", async () => {
  await seedAttempt("TOKEN2ABCDEF");
  await waPost(waMessage("77019999999", "VERIFY_TOKEN2ABCDEF"));
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "", "a mismatch must not touch the profile");
  const attempt = (await db.collection("phoneVerifications").doc("TOKEN2ABCDEF").get()).data();
  assert.equal(attempt.status, "mismatch");
  assert.equal(attempt.verifiedPhone, "+77019999999");
});

await check("whatsapp rejects a payload with a bad signature", async () => {
  await seedAttempt("TOKEN3ABCDEF");
  const res = await waPost(waMessage("77771234567", "VERIFY_TOKEN3ABCDEF"), "wrong-secret");
  assert.equal(res.status, 403);
  const attempt = (await db.collection("phoneVerifications").doc("TOKEN3ABCDEF").get()).data();
  assert.equal(attempt.status, "pending", "an unsigned payload must change nothing");
});

await check("a token is redeemable exactly once", async () => {
  await seedAttempt("TOKEN4ABCDEF");
  await waPost(waMessage("77771234567", "VERIFY_TOKEN4ABCDEF"));
  await db.collection("users").doc("u1").set({ phone: "", phoneVerifiedAt: null });
  await waPost(waMessage("77771234567", "VERIFY_TOKEN4ABCDEF"));
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "", "the second redemption must be a no-op");
});

await check("an expired attempt is closed, not honoured", async () => {
  await seedAttempt("TOKEN5ABCDEF", { expiresAt: Date.now() - 1000 });
  await waPost(waMessage("77771234567", "VERIFY_TOKEN5ABCDEF"));
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "");
  const attempt = (await db.collection("phoneVerifications").doc("TOKEN5ABCDEF").get()).data();
  assert.equal(attempt.status, "expired");
});

await check("telegram rejects a request without the secret header", async () => {
  const res = await tgPost({ message: { chat: { id: 5 }, text: "/start VERIFY_X" } }, "nope");
  assert.equal(res.status, 403);
});

await check("telegram binds a chat on /start, then verifies the contact", async () => {
  await seedAttempt("TOKEN6ABCDEF", { channel: "telegram" });
  await tgPost({ message: { chat: { id: 42 }, from: { id: 7 }, text: "/start VERIFY_TOKEN6ABCDEF" } });
  const bound = (await db.collection("phoneVerifications").doc("TOKEN6ABCDEF").get()).data();
  assert.equal(bound.telegramChatId, "42");

  await tgPost({ message: { chat: { id: 42 }, from: { id: 7 },
    contact: { user_id: 7, phone_number: "+7 777 123 45 67" } } });
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "+77771234567");
});

await check("telegram refuses somebody else's forwarded contact card", async () => {
  await seedAttempt("TOKEN7ABCDEF", { channel: "telegram" });
  await tgPost({ message: { chat: { id: 43 }, from: { id: 8 }, text: "/start VERIFY_TOKEN7ABCDEF" } });
  await tgPost({ message: { chat: { id: 43 }, from: { id: 8 },
    contact: { user_id: 999, phone_number: "+77771234567" } } });
  const user = (await db.collection("users").doc("u1").get()).data();
  assert.equal(user.phone, "", "a forwarded card proves nothing about the sender");
  const attempt = (await db.collection("phoneVerifications").doc("TOKEN7ABCDEF").get()).data();
  assert.equal(attempt.status, "pending");
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nFAILURES" : "\nall server checks passed");
process.exit(process.exitCode || 0);
