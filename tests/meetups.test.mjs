// Turning offline seats into tables — src/utils/meetups.js.
//
// The database stores one row per person and the screens draw one card per
// table, so this module is the whole of the join between them. Three things it
// decides are worth pinning down, because each of them is invisible until it is
// wrong on somebody's profile:
//
//   · a table survives its host standing up. The rows that remain still agree
//     on `hostId`, and dropping the group at that point would take a meeting
//     away from two people who have already agreed to it;
//   · the seat order is stable — host first, then by arrival. The faces are
//     drawn in a ring off this array, and a ring that reshuffles when somebody
//     joins reads as a glitch rather than as a person pulling up a chair;
//   · the matching rule is exact, and "unknown" matches nothing. A reader who
//     has never answered the gender question must not be shown sittings that
//     were opened for one answer or the other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { meetupTables, meetupsFor, memberId, tableFor } from "../src/utils/meetups.js";

/** One seat, with only the fields the grouping actually reads. */
const seat = (userId, hostId, over = {}) => ({
  id: userId,
  userId,
  hostId,
  communityId: "c1",
  gender: "male",
  place: "Central library",
  name: userId,
  startedAt: 1000,
  ...over,
});

describe("meetupTables", () => {
  it("gathers the rows that name the same host into one table", () => {
    const tables = meetupTables([
      seat("host", "host"),
      seat("guest", "host", { startedAt: 2000 }),
      seat("other", "other", { startedAt: 3000 }),
    ]);

    assert.equal(tables.length, 2);
    const table = tables.find((tbl) => tbl.hostId === "host");
    assert.deepEqual(table.members.map(memberId), ["host", "guest"]);
  });

  it("puts the host first and everybody else in the order they sat down", () => {
    const [table] = meetupTables([
      seat("late", "host", { startedAt: 3000 }),
      seat("early", "host", { startedAt: 2000 }),
      seat("host", "host", { startedAt: 9000 }),
    ]);

    // The host leads even though they have the latest stamp of the three: the
    // ring is drawn around them, so their seat is a position rather than a time.
    assert.deepEqual(table.members.map(memberId), ["host", "early", "late"]);
  });

  it("keeps a table together after its host stands up", () => {
    const [table] = meetupTables([
      seat("a", "gone", { startedAt: 2000, place: "Coffee Boom" }),
      seat("b", "gone", { startedAt: 3000, place: "Coffee Boom" }),
    ]);

    assert.equal(table.hostId, "gone");
    assert.equal(table.members.length, 2);
    // The place and the gender come off whoever is left, so the card still
    // says where the meeting is.
    assert.equal(table.place, "Coffee Boom");
    assert.equal(table.gender, "male");
    assert.equal(table.reading, true);
  });

  it("calls one seat an invitation and two a sitting", () => {
    const [alone] = meetupTables([seat("host", "host")]);
    assert.equal(alone.reading, false);

    const [together] = meetupTables([seat("host", "host"), seat("guest", "host")]);
    assert.equal(together.reading, true);
  });

  it("orders the tables by the most recently opened", () => {
    const tables = meetupTables([
      seat("old", "old", { startedAt: 1000 }),
      seat("new", "new", { startedAt: 5000 }),
    ]);
    assert.deepEqual(tables.map((tbl) => tbl.hostId), ["new", "old"]);
  });

  it("ignores a row with nobody on it rather than making a table for it", () => {
    const tables = meetupTables([{ place: "nowhere" }, seat("host", "host")]);
    assert.deepEqual(tables.map((tbl) => tbl.hostId), ["host"]);
  });
});

describe("tableFor", () => {
  const tables = meetupTables([
    seat("host", "host"),
    seat("guest", "host"),
    seat("other", "other"),
  ]);

  it("finds the table somebody is hosting", () => {
    assert.equal(tableFor(tables, "host").hostId, "host");
  });

  it("finds the table somebody merely joined", () => {
    assert.equal(tableFor(tables, "guest").hostId, "host");
  });

  it("is null for somebody sitting nowhere, and for nobody", () => {
    assert.equal(tableFor(tables, "stranger"), null);
    assert.equal(tableFor(tables, null), null);
  });
});

describe("meetupsFor", () => {
  const tables = meetupTables([
    seat("m1", "m1"),
    seat("m2", "m2"),
    seat("f1", "f1", { gender: "female" }),
  ]);

  it("shows only the sittings opened for the reader's own answer", () => {
    const shown = meetupsFor(tables, { id: "someone", gender: "male" });
    assert.deepEqual(shown.map((tbl) => tbl.hostId).sort(), ["m1", "m2"]);
  });

  it("leaves out the one the reader is already at", () => {
    const shown = meetupsFor(tables, { id: "m1", gender: "male" });
    assert.deepEqual(shown.map((tbl) => tbl.hostId), ["m2"]);
  });

  it("shows nothing to a reader who has not answered", () => {
    // Not "everything" and not "one side of it": there is no honest guess to
    // make here, and either default would put a stranger's meeting in front of
    // somebody it was not opened for.
    assert.deepEqual(meetupsFor(tables, { id: "x" }), []);
    assert.deepEqual(meetupsFor(tables, { id: "x", gender: "" }), []);
    assert.deepEqual(meetupsFor(tables, { id: "x", gender: "other" }), []);
    assert.deepEqual(meetupsFor(tables, null), []);
  });
});
