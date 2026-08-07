// Rules unit tests — run against the Firestore emulator:
//
//   npm run test:rules
//
// These exercise the authorization boundary, not the app. Every assertion is a
// real read/write through the client SDK against the real rules engine, so a
// passing run means the rule actually holds, not that it looks like it should.

import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

const PROJECT_ID = "demo-oqunet-rules";

// ── Fixture cast ─────────────────────────────────────────────────────────────
// Two communities so every "cross-community" assertion has somewhere to fail.
const C1 = "community-1";
const C2 = "community-2";

const ADMIN_A = "admin-a";   // admin of C1
const MEMBER_A = "member-a"; // plain member of C1, owns BOOK_1
const MEMBER_A2 = "member-a2"; // second plain member of C1
const ADMIN_B = "admin-b";   // admin of C2
const MEMBER_B = "member-b"; // plain member of C2
const DRIFTER = "drifter";   // signed in, no community

const BOOK_1 = "book-1"; // in C1, owned+held by MEMBER_A, available
const BOOK_2 = "book-2"; // in C2

let testEnv;

/** An authenticated Firestore handle for `uid`. */
const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync("firestore.rules", "utf8"),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "communities", C1), {
      nickname: "one", name: "One", ownerId: ADMIN_A, memberIds: [ADMIN_A],
      isPrivate: false, createdAt: Date.now(),
    });
    await setDoc(doc(db, "communities", C2), {
      nickname: "two", name: "Two", ownerId: ADMIN_B, memberIds: [ADMIN_B],
      isPrivate: false, createdAt: Date.now(),
    });

    const user = (id, role, communityId) => setDoc(doc(db, "users", id), {
      id, email: `${id}@example.com`, nickname: id, role, communityId,
      firstName: "F", lastName: "L", createdAt: Date.now(),
    });
    await user(ADMIN_A, "admin", C1);
    await user(MEMBER_A, "user", C1);
    await user(MEMBER_A2, "user", C1);
    await user(ADMIN_B, "admin", C2);
    await user(MEMBER_B, "user", C2);
    await user(DRIFTER, "user", null);

    await setDoc(doc(db, "books", BOOK_1), {
      name: "Abai Joly", author: "Mukhtar Auezov", genre: "novel",
      communityId: C1, ownerId: MEMBER_A, holderId: MEMBER_A,
      status: "available", borrowerId: null, createdAt: Date.now(),
      rating: 0, ratingSum: 0, ratingCount: 0,
    });
    await setDoc(doc(db, "books", BOOK_2), {
      name: "Other", author: "Someone", genre: "novel",
      communityId: C2, ownerId: MEMBER_B, holderId: MEMBER_B,
      status: "available", borrowerId: null, createdAt: Date.now(),
    });
  });
});

/**
 * A valid book-create payload, shaped exactly like firestore.createBook does —
 * which now means whatever schema.normalizeNewBook returns, plus the
 * `createdAt` createOne appends. Keep the two in step: this fixture is what
 * asserts the schema and the rules still agree about a new book.
 */
function newBookPayload(communityId, ownerId) {
  return {
    name: "New Book", author: "New Author", genre: "novel", genres: ["novel"],
    description: "", coverUrl: "", year: 2020, maxDays: 14,
    communityId, ownerId, holderId: ownerId, status: "available",
    borrowerId: null, rating: 0, ratingSum: 0, ratingCount: 0,
    createdAt: serverTimestamp(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("anonymous access", () => {
  it("cannot read a book", async () => {
    await assertFails(getDoc(doc(anon(), "books", BOOK_1)));
  });

  it("cannot read a user profile", async () => {
    await assertFails(getDoc(doc(anon(), "users", MEMBER_A)));
  });

  it("cannot list users (no account-enumeration oracle)", async () => {
    const q = query(collection(anon(), "users"), where("email", "==", "member-a@example.com"));
    await assertFails(getDocs(q));
  });

  it("cannot write anything", async () => {
    await assertFails(setDoc(doc(anon(), "books", "hacked"), newBookPayload(C1, MEMBER_A)));
    await assertFails(updateDoc(doc(anon(), "users", MEMBER_A), { role: "admin" }));
  });

  it("CAN read a usernames entry — login-by-nickname needs it pre-auth", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "usernames", "member-a"), {
        uid: MEMBER_A, email: "member-a@example.com",
      });
    });
    await assertSucceeds(getDoc(doc(anon(), "usernames", "member-a")));
  });

  it("cannot enumerate the usernames index", async () => {
    await assertFails(getDocs(collection(anon(), "usernames")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("cross-community reads", () => {
  it("a member may list their own community's books", async () => {
    const q = query(collection(as(MEMBER_A), "books"), where("communityId", "==", C1));
    await assertSucceeds(getDocs(q));
  });

  it("a member may NOT list another community's books", async () => {
    const q = query(collection(as(MEMBER_B), "books"), where("communityId", "==", C1));
    await assertFails(getDocs(q));
  });

  it("an unfiltered book list is denied outright", async () => {
    await assertFails(getDocs(collection(as(MEMBER_A), "books")));
  });

  it("a member may NOT point-read a book from another community", async () => {
    await assertFails(getDoc(doc(as(MEMBER_B), "books", BOOK_1)));
  });

  it("a member may point-read a book from their own community", async () => {
    await assertSucceeds(getDoc(doc(as(MEMBER_A), "books", BOOK_1)));
  });

  it("posts are community-scoped the same way", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "posts", "p1"), {
        communityId: C1, authorId: ADMIN_A, title: "Hi", body: "", createdAt: Date.now(),
      });
    });
    await assertSucceeds(
      getDocs(query(collection(as(MEMBER_A), "posts"), where("communityId", "==", C1))));
    await assertFails(
      getDocs(query(collection(as(MEMBER_B), "posts"), where("communityId", "==", C1))));
    await assertFails(getDocs(collection(as(MEMBER_A), "posts")));
  });

  it("profiles stay globally readable — Home search depends on it", async () => {
    await assertSucceeds(getDoc(doc(as(MEMBER_B), "users", MEMBER_A)));
    await assertSucceeds(getDocs(collection(as(MEMBER_B), "users")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("books: create", () => {
  it("a community admin may create a book", async () => {
    await assertSucceeds(
      setDoc(doc(as(ADMIN_A), "books", "fresh"), newBookPayload(C1, MEMBER_A)));
  });

  it("a plain member may NOT create a book", async () => {
    await assertFails(
      setDoc(doc(as(MEMBER_A), "books", "fresh"), newBookPayload(C1, MEMBER_A)));
  });

  it("an admin of another community may NOT create a book here", async () => {
    await assertFails(
      setDoc(doc(as(ADMIN_B), "books", "fresh"), newBookPayload(C1, MEMBER_A)));
  });

  it("rejects a book missing a required field", async () => {
    const { author, ...noAuthor } = newBookPayload(C1, MEMBER_A);
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh"), noAuthor));

    const { genre, ...noGenre } = newBookPayload(C1, MEMBER_A);
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh2"), noGenre));
  });

  it("rejects a book whose holder is not its owner", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh"), {
      ...newBookPayload(C1, MEMBER_A), holderId: MEMBER_A2,
    }));
  });

  it("rejects a book that starts out unavailable", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh"), {
      ...newBookPayload(C1, MEMBER_A), status: "unavailable",
    }));
  });

  it("rejects a client-forged createdAt", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh"), {
      ...newBookPayload(C1, MEMBER_A), createdAt: 0,
    }));
  });

  it("rejects an empty name", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "books", "fresh"), {
      ...newBookPayload(C1, MEMBER_A), name: "",
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("books: ownerId and communityId immutability", () => {
  it("a member may NOT rewrite ownerId", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), { ownerId: MEMBER_A2 }));
  });

  it("a member may NOT smuggle ownerId along with a handoff", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "unavailable", borrowerId: MEMBER_A2, holderId: MEMBER_A2,
      ownerId: MEMBER_A2,
    }));
  });

  it("the community admin MAY reassign ownerId (reassignBookOwner)", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "books", BOOK_1), { ownerId: MEMBER_A2 }));
  });

  it("nobody may move a book to another community — not even the admin", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "books", BOOK_1), { communityId: C2 }));
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), { communityId: C2 }));
  });

  it("nobody may rewrite createdAt", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "books", BOOK_1), { createdAt: 0 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("books: holder transitions", () => {
  const take = (uid) => updateDoc(doc(as(uid), "books", BOOK_1), {
    status: "unavailable", borrowerId: uid, holderId: uid,
  });

  it("a community member may collect the book (transferBookHolder)", async () => {
    await assertSucceeds(take(MEMBER_A2));
  });

  it("an outsider may NOT collect the book", async () => {
    await assertFails(take(MEMBER_B));
    await assertFails(take(DRIFTER));
  });

  it("a member may NOT hand the book to somebody else", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "unavailable", borrowerId: MEMBER_B, holderId: MEMBER_B,
    }));
  });

  it("the reader may release the book but keeps holding it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "unavailable", borrowerId: MEMBER_A2, holderId: MEMBER_A2,
      });
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A2,
    }));
  });

  it("a non-holder may NOT release the book", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "unavailable", borrowerId: MEMBER_A2, holderId: MEMBER_A2,
      });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A,
    }));
  });

  it("the holder may send the book home to its owner", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "available", borrowerId: null, holderId: MEMBER_A2,
      });
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A,
    }));
  });

  it("a member may NOT invent an arbitrary status", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), { status: "lost" }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("books: rating rollup and delete", () => {
  it("any member may refresh the denormalised rating counters", async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      rating: 4.5, ratingSum: 9, ratingCount: 2,
    }));
  });

  it("a rollup may not carry anything else along", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      rating: 4.5, ratingSum: 9, ratingCount: 2, status: "unavailable",
    }));
  });

  it("an outsider may not touch the counters", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_B), "books", BOOK_1), {
      rating: 4.5, ratingSum: 9, ratingCount: 2,
    }));
  });

  it("the owner may delete their own book (leaving the community)", async () => {
    await assertSucceeds(deleteDoc(doc(as(MEMBER_A), "books", BOOK_1)));
  });

  it("the community admin may delete any book in their community", async () => {
    await assertSucceeds(deleteDoc(doc(as(ADMIN_A), "books", BOOK_1)));
  });

  it("a non-owner member may NOT delete somebody else's book", async () => {
    await assertFails(deleteDoc(doc(as(MEMBER_A2), "books", BOOK_1)));
  });

  it("an admin may NOT delete a book in another community", async () => {
    await assertFails(deleteDoc(doc(as(ADMIN_A), "books", BOOK_2)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("users: self-promotion", () => {
  it("a member may NOT promote themselves to admin", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), { role: "admin" }));
  });

  it("a member may NOT promote themselves while joining a community they don't own", async () => {
    await assertFails(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      role: "admin", communityId: C1,
    }));
  });

  it("an admin may NOT promote somebody else", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "users", MEMBER_A), { role: "admin" }));
  });

  it("the founder of a community MAY take the admin role for it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "communities", "c-new"), {
        nickname: "new", name: "New", ownerId: DRIFTER, memberIds: [DRIFTER],
        createdAt: Date.now(),
      });
    });
    await assertSucceeds(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      role: "admin", communityId: "c-new",
    }));
  });

  it("an admin may always stand back down", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "users", ADMIN_A), { role: "user" }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("users: membership and profile writes", () => {
  it("a user may not write somebody else's profile", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A2), { firstName: "X" }));
  });

  it("a user may edit their own profile", async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      firstName: "New", phone: "+7 700 000 00 00", savedBookIds: [BOOK_1],
    }));
  });

  it("a user may not rewrite their own email", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      email: "somebody-else@example.com",
    }));
  });

  // The email moves in Firebase Auth first (verifyBeforeUpdateEmail, confirmed
  // from the new inbox). The profile is then allowed to catch up — but only to
  // the address the caller's own token already carries.
  it("a user may sync their profile email to the address on their account", async () => {
    const withToken = testEnv
      .authenticatedContext(MEMBER_A, { email: "moved@example.com" })
      .firestore();
    await assertSucceeds(updateDoc(doc(withToken, "users", MEMBER_A), {
      email: "moved@example.com",
    }));
  });

  it("a user may not set an email their account does not have", async () => {
    const withToken = testEnv
      .authenticatedContext(MEMBER_A, { email: "moved@example.com" })
      .firestore();
    await assertFails(updateDoc(doc(withToken, "users", MEMBER_A), {
      email: "someone-elses@example.com",
    }));
  });

  it("a user may always leave their community", async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), { communityId: null }));
  });

  it("a user may NOT join a community without an approved request", async () => {
    await assertFails(updateDoc(doc(as(DRIFTER), "users", DRIFTER), { communityId: C1 }));
  });

  it("a user may NOT join by pointing at somebody else's approved request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r-other"), {
        type: "join", status: "approved", userId: MEMBER_A2, communityId: C1,
      });
    });
    await assertFails(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      communityId: C1, joinRequestId: "r-other",
    }));
  });

  it("a user may NOT join on a still-pending request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r-mine"), {
        type: "join", status: "pending", userId: DRIFTER, communityId: C1,
      });
    });
    await assertFails(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      communityId: C1, joinRequestId: "r-mine",
    }));
  });

  it("a user MAY join on their own approved request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r-mine"), {
        type: "join", status: "approved", userId: DRIFTER, communityId: C1,
      });
    });
    await assertSucceeds(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      communityId: C1, joinRequestId: "r-mine",
    }));
  });

  it("an admin may eject a member of their own community", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "users", MEMBER_A), { communityId: null }));
  });

  it("an admin may NOT eject a member of another community", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "users", MEMBER_B), { communityId: null }));
  });

  it("an admin may NOT change anything else about a member while ejecting", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "users", MEMBER_A), {
      communityId: null, nickname: "renamed",
    }));
  });

  it("nobody may delete a user document", async () => {
    await assertFails(deleteDoc(doc(as(MEMBER_A), "users", MEMBER_A)));
  });

  it("registration writes a plain, community-less profile", async () => {
    await assertSucceeds(setDoc(doc(as("newbie"), "users", "newbie"), {
      id: "newbie", email: "newbie@example.com", nickname: "newbie",
      role: "user", communityId: null, createdAt: serverTimestamp(),
    }));
  });

  it("registration may not mint an admin", async () => {
    await assertFails(setDoc(doc(as("newbie"), "users", "newbie"), {
      id: "newbie", email: "newbie@example.com", nickname: "newbie",
      role: "admin", communityId: null, createdAt: serverTimestamp(),
    }));
  });

  it("registration may not write a plaintext password", async () => {
    await assertFails(setDoc(doc(as("newbie"), "users", "newbie"), {
      id: "newbie", email: "newbie@example.com", nickname: "newbie",
      role: "user", communityId: null, createdAt: serverTimestamp(),
      password: "hunter2",
    }));
  });

  it("a user may not create somebody else's profile", async () => {
    await assertFails(setDoc(doc(as("newbie"), "users", "someone-else"), {
      id: "someone-else", email: "x@example.com", nickname: "x",
      role: "user", communityId: null, createdAt: serverTimestamp(),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("communities", () => {
  it("any signed-in user may browse communities (discovery)", async () => {
    await assertSucceeds(getDocs(collection(as(DRIFTER), "communities")));
    await assertSucceeds(getDoc(doc(as(MEMBER_B), "communities", C1)));
  });

  it("a user may create a community they own", async () => {
    await assertSucceeds(setDoc(doc(as(DRIFTER), "communities", "c-new"), {
      nickname: "new", name: "New", ownerId: DRIFTER, memberIds: [DRIFTER],
      isPrivate: false, createdAt: serverTimestamp(),
    }));
  });

  it("a user may NOT create a community owned by somebody else", async () => {
    await assertFails(setDoc(doc(as(DRIFTER), "communities", "c-new"), {
      nickname: "new", name: "New", ownerId: ADMIN_A, memberIds: [ADMIN_A],
      createdAt: serverTimestamp(),
    }));
  });

  it("only the owner may edit a community", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "communities", C1), { name: "Renamed" }));
    await assertFails(updateDoc(doc(as(MEMBER_A), "communities", C1), { name: "Renamed" }));
  });

  it("ownership cannot be transferred, and nothing can be deleted", async () => {
    await assertFails(updateDoc(doc(as(ADMIN_A), "communities", C1), { ownerId: MEMBER_A }));
    await assertFails(deleteDoc(doc(as(ADMIN_A), "communities", C1)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ratings", () => {
  const payload = (bookId, userId) => ({
    bookId, userId, value: 4, review: "Good", authorName: "F L", photoURL: "",
  });

  it("a user may write their own rating at the derived id", async () => {
    await assertSucceeds(setDoc(
      doc(as(MEMBER_A), "ratings", `${BOOK_1}__${MEMBER_A}`), payload(BOOK_1, MEMBER_A)));
  });

  it("a user may NOT write a rating at an id that isn't theirs", async () => {
    await assertFails(setDoc(
      doc(as(MEMBER_A), "ratings", `${BOOK_1}__${MEMBER_A2}`), payload(BOOK_1, MEMBER_A2)));
  });

  it("a user may NOT stuff the ballot box with a random id", async () => {
    await assertFails(setDoc(
      doc(as(MEMBER_A), "ratings", "random-id-1"), payload(BOOK_1, MEMBER_A)));
  });

  it("a user may NOT claim somebody else wrote their rating", async () => {
    await assertFails(setDoc(
      doc(as(MEMBER_A), "ratings", `${BOOK_1}__${MEMBER_A}`), payload(BOOK_1, MEMBER_A2)));
  });

  it("rejects out-of-range stars", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "ratings", `${BOOK_1}__${MEMBER_A}`),
      { ...payload(BOOK_1, MEMBER_A), value: 9 }));
    await assertFails(setDoc(doc(as(MEMBER_A), "ratings", `${BOOK_1}__${MEMBER_A}`),
      { ...payload(BOOK_1, MEMBER_A), value: 0 }));
  });

  it("a user may delete only their own rating", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "ratings", "legacy-mine"), payload(BOOK_1, MEMBER_A));
      await setDoc(doc(db, "ratings", "legacy-theirs"), payload(BOOK_1, MEMBER_A2));
    });
    await assertSucceeds(deleteDoc(doc(as(MEMBER_A), "ratings", "legacy-mine")));
    await assertFails(deleteDoc(doc(as(MEMBER_A), "ratings", "legacy-theirs")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("notifications", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "notifications", "n1"), {
        recipientId: MEMBER_A, title: "Code inside", body: "",
        read: false, type: "borrow-request", pickupCode: "1234",
        createdAt: Date.now(),
      });
    });
  });

  it("only the recipient may read a notification", async () => {
    await assertSucceeds(getDoc(doc(as(MEMBER_A), "notifications", "n1")));
    await assertFails(getDoc(doc(as(MEMBER_A2), "notifications", "n1")));
  });

  it("a user may only list their own inbox", async () => {
    await assertSucceeds(getDocs(query(
      collection(as(MEMBER_A), "notifications"), where("recipientId", "==", MEMBER_A))));
    await assertFails(getDocs(query(
      collection(as(MEMBER_A2), "notifications"), where("recipientId", "==", MEMBER_A))));
    await assertFails(getDocs(collection(as(MEMBER_A), "notifications")));
  });

  it("any signed-in user may notify anyone — asking for a book requires it", async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER_A2), "notifications", "n2"), {
      recipientId: MEMBER_A, title: "May I borrow this?", body: "",
      read: false, type: "borrow-request", createdAt: serverTimestamp(),
    }));
  });

  it("a sender may not forge somebody else's senderId", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A2), "notifications", "n2"), {
      recipientId: MEMBER_A, title: "Spoofed", body: "",
      read: false, senderId: ADMIN_A, createdAt: serverTimestamp(),
    }));
  });

  it("a notification cannot be created already-read", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A2), "notifications", "n2"), {
      recipientId: MEMBER_A, title: "Sneaky", body: "",
      read: true, createdAt: serverTimestamp(),
    }));
  });

  it("only the recipient may mark read or delete", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A2), "notifications", "n1"), { read: true }));
    await assertFails(deleteDoc(doc(as(MEMBER_A2), "notifications", "n1")));
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "notifications", "n1"), { read: true }));
    await assertSucceeds(deleteDoc(doc(as(MEMBER_A), "notifications", "n1")));
  });

  it("the recipient may not re-point a notification at somebody else", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "notifications", "n1"), {
      recipientId: MEMBER_A2,
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("requests", () => {
  it("a user may open a join request for themselves", async () => {
    await assertSucceeds(setDoc(doc(as(DRIFTER), "requests", "r1"), {
      type: "join", status: "pending", userId: DRIFTER, userNickname: "drifter",
      communityId: C1, createdAt: serverTimestamp(),
    }));
  });

  it("a user may NOT open a request on somebody else's behalf", async () => {
    await assertFails(setDoc(doc(as(DRIFTER), "requests", "r1"), {
      type: "join", status: "pending", userId: MEMBER_A, communityId: C1,
      createdAt: serverTimestamp(),
    }));
  });

  it("a request may not be created pre-approved", async () => {
    await assertFails(setDoc(doc(as(DRIFTER), "requests", "r1"), {
      type: "join", status: "approved", userId: DRIFTER, communityId: C1,
      createdAt: serverTimestamp(),
    }));
  });

  it("the community admin may approve a join request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r1"), {
        type: "join", status: "pending", userId: DRIFTER, communityId: C1,
      });
    });
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "requests", "r1"), { status: "approved" }));
  });

  it("another community's admin may NOT approve it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r1"), {
        type: "join", status: "pending", userId: DRIFTER, communityId: C1,
      });
    });
    await assertFails(updateDoc(doc(as(ADMIN_B), "requests", "r1"), { status: "approved" }));
  });

  it("the requester may NOT approve their own request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "r1"), {
        type: "join", status: "pending", userId: DRIFTER, communityId: C1,
      });
    });
    // Allowed to touch it (they can cancel), but not to re-point it.
    await assertFails(updateDoc(doc(as(DRIFTER), "requests", "r1"), { userId: MEMBER_A }));
  });

  it("an admin may list their own community's requests", async () => {
    await assertSucceeds(getDocs(query(
      collection(as(ADMIN_A), "requests"),
      where("communityId", "==", C1), where("type", "==", "join"))));
  });

  it("an admin may NOT list another community's requests", async () => {
    await assertFails(getDocs(query(
      collection(as(ADMIN_A), "requests"),
      where("communityId", "==", C2), where("type", "==", "join"))));
  });

  it("a user may list their own pickup requests", async () => {
    await assertSucceeds(getDocs(query(
      collection(as(MEMBER_A), "requests"),
      where("requesterId", "==", MEMBER_A),
      where("type", "==", "pickup"), where("status", "==", "pending"))));
  });

  it("a user may NOT list somebody else's pickup requests", async () => {
    await assertFails(getDocs(query(
      collection(as(MEMBER_A), "requests"), where("requesterId", "==", MEMBER_A2))));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("borrowings", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "borrowings", "b1"), {
        bookId: BOOK_1, bookName: "Abai Joly", borrowerId: MEMBER_A2,
        ownerId: MEMBER_A, communityId: C1, status: "active",
        startDate: Date.now(), returnDate: Date.now() + 86400000,
        pickupCode: "9999", createdAt: Date.now(),
      });
    });
  });

  it("a user may open a loan for themselves", async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER_A), "borrowings", "b2"), {
      bookId: BOOK_1, borrowerId: MEMBER_A, ownerId: MEMBER_A, communityId: C1,
      status: "active", startDate: Date.now(), createdAt: serverTimestamp(),
    }));
  });

  it("a user may NOT open a loan in somebody else's name", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "borrowings", "b2"), {
      bookId: BOOK_1, borrowerId: MEMBER_A2, ownerId: MEMBER_A, communityId: C1,
      status: "active", createdAt: serverTimestamp(),
    }));
  });

  it("the borrower may finish their own loan", async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER_A2), "borrowings", "b1"), {
      status: "completed", returnDate: Date.now(), rating: 4,
    }));
  });

  it("the next reader may close the previous loan (transferBookHolder)", async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "borrowings", "b1"), {
      status: "completed", returnDate: Date.now(),
    }));
  });

  it("a stranger may NOT reopen a finished loan", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "borrowings", "b1"), { status: "completed" });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A), "borrowings", "b1"), { status: "active" }));
  });

  it("nobody may re-point a loan at a different borrower or book", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A2), "borrowings", "b1"), { borrowerId: MEMBER_A }));
    await assertFails(updateDoc(doc(as(MEMBER_A2), "borrowings", "b1"), { bookId: BOOK_2 }));
  });

  it("loans cannot be deleted", async () => {
    await assertFails(deleteDoc(doc(as(MEMBER_A2), "borrowings", "b1")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("posts", () => {
  it("the community admin may publish a post", async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C1, authorId: ADMIN_A, authorName: "F L",
      title: "Hello", body: "text", createdAt: serverTimestamp(),
    }));
  });

  it("a plain member may NOT publish a post", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "posts", "p1"), {
      communityId: C1, authorId: MEMBER_A, title: "Hello", body: "",
      createdAt: serverTimestamp(),
    }));
  });

  it("an admin may NOT publish into another community", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C2, authorId: ADMIN_A, title: "Hello", body: "",
      createdAt: serverTimestamp(),
    }));
  });

  it("an admin may NOT forge somebody else's authorship", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C1, authorId: MEMBER_A, title: "Hello", body: "",
      createdAt: serverTimestamp(),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("usernames index", () => {
  it("a user may claim a nickname for themselves", async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER_A), "usernames", "abai"), {
      uid: MEMBER_A, email: "member-a@example.com", createdAt: serverTimestamp(),
    }));
  });

  it("a user may NOT claim a nickname for somebody else", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "usernames", "abai"), {
      uid: MEMBER_A2, email: "member-a2@example.com", createdAt: serverTimestamp(),
    }));
  });

  it("the index holds nothing but uid, email and createdAt", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "usernames", "abai"), {
      uid: MEMBER_A, email: "member-a@example.com", phone: "+7 700 000 00 00",
      createdAt: serverTimestamp(),
    }));
  });

  it("a claimed nickname cannot be overwritten", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "usernames", "abai"), {
        uid: MEMBER_A, email: "member-a@example.com",
      });
    });
    await assertFails(setDoc(doc(as(MEMBER_A2), "usernames", "abai"), {
      uid: MEMBER_A2, email: "member-a2@example.com", createdAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(as(MEMBER_A), "usernames", "abai"), {
      email: "changed@example.com",
    }));
  });

  it("only the holder may release a nickname", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "usernames", "abai"), {
        uid: MEMBER_A, email: "member-a@example.com",
      });
    });
    await assertFails(deleteDoc(doc(as(MEMBER_A2), "usernames", "abai")));
    await assertSucceeds(deleteDoc(doc(as(MEMBER_A), "usernames", "abai")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rules above are only correct if they accept what the app actually sends.
// These replay the real write sequences, field for field, in the real order.
describe("the app's own write sequences still work", () => {
  it("CreateCommunity: create the community, then take its admin role", async () => {
    const db = as(DRIFTER);
    await assertSucceeds(setDoc(doc(db, "communities", "c-founded"), {
      nickname: "founded", name: "Founded", isPrivate: false,
      notificationsEnabled: true, photoURL: "",
      ownerId: DRIFTER, memberIds: [DRIFTER], createdAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "users", DRIFTER), {
      communityId: "c-founded", role: "admin",
    }));
  });

  it("AddBook: the admin's exact payload is accepted", async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN_A), "books", "added"), {
      name: "Qan men Ter", author: "Abdizhamil Nurpeisov", description: "",
      coverUrl: "", year: 1970, maxDays: 14, genres: ["novel"],
      ownerId: MEMBER_A, holderId: MEMBER_A, genre: "novel",
      communityId: C1, status: "available", createdAt: serverTimestamp(),
    }));
  });

  it("PickupBook: close the old loan, open a new one, move the holder", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await updateDoc(doc(db, "books", BOOK_1), {
        status: "unavailable", borrowerId: MEMBER_A, holderId: MEMBER_A,
      });
      await setDoc(doc(db, "borrowings", "old"), {
        bookId: BOOK_1, borrowerId: MEMBER_A, ownerId: MEMBER_A,
        communityId: C1, status: "active", pickupCode: "1111",
      });
      await setDoc(doc(db, "requests", "pr"), {
        type: "pickup", status: "pending", bookId: BOOK_1,
        requesterId: MEMBER_A2, loanDays: 7, pickupCode: "2222",
      });
    });

    const db = as(MEMBER_A2);
    await assertSucceeds(updateDoc(doc(db, "borrowings", "old"), {
      status: "completed", returnDate: Date.now(),
    }));
    await assertSucceeds(setDoc(doc(db, "borrowings", "new"), {
      bookName: "Abai Joly", communityId: C1, startDate: Date.now(),
      returnDate: Date.now() + 604800000, pickupCode: "3333",
      bookId: BOOK_1, borrowerId: MEMBER_A2, ownerId: MEMBER_A,
      status: "active", createdAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "books", BOOK_1), {
      status: "unavailable", borrowerId: MEMBER_A2, holderId: MEMBER_A2,
    }));
    await assertSucceeds(updateDoc(doc(db, "requests", "pr"), { status: "fulfilled" }));
  });

  it("submitRating: write the rating, then roll it up onto the book", async () => {
    const db = as(MEMBER_A2);
    await assertSucceeds(setDoc(doc(db, "ratings", `${BOOK_1}__${MEMBER_A2}`), {
      bookId: BOOK_1, userId: MEMBER_A2, value: 5, stars: 5,
      review: "Wonderful", authorName: "F L", photoURL: "",
      createdAt: Date.now(), updatedAt: serverTimestamp(),
    }, { merge: true }));
    await assertSucceeds(updateDoc(doc(db, "books", BOOK_1), {
      rating: 5, ratingSum: 5, ratingCount: 1,
    }));
  });

  it("LeaveCommunity: delete your own books, then drop your membership", async () => {
    const db = as(MEMBER_A);
    await assertSucceeds(deleteDoc(doc(db, "books", BOOK_1)));
    await assertSucceeds(updateDoc(doc(db, "users", MEMBER_A), { communityId: null }));
  });

  it("Settings rename: claim the new nickname, save, release the old one", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "usernames", "member-a"), {
        uid: MEMBER_A, email: "member-a@example.com",
      });
    });
    const db = as(MEMBER_A);
    await assertSucceeds(setDoc(doc(db, "usernames", "abai2026"), {
      uid: MEMBER_A, email: "member-a@example.com", createdAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(db, "users", MEMBER_A), {
      firstName: "F", lastName: "L", nickname: "abai2026",
      phone: "+7 700 000 00 00", address: "Somewhere 5", photoURL: "",
    }));
    await assertSucceeds(deleteDoc(doc(db, "usernames", "member-a")));
  });

  it("AdminNotification: approve a join request, then the member accepts it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "jr"), {
        type: "join", status: "pending", userId: DRIFTER,
        userNickname: "drifter", communityId: C1,
      });
    });
    // Admin side.
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "requests", "jr"), { status: "approved" }));
    await assertSucceeds(setDoc(doc(as(ADMIN_A), "notifications", "n-approved"), {
      recipientId: DRIFTER, title: "Approved", body: "", read: false,
      type: "join-approved", requestId: "jr", communityId: C1,
      communityName: "One", confirmed: "pending", createdAt: serverTimestamp(),
    }));
    // Member side — the write that actually grants membership.
    await assertSucceeds(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      communityId: C1, joinRequestId: "jr",
    }));
  });

  it("AdminMembers: eject a member", async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "users", MEMBER_A), { communityId: null }));
  });

  it("OwnedBooks: the holder sends a book home and tells its owner", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), { holderId: MEMBER_A2 });
    });
    const db = as(MEMBER_A2);
    await assertSucceeds(updateDoc(doc(db, "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A,
    }));
    await assertSucceeds(setDoc(doc(db, "notifications", "n-home"), {
      recipientId: MEMBER_A, title: "Returned", body: "", read: false,
      type: "book-returned-to-owner", bookId: BOOK_1, bookName: "Abai Joly",
      createdAt: serverTimestamp(),
    }));
  });

  it("registration: profile then username claim", async () => {
    const db = as("newbie");
    await assertSucceeds(setDoc(doc(db, "users", "newbie"), {
      id: "newbie", email: "newbie@example.com", nickname: "newbie",
      firstName: "N", lastName: "B", phone: "", address: "",
      notificationsEnabled: true, photoURL: "", role: "user",
      communityId: null, createdAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(db, "usernames", "newbie"), {
      uid: "newbie", email: "newbie@example.com", createdAt: serverTimestamp(),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("collections with no rule at all", () => {
  it("are unreachable", async () => {
    await assertFails(getDoc(doc(as(ADMIN_A), "reviews", "anything")));
    await assertFails(setDoc(doc(as(ADMIN_A), "reviews", "anything"), { x: 1 }));
    await assertFails(setDoc(doc(as(ADMIN_A), "secrets", "anything"), { x: 1 }));
  });
});
