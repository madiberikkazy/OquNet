import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  createCommunityInvite, createNotification, getCommunity, searchUsers, sendMessage,
} from "../../firebase/firestore.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { t } from "../../utils/i18n.js";

/**
 * Inviting somebody into the community, from the community.
 *
 * The invitation itself is not new — it is the one an admin could already send
 * from inside a chat, and it is deliberately the same three writes here, in the
 * same order, so an invitation means one thing however it was sent. What was
 * missing was the way *in*: sending one meant already being in a conversation
 * with the person, which is backwards for the case this is actually for —
 * bringing in somebody the admin has never messaged.
 *
 * So this is a search, not a member list: the people worth inviting are by
 * definition the ones who are not here yet.
 *
 * The invitation still travels as a chat message, and that is the point rather
 * than an implementation detail — it lands somewhere the invitee already looks,
 * in a thread they can reply in, and it opens a screen that explains what
 * accepting costs before anybody joins anything. See CommunityInvite.jsx.
 */
export default function InviteMember() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [search, setSearch]     = useState("");
  const [found, setFound]       = useState([]);
  const [searching, setSearching] = useState(false);
  // Who has been invited in this sitting, and who is being invited right now.
  // Kept per-user rather than as one busy flag: the admin is working down a
  // list of people, and a screen that locks entirely between each one reads as
  // broken on a slow connection.
  const [sent, setSent]         = useState(() => new Set());
  const [sending, setSending]   = useState(null);
  const [error, setError]       = useState("");

  const communityQuery = useQuery({
    queryKey: ["community", id],
    enabled: !!id,
    staleTime: 60_000,
    queryFn: () => getCommunity(id),
  });
  const community = communityQuery.data;

  // Gated on exactly what `isAdminOf` reads in firestore.rules — the caller's
  // own profile — and not on the community's `ownerId`, for the reason spelled
  // out at `canInvite` in Chat.jsx: the two disagree in precisely the cases
  // where an ownerId gate would show a button the rules then refuse.
  const canInvite =
    !!id && user?.role === "admin" && user?.communityId === id;

  // Debounced by the same 250ms New Chat uses — a query per keystroke otherwise.
  useEffect(() => {
    const term = search.trim();
    if (!term) { setFound([]); setSearching(false); return undefined; }

    setSearching(true);
    const timer = setTimeout(() => {
      searchUsers(term)
        .then((rows) => setFound(rows.filter((u) => u.id !== user?.id)))
        .catch((err) => {
          logger.error("inviteMember.search", err?.message, { code: err?.code });
          setFound([]);
        })
        .finally(() => setSearching(false));
    }, 250);

    return () => clearTimeout(timer);
  }, [search, user?.id]);

  async function invite(person) {
    if (!canInvite || sending || sent.has(person.id)) return;
    setSending(person.id);
    setError("");
    try {
      const adminName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.nickname;
      const request = await createCommunityInvite({
        userId: person.id,
        invitedBy: user.id,
        communityId: id,
        communityName: community?.name || "",
        invitedByName: adminName,
      });

      // The invitation travels as an ordinary message with two ids attached, so
      // it lands in the thread, bumps the unread count and shows in the chats
      // list exactly like anything else said there.
      await sendMessage({
        senderId: user.id,
        recipientId: person.id,
        text: t.inviteMessageText(community?.name || ""),
        invite: { inviteId: request.id, communityId: id },
      });

      // And a notification, because a chat is somewhere people look when they
      // are already looking. Best-effort: an invitation that arrived is not
      // undone by a nudge that did not.
      await createNotification({
        recipientId: person.id,
        title: t.inviteNotifTitle,
        body: t.inviteNotifBody(adminName, community?.name || ""),
        read: false,
        type: "community-invite",
        communityId: id,
        requestId: request.id,
      }).catch((err) => logger.warn("inviteMember.notify", err?.message));

      setSent((prev) => new Set(prev).add(person.id));
    } catch (err) {
      logger.error("inviteMember.send", err?.message, { code: err?.code });
      // `writeError`, not a flat "could not save": a refusal here says the
      // account is not this community's admin, which is a different problem
      // from the network being down and needs a different response.
      setError(writeError(err));
    } finally {
      setSending(null);
    }
  }

  const typing = Boolean(search.trim());

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-bold truncate">{t.inviteMemberTitle}</h1>
          {community?.name ? (
            <p className="text-[13px] text-ink-500 truncate">{community.name}</p>
          ) : null}
        </div>
      </div>

      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder={t.inviteMemberSearch}
        showFilter={false}
      />

      {/* Said once, at the top: where the invitation goes is the part an admin
          cannot guess, and it explains why there is no "copy link" here. */}
      <p className="px-4 mt-3 text-[13px] text-ink-500">{t.inviteMemberHint}</p>

      {error ? <p className="px-4 mt-2 text-bad text-[13px]">{error}</p> : null}

      {!canInvite ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.notAuthorized}</p>
      ) : !typing ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.inviteMemberStart}</p>
      ) : searching ? (
        <ul className="mt-2">
          {[1, 2, 3].map((i) => (
            <li key={i} className="flex gap-3 px-4 py-3 border-b border-ink-100 animate-pulse">
              <div className="w-11 h-11 rounded-full bg-ink-100 shrink-0" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3 w-28 rounded bg-ink-100" />
                <div className="h-3 w-20 rounded bg-ink-100" />
              </div>
            </li>
          ))}
        </ul>
      ) : found.length === 0 ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.noResults}</p>
      ) : (
        <ul className="mt-1">
          {found.map((person) => {
            // Somebody already standing in this community cannot be invited to
            // it. Said on the row rather than left as a button that could only
            // fail — and it would fail at the far end, on their screen, days
            // later, rather than on the admin's.
            const alreadyHere = person.communityId === id;
            const done = sent.has(person.id);
            const busy = sending === person.id;
            return (
              <li key={person.id} className="flex items-center gap-3 px-4 py-3 border-b border-ink-100">
                <Avatar src={person.photoURL} name={peerName(person)} size={44} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[15px] truncate">{peerName(person)}</p>
                  {person.nickname ? (
                    <p className="text-[13px] text-ink-500 truncate">@{person.nickname}</p>
                  ) : null}
                </div>
                {alreadyHere ? (
                  <span className="text-[12px] text-ink-400 shrink-0 max-w-[38%] text-right leading-snug">
                    {t.inviteAlreadyInThis}
                  </span>
                ) : done ? (
                  <span className="text-[13px] text-ok font-medium shrink-0">{t.inviteSent}</span>
                ) : (
                  <button
                    onClick={() => invite(person)}
                    disabled={Boolean(sending)}
                    className="shrink-0 px-4 py-2 rounded-xl bg-brand-500 text-white text-[13px] font-semibold transition active:scale-95 disabled:opacity-50"
                  >
                    {busy ? "…" : t.invite}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </MobileShell>
  );
}
