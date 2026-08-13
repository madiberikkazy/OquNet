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

  it("a bystander may NOT release somebody else's read", async () => {
    // The guarantee this protects: a member's open book page cannot write
    // another member's holder. The *owner* is a separate case — see the return
    // lanes below, where taking your own book back is the whole point — so the
    // reader here is ADMIN_A, leaving MEMBER_A2 neither owner nor holder.
    // (ADMIN_A could write it either way: an admin may edit their community's
    // books outright, which is bookAdminEdit's business, not a handoff's.)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "unavailable", borrowerId: ADMIN_A, holderId: ADMIN_A,
      });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: ADMIN_A,
    }));
    await assertFails(updateDoc(doc(as(MEMBER_B), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: ADMIN_A,
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

// The three lanes a member on their way out of a community needs: taking their
// own copy off the shelf while they arrange to collect it, putting it back if
// they change their mind, and receiving it. See utils/bookReturn.js.
describe("books: an owner collecting their own copy", () => {
  /** Park BOOK_1 on MEMBER_A2's shelf, free (the usual case) or on loan. */
  async function withHolder({ onLoan = false } = {}) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: onLoan ? "unavailable" : "available",
        borrowerId: onLoan ? MEMBER_A2 : null,
        holderId: MEMBER_A2,
      });
    });
  }

  it("the owner may reserve their copy, leaving it where it is", async () => {
    await withHolder();
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "unavailable", borrowerId: null,
    }));
  });

  it("nobody else may reserve it", async () => {
    // ADMIN_A is left out on purpose: an admin may edit any book in their own
    // community (bookAdminEdit), which is a different power from this one.
    await withHolder();
    for (const uid of [MEMBER_A2, MEMBER_B, DRIFTER]) {
      await assertFails(updateDoc(doc(as(uid), "books", BOOK_1), {
        status: "unavailable", borrowerId: null,
      }));
    }
  });

  it("a reservation may not smuggle the book somewhere else", async () => {
    await withHolder();
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "unavailable", borrowerId: null, holderId: MEMBER_A,
    }));
  });

  it("the owner may not reserve a copy that is already in their hands", async () => {
    // BOOK_1 starts out owned and held by MEMBER_A. Marking it occupied would
    // only hide a book the community is owed.
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "unavailable", borrowerId: null,
    }));
  });

  it("the owner may put a reserved copy back on the shelf", async () => {
    await withHolder();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "unavailable", borrowerId: null,
      });
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null,
    }));
  });

  it("but may NOT declare a book somebody is reading to be free", async () => {
    await withHolder({ onLoan: true });
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null,
    }));
  });

  it("the owner may take the copy back — free or mid-loan", async () => {
    await withHolder();
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A,
    }));

    await withHolder({ onLoan: true });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A,
    }));
  });

  it("nobody may use that lane to take a book they do not own", async () => {
    // The copy sits with ADMIN_A, so MEMBER_A2 is a plain member who neither
    // owns nor holds it — the case this lane must not open up.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "available", borrowerId: null, holderId: ADMIN_A,
      });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A2), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A2,
    }));
    await assertFails(updateDoc(doc(as(MEMBER_B), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_B,
    }));
  });

  it("no lane lets the owner keep ownership out of the write", async () => {
    await withHolder();
    await assertFails(updateDoc(doc(as(MEMBER_A), "books", BOOK_1), {
      status: "available", borrowerId: null, holderId: MEMBER_A, ownerId: MEMBER_A2,
    }));
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
      firstName: "New", address: "Astana, Satpayev 11", savedBookIds: [BOOK_1],
    }));
  });

  // ── the phone number, which is the one field a stranger acts on ──
  //
  // It is handed to somebody about to travel to meet its owner, so it may not
  // be typed in. It used to be provable in the ID token (Firebase SMS); it is
  // now proven in a WhatsApp or Telegram conversation our server sees and the
  // rules cannot. So the rule is the strongest one left: no client writes a
  // number, ever. The webhook does it with the Admin SDK, which never passes
  // through here.
  const PROVEN = "+77770000000";

  it("a user may NOT write a phone number, however they ask", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      phone: PROVEN, phoneVerifiedAt: Date.now(),
    }));
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), { phone: PROVEN }));
  });

  it("nor claim a verification for a number they never wrote", async () => {
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      phoneVerifiedAt: Date.now(),
    }));
  });

  it("an old SMS-style token claim buys nothing any more", async () => {
    // A leftover `phone_number` claim on a session from the Firebase Auth days
    // must not be a way back in: that mechanism is gone, and the rule no longer
    // reads the token at all.
    const withClaim = testEnv
      .authenticatedContext(MEMBER_A, { phone_number: PROVEN })
      .firestore();
    await assertFails(updateDoc(doc(withClaim, "users", MEMBER_A), {
      phone: PROVEN, phoneVerifiedAt: Date.now(),
    }));
  });

  it("clearing the number is allowed — deleteAccount scrubs it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", MEMBER_A), {
        phone: PROVEN, phoneVerifiedAt: Date.now(),
      });
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      phone: "", phoneVerifiedAt: null,
    }));
  });

  it("but not half of it — a proof without a number is a lie either way", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", MEMBER_A), {
        phone: PROVEN, phoneVerifiedAt: Date.now(),
      });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), { phone: "" }));
  });

  it("an edit that leaves the number alone is unaffected", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", MEMBER_A), {
        phone: PROVEN, phoneVerifiedAt: Date.now(),
      });
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "users", MEMBER_A), {
      firstName: "Still Editable",
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

  // ── returns: a book's owner asking for it back ──
  const returnPayload = (over = {}) => ({
    type: "return", status: "pending", bookId: BOOK_1, communityId: C1,
    requesterId: MEMBER_A, requesterName: "F L", holderId: MEMBER_A2,
    bookName: "Abai Joly", returnCode: "1234", reservedBook: true,
    createdAt: serverTimestamp(),
    ...over,
  });

  it("an owner may ask for their book back", async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER_A), "requests", "rr1"), returnPayload()));
  });

  it("nobody may open a return in somebody else's name", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A2), "requests", "rr1"), returnPayload()));
  });

  it("a return may not name the requester as its own holder", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "requests", "rr1"),
      returnPayload({ holderId: MEMBER_A })));
  });

  it("a return may not be opened into another community", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "requests", "rr1"),
      returnPayload({ communityId: C2 })));
  });

  it("a member may ask whether a copy in their community is going home", async () => {
    // The gate on the pickup screen. It reads somebody else's request, which is
    // why the query has to be scoped by community for the rules to accept it.
    await assertSucceeds(getDocs(query(
      collection(as(MEMBER_A2), "requests"),
      where("communityId", "==", C1),
      where("type", "==", "return"), where("status", "==", "pending"),
      where("bookId", "==", BOOK_1))));
  });

  it("but not in a community they do not belong to", async () => {
    await assertFails(getDocs(query(
      collection(as(MEMBER_B), "requests"),
      where("communityId", "==", C1),
      where("type", "==", "return"), where("status", "==", "pending"))));
  });

  it("the owner may cancel or complete their own return, but not re-point it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "rr1"), returnPayload({
        createdAt: Date.now(),
      }));
    });
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "requests", "rr1"), { status: "cancelled" }));
    await assertSucceeds(updateDoc(doc(as(MEMBER_A), "requests", "rr1"), { returnCode: "4321" }));
    await assertFails(updateDoc(doc(as(MEMBER_A), "requests", "rr1"), { bookId: BOOK_2 }));
    await assertFails(updateDoc(doc(as(MEMBER_A2), "requests", "rr1"), { status: "cancelled" }));
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
      communityId: C1, authorId: ADMIN_A, authorName: "F L", isPublic: true,
      body: "text", createdAt: serverTimestamp(),
    }));
  });

  it("a post must say whether it is public", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C1, authorId: ADMIN_A, body: "text",
      createdAt: serverTimestamp(),
    }));
  });

  it("a post must have text", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C1, authorId: ADMIN_A, isPublic: true, body: "",
      createdAt: serverTimestamp(),
    }));
  });

  it("a plain member may NOT publish a post", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "posts", "p1"), {
      communityId: C1, authorId: MEMBER_A, isPublic: true, body: "text",
      createdAt: serverTimestamp(),
    }));
  });

  it("an admin may NOT publish into another community", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C2, authorId: ADMIN_A, isPublic: true, body: "text",
      createdAt: serverTimestamp(),
    }));
  });

  it("an admin may NOT forge somebody else's authorship", async () => {
    await assertFails(setDoc(doc(as(ADMIN_A), "posts", "p1"), {
      communityId: C1, authorId: MEMBER_A, isPublic: true, body: "text",
      createdAt: serverTimestamp(),
    }));
  });

  // The Home feed: public posts are readable by anyone signed in, private ones
  // only by the community's own members.
  describe("the discovery feed", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, "posts", "public-1"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L", isPublic: true,
          title: "Open notice", body: "", createdAt: Date.now(),
        });
        await setDoc(doc(db, "posts", "private-1"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L", isPublic: false,
          title: "Members only", body: "", createdAt: Date.now(),
        });
        // Written before the flag existed.
        await setDoc(doc(db, "posts", "legacy-1"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L",
          title: "Old notice", body: "", createdAt: Date.now(),
        });
      });
    });

    it("an outsider may read a public post", async () => {
      await assertSucceeds(getDoc(doc(as(MEMBER_B), "posts", "public-1")));
    });

    it("an outsider may list public posts", async () => {
      const q = query(collection(as(MEMBER_B), "posts"), where("isPublic", "==", true));
      await assertSucceeds(getDocs(q));
    });

    it("an outsider may NOT read a private community's post", async () => {
      await assertFails(getDoc(doc(as(MEMBER_B), "posts", "private-1")));
    });

    it("an outsider may NOT read a post that predates the flag", async () => {
      await assertFails(getDoc(doc(as(MEMBER_B), "posts", "legacy-1")));
    });

    it("a member still reads their own community's private posts", async () => {
      await assertSucceeds(getDoc(doc(as(MEMBER_A), "posts", "private-1")));
      await assertSucceeds(getDoc(doc(as(MEMBER_A), "posts", "legacy-1")));
    });

    it("an outsider may NOT list every post", async () => {
      await assertFails(getDocs(collection(as(MEMBER_B), "posts")));
    });

    it("the owning admin may re-stamp visibility, and only that", async () => {
      await assertSucceeds(updateDoc(doc(as(ADMIN_A), "posts", "public-1"), { isPublic: false }));
      await assertFails(updateDoc(doc(as(ADMIN_B), "posts", "public-1"), { isPublic: false }));
      await assertFails(updateDoc(doc(as(MEMBER_A), "posts", "public-1"), { isPublic: false }));
      // Not a back door into editing the text.
      await assertFails(updateDoc(doc(as(ADMIN_A), "posts", "public-1"), {
        isPublic: false, communityId: C2,
      }));
    });
  });

  describe("editing", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "posts", "p1"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L",
          title: "Hello", body: "text", createdAt: Date.now(),
        });
      });
    });

    it("the author may fix their own post", async () => {
      await assertSucceeds(updateDoc(doc(as(ADMIN_A), "posts", "p1"), {
        title: "Hello again", body: "corrected",
      }));
    });

    it("a plain member may NOT edit a post", async () => {
      await assertFails(updateDoc(doc(as(MEMBER_A), "posts", "p1"), { body: "Nope" }));
    });

    it("another community's admin may NOT edit it", async () => {
      await assertFails(updateDoc(doc(as(ADMIN_B), "posts", "p1"), { body: "Nope" }));
    });

    it("an edit may not empty the text", async () => {
      await assertFails(updateDoc(doc(as(ADMIN_A), "posts", "p1"), { body: "" }));
    });

    it("an edit may not re-attribute or move the post", async () => {
      await assertFails(updateDoc(doc(as(ADMIN_A), "posts", "p1"), {
        body: "Rewritten", authorId: MEMBER_A,
      }));
      await assertFails(updateDoc(doc(as(ADMIN_A), "posts", "p1"), {
        body: "Rewritten", communityId: C2,
      }));
    });

    it("the author may take their own post down", async () => {
      await assertSucceeds(deleteDoc(doc(as(ADMIN_A), "posts", "p1")));
    });

    it("a plain member may NOT delete a post", async () => {
      await assertFails(deleteDoc(doc(as(MEMBER_A), "posts", "p1")));
    });

    it("another community's admin may NOT delete it", async () => {
      await assertFails(deleteDoc(doc(as(ADMIN_B), "posts", "p1")));
    });
  });

  describe("likes", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, "posts", "open"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L", isPublic: true,
          title: "Open", body: "text", likeCount: 2, createdAt: Date.now(),
        });
        await setDoc(doc(db, "posts", "closed"), {
          communityId: C1, authorId: ADMIN_A, authorName: "F L", isPublic: false,
          title: "Closed", body: "text", likeCount: 0, createdAt: Date.now(),
        });
      });
    });

    it("anyone who can read the post may like it", async () => {
      await assertSucceeds(updateDoc(doc(as(MEMBER_B), "posts", "open"), { likeCount: 3 }));
    });

    it("and may unlike it", async () => {
      await assertSucceeds(updateDoc(doc(as(MEMBER_B), "posts", "open"), { likeCount: 1 }));
    });

    it("a member may like their own community's private post", async () => {
      await assertSucceeds(updateDoc(doc(as(MEMBER_A), "posts", "closed"), { likeCount: 1 }));
    });

    it("an outsider may NOT like a post they cannot read", async () => {
      await assertFails(updateDoc(doc(as(MEMBER_B), "posts", "closed"), { likeCount: 1 }));
    });

    it("the counter moves by one, not to anything the caller likes", async () => {
      await assertFails(updateDoc(doc(as(MEMBER_B), "posts", "open"), { likeCount: 9999 }));
      await assertFails(updateDoc(doc(as(MEMBER_B), "posts", "open"), { likeCount: -1 }));
    });

    it("a like may not carry anything else along", async () => {
      await assertFails(updateDoc(doc(as(MEMBER_B), "posts", "open"), {
        likeCount: 3, body: "Hijacked",
      }));
    });

    it("a user may record their own likes on their profile", async () => {
      await assertSucceeds(updateDoc(doc(as(MEMBER_B), "users", MEMBER_B), {
        likedPostIds: ["open"],
      }));
    });
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
    // No phone in this patch, and that is the screen it mirrors: the number is
    // not editable from the profile form any more — it moves only through the
    // SMS flow, which is the only thing that can satisfy `phoneChangeAllowed`.
    await assertSucceeds(updateDoc(doc(db, "users", MEMBER_A), {
      firstName: "F", lastName: "L", nickname: "abai2026",
      address: "Somewhere 5", photoURL: "",
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

  it("the joiner brings their book — but only after approval, and only theirs", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "jr2"), {
        type: "join", status: "pending", userId: DRIFTER,
        userNickname: "drifter", communityId: C1,
        book: { name: "Qahar", author: "Esenberlin", genres: ["history"], pages: 450, maxDays: 9 },
      });
    });

    const entryFee = (overrides = {}) => ({
      name: "Qahar", author: "Esenberlin", communityId: C1,
      ownerId: DRIFTER, holderId: DRIFTER, status: "available",
      genre: "history", joinRequestId: "jr2", createdAt: serverTimestamp(),
      ...overrides,
    });

    // Still pending: nothing may reach the shelf yet.
    await assertFails(setDoc(doc(as(DRIFTER), "books", "fee-early"), entryFee()));

    await assertSucceeds(updateDoc(doc(as(ADMIN_A), "requests", "jr2"), { status: "approved" }));

    // Approved — and the applicant creates it themselves, before or as they join.
    await assertSucceeds(setDoc(doc(as(DRIFTER), "books", "fee"), entryFee()));
    await assertSucceeds(updateDoc(doc(as(DRIFTER), "users", DRIFTER), {
      communityId: C1, joinRequestId: "jr2",
    }));

    // The approval buys exactly one book, for its owner, in its community.
    await assertFails(setDoc(doc(as(DRIFTER), "books", "fee-other-owner"), entryFee({
      ownerId: MEMBER_A, holderId: MEMBER_A,
    })));
    await assertFails(setDoc(doc(as(DRIFTER), "books", "fee-other-community"), entryFee({
      communityId: C2,
    })));
    await assertFails(setDoc(doc(as(DRIFTER), "books", "fee-unbacked"), entryFee({
      joinRequestId: "no-such-request",
    })));
    // And nobody else may ride on somebody else's approved application.
    await assertFails(setDoc(doc(as(MEMBER_A2), "books", "fee-hijack"), entryFee()));
  });

  it("accepts the entry-fee book exactly as the client writes it", async () => {
    // The payload here is the real one — everything normalizeNewBook puts on a
    // book, not a minimal stand-in — because the create rule checks `hasAll`
    // and a handful of field values, and the fields it does *not* name still
    // have to be allowed through.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "jr4"), {
        type: "join", status: "approved", userId: DRIFTER,
        userNickname: "drifter", userName: "Drifter", communityId: C1,
        book: { name: "Jabayy alma", author: "Muratbekov", genres: ["fiction"], pages: 300, maxDays: 6 },
      });
    });

    const db = as(DRIFTER);
    // The two writes the accept button makes, in the order it makes them.
    await assertSucceeds(updateDoc(doc(db, "users", DRIFTER), {
      communityId: C1, joinRequestId: "jr4",
    }));
    await assertSucceeds(setDoc(doc(db, "books", "fee-full"), {
      name: "Jabayy alma",
      author: "Muratbekov",
      description: "",
      coverUrl: "",
      year: 1975,
      pages: 300,
      maxDays: 6,
      genres: ["fiction"],
      genre: "fiction",
      communityId: C1,
      ownerId: DRIFTER,
      holderId: DRIFTER,
      status: "available",
      borrowerId: null,
      rating: 0,
      ratingSum: 0,
      ratingCount: 0,
      searchPrefixes: ["j", "ja", "jab"],
      joinRequestId: "jr4",
      createdAt: serverTimestamp(),
    }));
  });

  it("an applicant cannot approve their own request", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "requests", "jr3"), {
        type: "join", status: "pending", userId: DRIFTER,
        userNickname: "drifter", communityId: C1,
      });
    });

    // The verdict belongs to the admin. Two other rules read this status back
    // and trust it, so a self-stamped "approved" would be a way into any
    // community — and a book on its shelf — with no admin involved.
    await assertFails(updateDoc(doc(as(DRIFTER), "requests", "jr3"), { status: "approved" }));
    await assertFails(updateDoc(doc(as(DRIFTER), "requests", "jr3"), { status: "rejected" }));
    // Withdrawing it is still theirs.
    await assertSucceeds(updateDoc(doc(as(DRIFTER), "requests", "jr3"), { status: "cancelled" }));
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

  it("LeaveCommunity: send the code for a copy that is out on loan", async () => {
    // Exactly the three writes `openReturnRequest` makes from the leave screen,
    // for the case in the screenshot: the book is unavailable with a reader on
    // it, so nothing is reserved and only the request and the notification are
    // written. If this passes and the app still says "permission denied", the
    // deployed ruleset is older than this file.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "unavailable", borrowerId: MEMBER_A2, holderId: MEMBER_A2,
      });
    });
    const db = as(MEMBER_A); // the owner, a member of C1, on their way out

    await assertSucceeds(setDoc(doc(db, "requests", "rr-loan"), {
      type: "return", status: "pending",
      bookId: BOOK_1, bookName: "Abai Joly", communityId: C1,
      requesterId: MEMBER_A, requesterName: "F L",
      holderId: MEMBER_A2, returnCode: "1234", reservedBook: false,
      createdAt: serverTimestamp(),
    }));

    await assertSucceeds(setDoc(doc(db, "notifications", "n-return"), {
      recipientId: MEMBER_A2, title: "Кітапты қайтару сұралуда", body: "…",
      read: false, type: "return-request", bookId: BOOK_1, bookName: "Abai Joly",
      pickupCode: "1234", returnCode: "1234", requesterId: MEMBER_A,
      createdAt: serverTimestamp(),
    }));

    // And the free-copy case, where the book also comes off the shelf.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "books", BOOK_1), {
        status: "available", borrowerId: null, holderId: MEMBER_A2,
      });
    });
    await assertSucceeds(updateDoc(doc(db, "books", BOOK_1), {
      status: "unavailable", borrowerId: null,
    }));
  });

  it("PhoneVerify: the client opens an attempt and can only abandon it", async () => {
    // Exactly what firebase/phoneVerify.js writes — and note what is missing:
    // any write to the profile. Resolving an attempt belongs to the webhook,
    // through the Admin SDK. There is no client path to a verified number.
    const db = as(MEMBER_A);
    const token = "ABCD2345WXYZ";
    await assertSucceeds(setDoc(doc(db, "phoneVerifications", token), {
      userId: MEMBER_A, phone: "+77015550101", channel: "whatsapp",
      status: "pending", expiresAt: Date.now() + 15 * 60 * 1000,
    }));
    await assertSucceeds(getDoc(doc(db, "phoneVerifications", token)));
    await assertFails(updateDoc(doc(db, "phoneVerifications", token), {
      status: "verified", verifiedPhone: "+77015550101",
    }));
    await assertSucceeds(updateDoc(doc(db, "phoneVerifications", token), {
      status: "cancelled",
    }));
  });

  it("PhoneVerify: nobody may open or read an attempt in somebody else's name", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "phoneVerifications", "T1"), {
      userId: MEMBER_A2, phone: "+77015550101", channel: "telegram",
      status: "pending", expiresAt: Date.now() + 60000,
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "phoneVerifications", "T2"), {
        userId: MEMBER_A2, phone: "+77015550102", channel: "telegram",
        status: "pending", expiresAt: Date.now() + 60000,
      });
    });
    await assertFails(getDoc(doc(as(MEMBER_A), "phoneVerifications", "T2")));
    await assertFails(updateDoc(doc(as(MEMBER_A), "phoneVerifications", "T2"), {
      status: "cancelled",
    }));
  });

  it("PhoneVerify: an attempt may not be born verified, nor open for a year", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "phoneVerifications", "T3"), {
      userId: MEMBER_A, phone: "+77015550101", channel: "whatsapp",
      status: "verified", expiresAt: Date.now() + 60000,
    }));
    await assertFails(setDoc(doc(as(MEMBER_A), "phoneVerifications", "T4"), {
      userId: MEMBER_A, phone: "+77015550101", channel: "whatsapp",
      status: "pending", expiresAt: Date.now() + 400 * 86400000,
    }));
    await assertFails(setDoc(doc(as(MEMBER_A), "phoneVerifications", "T5"), {
      userId: MEMBER_A, phone: "+77015550101", channel: "carrier-pigeon",
      status: "pending", expiresAt: Date.now() + 60000,
    }));
  });

  it("DeleteAccount: the scrub clears the number and its proof together", async () => {
    const proven = "+77015550101";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", MEMBER_A), {
        phone: proven, phoneVerifiedAt: Date.now(),
      });
    });
    // Exactly the patch in auth.js `deleteAccount`. Clearing is the one thing a
    // client may do to a phone number, and this is why it stays allowed.
    await assertSucceeds(updateDoc(
      doc(as(MEMBER_A), "users", MEMBER_A),
      {
        firstName: "", lastName: "", nickname: "deleted_member-a",
        phone: "", phoneVerifiedAt: null, address: "", photoURL: "",
        savedBookIds: [], communityId: null, role: "user",
        deleted: true, deletedAt: Date.now(),
      }
    ));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("readingSessions", () => {
  const session = (userId, over = {}) => ({
    userId,
    communityId: C1,
    bookId: null,
    seconds: 1_805,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_001_805_000,
    dayKey: "2026-08-08",
    createdAt: serverTimestamp(),
    ...over,
  });

  it("a reader may log their own sitting", async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"), session(MEMBER_A)));
  });

  it("a reader may NOT log a sitting in somebody else's name", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"), session(MEMBER_A2)));
  });

  it("rejects a length that is not a whole number of seconds", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"),
      session(MEMBER_A, { seconds: 0 })));
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s2"),
      session(MEMBER_A, { seconds: -60 })));
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s3"),
      session(MEMBER_A, { seconds: 90.5 })));
  });

  it("rejects a sitting too short to be reading", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"),
      session(MEMBER_A, { seconds: 29 })));
    await assertSucceeds(setDoc(doc(as(MEMBER_A), "readingSessions", "s2"),
      session(MEMBER_A, { seconds: 30 })));
  });

  it("rejects a sitting longer than the ten-hour ceiling", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"),
      session(MEMBER_A, { seconds: 36_001 })));
  });

  it("rejects a run that ends before it starts", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"),
      session(MEMBER_A, { startedAt: 2_000_000_000_000, endedAt: 1_000_000_000_000 })));
  });

  it("rejects a client-invented createdAt", async () => {
    await assertFails(setDoc(doc(as(MEMBER_A), "readingSessions", "s1"),
      session(MEMBER_A, { createdAt: 123 })));
  });

  it("is readable only by its author, not by fellow members", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "readingSessions", "s1"),
        { ...session(MEMBER_A), createdAt: new Date() });
    });
    await assertSucceeds(getDoc(doc(as(MEMBER_A), "readingSessions", "s1")));
    await assertFails(getDoc(doc(as(MEMBER_A2), "readingSessions", "s1")));
    await assertFails(getDoc(doc(as(ADMIN_A), "readingSessions", "s1")));
    await assertFails(getDoc(doc(anon(), "readingSessions", "s1")));
  });

  it("lists only a query scoped to the caller", async () => {
    await assertSucceeds(getDocs(query(
      collection(as(MEMBER_A), "readingSessions"), where("userId", "==", MEMBER_A))));
    await assertFails(getDocs(query(
      collection(as(MEMBER_A), "readingSessions"), where("userId", "==", MEMBER_A2))));
    await assertFails(getDocs(collection(as(MEMBER_A), "readingSessions")));
  });

  it("is a log: nobody may rewrite or erase a sitting, including its author", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "readingSessions", "s1"),
        { ...session(MEMBER_A), createdAt: new Date() });
    });
    await assertFails(updateDoc(doc(as(MEMBER_A), "readingSessions", "s1"), { seconds: 36_000 }));
    await assertFails(deleteDoc(doc(as(MEMBER_A), "readingSessions", "s1")));
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
