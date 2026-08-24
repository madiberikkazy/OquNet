// An admin's invitation, on the data-layer side.
//
// The security half of this lives in firestore.rules.test.js, and that is where
// the load-bearing guarantees are: only an admin writes one, only the person it
// names can spend it, and spending it twice does not work. What is left here is
// the half a rule cannot express.
//
// Two things, and both are ordering or shape rather than permission:
//
//   · an invitation is born `approved`. That single field is what makes the
//     membership rule accept it, so a change that made it `pending` "for
//     consistency with the other request types" would produce an invitation
//     nobody can ever act on — and the failure would surface as a permission
//     error on somebody else's device;
//   · accepting writes membership *first* and stamps the invitation second. The
//     stamp is what stops a second use, and the membership write is authorised
//     by the invitation still reading `approved` — so the obvious order, tidy
//     up then act, revokes the permission the next line needs.

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
  acceptCommunityInvite, createCommunityInvite, createUserDoc, declineCommunityInvite,
  getRequestById, getUserById, listMessages, chatIdFor, sendMessage,
} = await import("../src/firebase/firestore.js");

const { SchemaError, normalizeCommunityInvite } = await import("../src/firebase/schema.js");

const ADMIN = "user-admin";
const GUEST = "user-guest";
const COMMUNITY = "community-1";

const invitePayload = (over = {}) => ({
  userId: GUEST,
  invitedBy: ADMIN,
  communityId: COMMUNITY,
  communityName: "One",
  invitedByName: "Admin",
  ...over,
});

beforeEach(() => {
  store.clear();
});

describe("the shape of an invitation", () => {
  it("is a request of its own type, already approved", () => {
    const doc = normalizeCommunityInvite(invitePayload());
    assert.equal(doc.type, "invite");
    // Load-bearing: `approvedJoinFor` in firestore.rules reads this exact value.
    assert.equal(doc.status, "approved");
    assert.equal(doc.userId, GUEST);
    assert.equal(doc.invitedBy, ADMIN);
    assert.equal(doc.communityId, COMMUNITY);
  });

  it("carries no book", () => {
    // A join costs one; an invitation does not, because the admin doing the
    // inviting has already made the judgement the fee exists to inform.
    const doc = normalizeCommunityInvite(invitePayload());
    assert.equal("book" in doc, false);
  });

  it("refuses an admin inviting themselves", () => {
    assert.throws(
      () => normalizeCommunityInvite(invitePayload({ userId: ADMIN })),
      SchemaError
    );
  });

  it("refuses one with nobody to invite, or no community to invite them to", () => {
    assert.throws(() => normalizeCommunityInvite(invitePayload({ userId: "" })), SchemaError);
    assert.throws(() => normalizeCommunityInvite(invitePayload({ communityId: "" })), SchemaError);
  });
});

describe("accepting one", () => {
  /** A member of nowhere, which is who an invitation usually reaches. */
  async function seedGuest() {
    await createUserDoc({
      id: GUEST, email: "guest@example.com", nickname: "guest", firstName: "Guest",
    });
  }

  it("puts the person in the community and spends the invitation", async () => {
    await seedGuest();
    const invite = await createCommunityInvite(invitePayload());

    await acceptCommunityInvite({
      userId: GUEST, requestId: invite.id, communityId: COMMUNITY,
    });

    const user = await getUserById(GUEST);
    assert.equal(user.communityId, COMMUNITY);
    // The id of the invitation is what the membership write cites as its
    // authority, so it has to be on the profile, not merely used and forgotten.
    assert.equal(user.joinRequestId, invite.id);

    const spent = await getRequestById(invite.id);
    // `accepted`, not `approved`: the verdict was the admin's and stays on the
    // document. This says the invitation has been used up.
    assert.equal(spent.status, "accepted");
  });

  it("declining marks it without moving anybody", async () => {
    await seedGuest();
    const invite = await createCommunityInvite(invitePayload());

    await declineCommunityInvite(invite.id);

    assert.equal((await getRequestById(invite.id)).status, "declined");
    assert.equal((await getUserById(GUEST)).communityId, null);
  });

  it("refuses to act on half an instruction", async () => {
    await assert.rejects(() => acceptCommunityInvite({ userId: GUEST, requestId: "r1" }));
    await assert.rejects(() => acceptCommunityInvite({ requestId: "r1", communityId: COMMUNITY }));
  });
});

describe("the message that carries it", () => {
  it("attaches the two ids the card is built from", async () => {
    await sendMessage({
      senderId: ADMIN, recipientId: GUEST, text: "Join us",
      invite: { inviteId: "req-1", communityId: COMMUNITY },
    });

    const [message] = await listMessages(chatIdFor(ADMIN, GUEST));
    assert.equal(message.inviteId, "req-1");
    assert.equal(message.communityId, COMMUNITY);
    // Still an ordinary message underneath — which is what lets the chats list,
    // the unread counter and the receipts carry on knowing nothing about
    // invitations.
    assert.equal(message.text, "Join us");
  });

  it("leaves an ordinary message with neither field", async () => {
    await sendMessage({ senderId: ADMIN, recipientId: GUEST, text: "hello" });

    const [message] = await listMessages(chatIdFor(ADMIN, GUEST));
    // Absent, not null: the rules check the key set, and a field that is always
    // present would have to be permitted on every message anybody sends.
    assert.equal("inviteId" in message, false);
    assert.equal("communityId" in message, false);
  });

  it("refuses half an invitation", async () => {
    await assert.rejects(() => sendMessage({
      senderId: ADMIN, recipientId: GUEST, text: "Join us",
      invite: { inviteId: "req-1" },
    }));
  });
});
