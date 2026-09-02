import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MeetupCard from "./MeetupCard.jsx";
import {
  diagnoseMeetupAccess,
  joinOfflineMeetup, leaveOfflineMeetup, watchOfflineMeetups,
} from "../firebase/firestore.js";
import { meetupTables, meetupsFor, memberId, tableFor } from "../utils/meetups.js";
import { peerName } from "../utils/chatPeer.js";
import { logger } from "../utils/logger.js";
import { writeError } from "../utils/writeError.js";
import { t } from "../utils/i18n.js";

/** How many invitations a profile shows before deferring to the full list. */
const FEED_MAX = 3;

/**
 * Who is looking for somebody to read with in person, on your own profile.
 *
 * ── Why this is on the profile and not in the notification list ──────────────
 * Because it is not news, it is a state of the world: somebody is sitting in
 * the library *right now* and would like company. A notification is a record of
 * something that happened, it survives being read, and it is still there
 * tomorrow saying come and meet me at four — by which time nobody is there. An
 * invitation that expires belongs somewhere that is only ever a snapshot of the
 * present, and a profile screen re-read on every visit is exactly that.
 *
 * It is also why there is no fan-out. Nothing is delivered to anybody: this is
 * one live subscription to the community's meet-ups, filtered to the ones open
 * to this reader. A community of two thousand costs two thousand *listeners*
 * rather than two thousand documents per invitation, and an arrangement that
 * ends stops being drawn the moment its owner stands up.
 *
 * ── What it draws ───────────────────────────────────────────────────────────
 * Nothing at all, most of the time. A section that is empty on almost every
 * visit should not take a heading and a card's worth of a profile to say so —
 * the empty state, and the way to open a sitting, live on the offline tab where
 * somebody has gone looking for one.
 *
 * And no heading even when it does draw. These cards belong under the profile's
 * reading section, directly beneath the card that counts minutes and offers the
 * room — reading with other people is one subject, and it had grown two titles
 * on one screen with the word "бірге оқу" in both of them. The section above
 * names it; this is the rest of the same answer.
 */
export default function MeetupFeed({ user, communityId, className = "" }) {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!communityId) return undefined;
    return watchOfflineMeetups(communityId, {
      onRows: setRows,
      onError: (err) => logger.error("profile.meetups", err?.message, { code: err?.code }),
    });
  }, [communityId]);

  const tables = useMemo(() => meetupTables(rows), [rows]);
  const mine = useMemo(() => tableFor(tables, user?.id), [tables, user?.id]);
  const open = useMemo(() => meetupsFor(tables, user), [tables, user]);

  async function join(table) {
    if (busy || !table) return;
    setBusy(true);
    setError("");
    try {
      await joinOfflineMeetup({
        userId: user.id,
        meetup: {
          hostId: table.hostId,
          communityId,
          gender: table.gender,
          place: table.place,
        },
        name: peerName(user),
        nickname: user.nickname ?? "",
        photoURL: user.photoURL ?? "",
      });
      // Straight into the conversation, for the reason the offline tab gives:
      // agreeing to meet somebody is the start of arranging it, not the end.
      navigate(`/chats/${table.hostId}`);
    } catch (err) {
      logger.error("profile.meetups.join", err?.message, {
        code: err?.code, collection: "meetups",
      });
      if (err?.code === "permission-denied") {
        // See the note on reportRefusal in ReadTogetherOffline.jsx: the ids the
        // rule compares are a server value and a client one, and only the
        // server can be asked for its half.
        const diagnosis = await diagnoseMeetupAccess({ userId: user?.id, communityId });
        logger.error("profile.meetups.join.diagnosis", diagnosis.verdict, diagnosis);
      }
      setError(writeError(err) || t.meetupJoinFailed);
      setBusy(false);
    }
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    try {
      await leaveOfflineMeetup(user?.id);
    } catch (err) {
      logger.warn("profile.meetups.leave", err?.message);
    } finally {
      setBusy(false);
    }
  }

  function openChat(table) {
    const guest = table.members.find((m) => memberId(m) !== user?.id);
    const peer = table.hostId === user?.id ? (guest ? memberId(guest) : null) : table.hostId;
    if (peer) navigate(`/chats/${peer}`);
  }

  if (!communityId || (!mine && open.length === 0)) return null;

  const shown = open.slice(0, FEED_MAX);

  return (
    <div className={className}>
      {error ? <p className="mb-2 text-bad text-[13px]">{error}</p> : null}

      <div className="space-y-2.5">
        {mine ? (
          <MeetupCard
            table={mine}
            mine
            busy={busy}
            onLeave={leave}
            onOpenChat={() => openChat(mine)}
          />
        ) : null}

        {shown.map((table, i) => (
          <MeetupCard
            key={table.hostId}
            table={table}
            busy={busy}
            onJoin={() => join(table)}
            style={{ animationDelay: `${(i + (mine ? 1 : 0)) * 60}ms` }}
          />
        ))}
      </div>

      {/* Only when there is something this glimpse could not fit. With a
          heading gone there is no longer a permanent link to the tab here, and
          that is right: the section above already offers "Бірге оқу", and a
          second way in under every card would be the duplication this change
          was made to remove. */}
      {open.length > shown.length ? (
        <Link
          to="/reading/together?tab=offline"
          className="mt-2 block text-center text-[13px] font-semibold text-brand-500 active:opacity-60"
        >
          {t.showMore}
        </Link>
      ) : null}
    </div>
  );
}
