// Turning a flat list of offline seats into the tables people are sitting at.
//
// The database stores one row per person (firebase/schema.js explains why), so
// every screen that draws a meet-up has the same first job: gather the rows by
// `hostId`, work out who the host is, and put them at the front. Doing that in
// each screen would be three copies of the same reduce, disagreeing about the
// order of the faces — which matters, because the faces are drawn in a ring and
// the ring is meant to look the same to everybody at it.

import { MEETUP_GENDERS } from "../firebase/schema.js";

export { MEETUP_GENDERS };

/**
 * Rows → tables, newest arrangement first.
 *
 * A table is named by its host, and the host's row is the one whose owner *is*
 * the host. It may be missing — a host who stood up leaves the people who
 * joined still sitting there — and that is not an error: the table keeps the
 * host's id, takes its place and gender off whoever is left, and carries on.
 * The alternative, dropping the group when its opener leaves, would take a
 * meeting away from two people who have already agreed to it.
 */
export function meetupTables(rows = []) {
  const byHost = new Map();

  for (const row of rows) {
    const hostId = row?.hostId ?? row?.userId ?? row?.id;
    if (!hostId) continue;
    if (!byHost.has(hostId)) byHost.set(hostId, []);
    byHost.get(hostId).push(row);
  }

  const tables = [];
  for (const [hostId, members] of byHost) {
    // The host first, then whoever sat down soonest. A stable order is the
    // whole point: the ring is drawn from this array, and a table that
    // reshuffles every time somebody joins reads as a glitch rather than as a
    // person pulling up a chair.
    const seats = [...members].sort((a, b) => {
      const ah = memberId(a) === hostId, bh = memberId(b) === hostId;
      if (ah !== bh) return ah ? -1 : 1;
      return (a.startedAt ?? 0) - (b.startedAt ?? 0);
    });
    const host = seats.find((m) => memberId(m) === hostId) ?? seats[0];
    tables.push({
      hostId,
      host,
      members: seats,
      // Off the host while there is one, off whoever is left when there is not.
      place: host?.place ?? "",
      gender: host?.gender ?? "",
      startedAt: host?.startedAt ?? seats[0]?.startedAt ?? 0,
      // Two people is the difference between an invitation and a sitting, and
      // it is what the animated card on a profile is showing.
      reading: seats.length > 1,
    });
  }

  return tables.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** The id of whoever owns one seat. */
export function memberId(row) {
  return row?.userId ?? row?.id ?? null;
}

/** The table this reader is sitting at, hosting or not, or null. */
export function tableFor(tables = [], userId) {
  if (!userId) return null;
  return tables.find((tbl) => tbl.members.some((m) => memberId(m) === userId)) ?? null;
}

/**
 * The tables to put in front of this reader.
 *
 * Their own is not among them — it is drawn separately, above, as the thing
 * they are part of rather than something to join. The rest are the sittings
 * open to somebody of their gender, which is the whole matching rule: a
 * `gender` on a table is who it is *for*, and it is compared to the reader's own
 * exactly. A reader who has not answered the question sees nothing, because
 * "unknown" is not one of the two answers and matching it against either would
 * be guessing on their behalf.
 */
export function meetupsFor(tables = [], user) {
  const gender = String(user?.gender ?? "");
  if (!MEETUP_GENDERS.includes(gender)) return [];
  return tables.filter(
    (tbl) => tbl.gender === gender && !tbl.members.some((m) => memberId(m) === user?.id)
  );
}
