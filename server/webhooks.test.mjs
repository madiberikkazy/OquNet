// Drives server.js end to end against the Firestore emulator: the /start
// binding, the contact card, the checks that refuse one, and the credential
// parsing that decides whether the process starts at all.
//
//   npm run test:emulator          (from this folder)

import assert from "node:assert/strict";

const PROJECT = "demo-oqunet-server";
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_SECRET = "tg-secret";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = PROJECT;
process.env.PORT = String(PORT);
process.env.TELEGRAM_BOT_TOKEN = "tg-token";
process.env.TELEGRAM_WEBHOOK_SECRET = TG_SECRET;

// The emulator needs no credential; leaving both unset takes the
// application-default branch, which FIRESTORE_EMULATOR_HOST makes valid.
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

// The real one, kept before the stub below takes its place — the test still has
// to reach the server it is driving.
const realFetch = globalThis.fetch.bind(globalThis);

// Telegram itself is never called: the bot's replies are not under test, and a
// request to api.telegram.org with a fake token would only slow the run down.
// The stub records them so the /start reply can still be asserted.
const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.telegram.org/")) {
    sent.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "ok" };
  }
  return realFetch(url, init);
};

const { loadServiceAccount } = await import("./server.js");
await new Promise((r) => setTimeout(r, 700));

const admin = (await import("firebase-admin")).default;
const db = admin.firestore();

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (err) { results.push(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

const TOKEN = "ABCDEFGH2345";
const CLAIMED = "+77771234567";

async function seedAttempt(token = TOKEN, over = {}) {
  await db.collection("users").doc("u1").set({ phone: "", phoneVerifiedAt: null });
  await db.collection("phoneVerifications").doc(token).set({
    userId: "u1", phone: CLAIMED, channel: "telegram",
    status: "pending", expiresAt: Date.now() + 900000, ...over,
  });
}
const post = (body, secret = TG_SECRET) => {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return realFetch(`${BASE}/telegram/webhook`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
};
const start = (chatId, fromId, token) =>
  post({ message: { chat: { id: chatId }, from: { id: fromId }, text: `/start VERIFY_${token}` } });
const contact = (chatId, fromId, userId, phone) =>
  post({ message: { chat: { id: chatId }, from: { id: fromId }, contact: { user_id: userId, phone_number: phone } } });
const user = async () => (await db.collection("users").doc("u1").get()).data();
const attempt = async (token = TOKEN) =>
  (await db.collection("phoneVerifications").doc(token).get()).data();

await check("the credential loader accepts one-line JSON", async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: "p", client_email: "a@b.c", private_key: "-----BEGIN-----\\nKEY\\n-----END-----",
  });
  const parsed = loadServiceAccount();
  assert.equal(parsed.project_id, "p");
  assert.ok(parsed.private_key.includes("\n"), "escaped newlines must be unescaped");
  assert.ok(!parsed.private_key.includes("\\n"));
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

await check("the credential loader accepts base64", async () => {
  const json = JSON.stringify({ project_id: "p", client_email: "a@b.c", private_key: "k" });
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(json).toString("base64");
  assert.equal(loadServiceAccount().project_id, "p");
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
});

await check("the credential loader explains bad JSON instead of throwing a SyntaxError", async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT = "{not json";
  assert.throws(() => loadServiceAccount(), /not valid JSON/);
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "p" });
  assert.throws(() => loadServiceAccount(), /not a service-account key/);
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

await check("health reports whether Telegram is wired up", async () => {
  const res = await realFetch(`${BASE}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.telegram, { botToken: true, webhookSecret: true, ready: true });
});

await check("an update with no secret header is refused", async () => {
  await seedAttempt();
  const res = await post({ message: { chat: { id: 1 }, from: { id: 1 }, text: `/start VERIFY_${TOKEN}` } }, null);
  assert.equal(res.status, 403);
  assert.equal((await attempt()).telegramChatId, undefined, "nothing may be written");
});

await check("an update with the wrong secret is refused", async () => {
  const res = await post({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/start" } }, "wrong");
  assert.equal(res.status, 403);
});

await check("/start binds the chat to the attempt", async () => {
  await seedAttempt();
  const res = await start(42, 7, TOKEN);
  assert.equal(res.status, 200);
  assert.equal((await attempt()).telegramChatId, "42");
  const keyboard = sent.at(-1)?.body?.reply_markup?.keyboard;
  assert.ok(keyboard?.[0]?.[0]?.request_contact, "the reply must ask for the contact");
});

await check("/start with an unknown token binds nothing", async () => {
  const res = await start(43, 8, "ZZZZZZZZZZZZ");
  assert.equal(res.status, 200);
  const snap = await db.collection("phoneVerifications").doc("ZZZZZZZZZZZZ").get();
  assert.equal(snap.exists, false);
});

await check("a matching contact verifies the profile", async () => {
  await seedAttempt();
  await start(50, 9, TOKEN);
  await contact(50, 9, 9, "+7 777 123 45 67");   // spaces and a plus: same number
  const u = await user();
  assert.equal(u.phone, CLAIMED);
  assert.ok(u.phoneVerifiedAt > 0);
  assert.equal((await attempt()).status, "verified");
});

await check("a contact from a different number is a mismatch, not a verification", async () => {
  await seedAttempt();
  await start(51, 10, TOKEN);
  await contact(51, 10, 10, "+77019999999");
  assert.equal((await user()).phone, "", "a mismatch must not touch the profile");
  const a = await attempt();
  assert.equal(a.status, "mismatch");
  assert.equal(a.verifiedPhone, "+77019999999");
});

await check("a forwarded contact card proves nothing", async () => {
  await seedAttempt();
  await start(52, 11, TOKEN);
  await contact(52, 11, 999, CLAIMED);   // the card describes somebody else
  assert.equal((await user()).phone, "");
  assert.equal((await attempt()).status, "pending");
});

await check("a token is redeemable exactly once", async () => {
  await seedAttempt();
  await start(53, 12, TOKEN);
  await contact(53, 12, 12, CLAIMED);
  await db.collection("users").doc("u1").set({ phone: "", phoneVerifiedAt: null });
  await contact(53, 12, 12, CLAIMED);
  assert.equal((await user()).phone, "", "the second redemption must be a no-op");
});

await check("an expired attempt is closed, not honoured", async () => {
  await seedAttempt(TOKEN, { expiresAt: Date.now() - 1000 });
  await start(54, 13, TOKEN);
  await contact(54, 13, 13, CLAIMED);
  assert.equal((await user()).phone, "");
  assert.equal((await attempt()).status, "expired");
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nFAILURES" : "\nall server checks passed");
process.exit(process.exitCode || 0);
