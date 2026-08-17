// The chat data layer, driven through its real public API against the
// localStorage branch — the same arrangement dataLayer.test.mjs uses, and for
// the same reason: this is the half the emulator cannot reach, and the rules
// tests in firestore.rules.test.js cover the other half.
//
// What is under test here is the model, not the transport: that a pair of
// people have exactly one conversation however they arrive at it, that the
// unread counters move for the right person, and that the rollup on the chat
// document keeps telling the truth about the subcollection underneath it.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

// Browser stand-ins, installed before firestore.js is imported.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
globalThis.window = { localStorage: globalThis.localStorage };

const {
  chatIdFor, getChat, listMessages, markChatRead, otherMemberId,
  sendMessage, unreadFor, watchChatsForUser,
} = await import("../src/firebase/firestore.js");

const { SchemaError } = await import("../src/firebase/schema.js");

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";

/** First answer from a subscription, then unsubscribed — one poll, not a loop. */
function firstRows(subscribe) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop?.(); reject(new Error("no rows")); }, 2000);
    const stop = subscribe({
      onRows: (rows) => { clearTimeout(timer); resolve(rows); queueMicrotask(() => stop?.()); },
      onError: (err) => { clearTimeout(timer); reject(err); },
    });
  });
}

describe("chats: one conversation per pair", () => {
  beforeEach(() => store.clear());

  it("gives the same id whichever way round the pair is named", () => {
    assert.equal(chatIdFor(ALICE, BOB), chatIdFor(BOB, ALICE));
    assert.equal(chatIdFor(ALICE, BOB), [ALICE, BOB].sort().join("__"));
  });

  it("refuses a chat with yourself", () => {
    assert.throws(() => chatIdFor(ALICE, ALICE), SchemaError);
    assert.rejects(() => sendMessage({ senderId: ALICE, recipientId: ALICE, text: "hi" }));
  });

  it("refuses a member id that would make two pairs collide", () => {
    assert.throws(() => chatIdFor("a__b", CAROL), SchemaError);
  });

  it("both people writing first still produces one thread", async () => {
    const first = await sendMessage({ senderId: ALICE, recipientId: BOB, text: "hello" });
    const second = await sendMessage({ senderId: BOB, recipientId: ALICE, text: "hi back" });

    assert.equal(first.chatId, second.chatId);
    const mine = await firstRows((h) => watchChatsForUser(ALICE, h));
    assert.equal(mine.length, 1);
    assert.equal((await listMessages(first.chatId)).length, 2);
  });

  it("keeps other people's conversations out of the list", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "hello" });
    await sendMessage({ senderId: BOB, recipientId: CAROL, text: "private" });

    const alices = await firstRows((h) => watchChatsForUser(ALICE, h));
    assert.deepEqual(alices.map((c) => c.id), [chatIdFor(ALICE, BOB)]);

    const bobs = await firstRows((h) => watchChatsForUser(BOB, h));
    assert.equal(bobs.length, 2);
  });
});

describe("chats: messages", () => {
  beforeEach(() => store.clear());

  it("refuses an empty message before anything is written", async () => {
    await assert.rejects(() => sendMessage({ senderId: ALICE, recipientId: BOB, text: "   " }));
    assert.equal(await getChat(chatIdFor(ALICE, BOB)), null);
  });

  it("reads back oldest first", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "one" });
    await sendMessage({ senderId: BOB, recipientId: ALICE, text: "two" });
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "three" });

    const history = await listMessages(chatIdFor(ALICE, BOB));
    assert.deepEqual(history.map((m) => m.text), ["one", "two", "three"]);
    assert.deepEqual(history.map((m) => m.senderId), [ALICE, BOB, ALICE]);
  });

  it("summarises the thread on the chat document", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "one" });
    await sendMessage({ senderId: BOB, recipientId: ALICE, text: "the latest" });

    const chat = await getChat(chatIdFor(ALICE, BOB));
    assert.equal(chat.lastMessage.text, "the latest");
    assert.equal(chat.lastMessage.senderId, BOB);
    assert.ok(chat.lastMessage.at > 0);
    assert.deepEqual(chat.memberIds, [ALICE, BOB].sort());
  });

  it("does not create a thread just because somebody looked", async () => {
    // Nothing has been said, so there is nothing to list — an empty chat is not
    // a chat, and must not appear in either person's list.
    assert.equal(await getChat(chatIdFor(ALICE, BOB)), null);
    assert.deepEqual(await firstRows((h) => watchChatsForUser(ALICE, h)), []);
  });

  it("still delivers to an account that no longer exists", async () => {
    // The recipient's profile is never read on the way in: a chat outlives the
    // people in it, and the screens render a missing peer rather than failing.
    const sent = await sendMessage({ senderId: ALICE, recipientId: "deleted-user", text: "hello?" });
    assert.equal(sent.chatId, chatIdFor(ALICE, "deleted-user"));
    assert.equal((await listMessages(sent.chatId)).length, 1);
  });
});

describe("chats: unread counters", () => {
  beforeEach(() => store.clear());

  it("counts for the recipient and not the sender", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "one" });
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "two" });

    const chat = await getChat(chatIdFor(ALICE, BOB));
    assert.equal(unreadFor(chat, BOB), 2);
    assert.equal(unreadFor(chat, ALICE), 0);
  });

  it("clears the sender's own counter when they reply", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "one" });
    await sendMessage({ senderId: BOB, recipientId: ALICE, text: "reply" });

    const chat = await getChat(chatIdFor(ALICE, BOB));
    assert.equal(unreadFor(chat, BOB), 0);   // replying is having read it
    assert.equal(unreadFor(chat, ALICE), 1);
  });

  it("opening the thread clears one side only", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "one" });
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "two" });
    const chatId = chatIdFor(ALICE, BOB);

    await markChatRead({ chatId, userId: BOB });

    const chat = await getChat(chatId);
    assert.equal(unreadFor(chat, BOB), 0);
    // Alice's own count is untouched by Bob reading his copy.
    assert.equal(chat.unread[ALICE], 0);

    // …and the history is still there. Reading is not deleting.
    assert.equal((await listMessages(chatId)).length, 2);
  });

  it("reports nothing for a stranger, a missing map or a missing chat", () => {
    assert.equal(unreadFor(null, ALICE), 0);
    assert.equal(unreadFor({}, ALICE), 0);
    assert.equal(unreadFor({ unread: { [BOB]: 3 } }, ALICE), 0);
    assert.equal(unreadFor({ unread: { [ALICE]: -1 } }, ALICE), 0);
  });
});

describe("chats: ordering and membership", () => {
  beforeEach(() => store.clear());

  it("puts the most recently active conversation first", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "older" });
    await sendMessage({ senderId: ALICE, recipientId: CAROL, text: "newer" });

    // The stored stamps can land in the same millisecond under Node, so the
    // ordering is asserted on the field the query sorts by rather than on the
    // clock happening to tick between two writes.
    const rows = await firstRows((h) => watchChatsForUser(ALICE, h));
    assert.equal(rows.length, 2);
    assert.ok(rows[0].updatedAt >= rows[1].updatedAt);

    await new Promise((r) => setTimeout(r, 2));
    await sendMessage({ senderId: BOB, recipientId: ALICE, text: "brought back up" });

    const reordered = await firstRows((h) => watchChatsForUser(ALICE, h));
    assert.equal(reordered[0].id, chatIdFor(ALICE, BOB));
  });

  it("names the other person, and nobody for an outsider", async () => {
    await sendMessage({ senderId: ALICE, recipientId: BOB, text: "hello" });
    const chat = await getChat(chatIdFor(ALICE, BOB));

    assert.equal(otherMemberId(chat, ALICE), BOB);
    assert.equal(otherMemberId(chat, BOB), ALICE);
    assert.equal(otherMemberId(chat, CAROL), null);
    assert.equal(otherMemberId(null, ALICE), null);
  });
});
