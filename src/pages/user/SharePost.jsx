import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useChats } from "../../contexts/ChatContext.jsx";
import { getPost, getCommunity, listUsersByCommunity, otherMemberId, sendMessage } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { t } from "../../utils/i18n.js";

/**
 * Passing a post to somebody, inside the app.
 *
 * The share button used to reach only for the OS sheet, which hands the link to
 * WhatsApp or the clipboard — out of the app and into somewhere the recipient
 * has to come back from. The people most likely to care about a notice are the
 * ones already in here, so this screen lists them first and sends the post as
 * an ordinary chat message. The system sheet is still at the bottom, for
 * everybody who is not.
 *
 * A message, not a new kind of document: a shared post is a line of text with a
 * link in it, which is what a chat already carries. Nothing new to store, and
 * the recipient can reply to it like anything else.
 */
export default function SharePost() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { chats } = useChats();

  const [post, setPost] = useState(null);
  const [handle, setHandle] = useState("");
  const [sendingTo, setSendingTo] = useState(null);
  const [sentTo, setSentTo] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getPost(id)
      .then(async (p) => {
        setPost(p);
        if (p?.communityId) {
          const c = await getCommunity(p.communityId).catch(() => null);
          setHandle(c?.nickname || c?.name || "");
        }
      })
      .catch((err) => logger.error("sharePost.load", err?.message, { postId: id }));
  }, [id]);

  // People to send it to: everybody this reader is already talking to, then the
  // rest of their community. The order is the useful one — a share is nearly
  // always to somebody you have a thread with.
  const membersQuery = useQuery({
    queryKey: qk.communities.members(user?.communityId),
    enabled: !!user?.communityId,
    staleTime: 60_000,
    queryFn: () => listUsersByCommunity(user.communityId),
  });

  const recipients = useMemo(() => {
    const talkingTo = chats
      .map((chat) => otherMemberId(chat, user?.id))
      .filter(Boolean);
    const order = new Map(talkingTo.map((peerId, i) => [peerId, i]));
    return (membersQuery.data ?? [])
      .filter((m) => m.id !== user?.id)
      .sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
  }, [chats, membersQuery.data, user?.id]);

  const url = `${window.location.origin}/posts/${id}`;

  async function shareWith(person) {
    if (sendingTo || !user?.id || !post) return;
    setSendingTo(person.id);
    setError("");
    try {
      await sendMessage({
        senderId: user.id,
        recipientId: person.id,
        text: t.shareChatMessage(handle || t.app, url),
      });
      setSentTo(person.id);
    } catch (err) {
      logger.error("sharePost.send", err?.message, { postId: id, code: err?.code });
      setError(writeError(err));
    } finally {
      setSendingTo(null);
    }
  }

  async function shareOutside() {
    try {
      if (navigator.share) {
        await navigator.share({ text: t.sharePostText(handle || t.app), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setSentTo("clipboard");
    } catch (err) {
      // A cancelled sheet rejects exactly like a failure, and is far commoner.
      logger.warn("sharePost.outside", err?.message, { postId: id });
    }
  }

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[18px] font-bold flex-1 truncate">{t.sharePostTitle}</h1>
      </div>

      {/* What is being shared, so the reader can see they picked the right one. */}
      {post ? (
        <div className="px-4">
          <div className="card px-4 py-3">
            {handle ? <p className="text-[13px] font-semibold text-brand-700">{handle}</p> : null}
            <p className="text-[14px] text-ink-700 mt-0.5 line-clamp-3 whitespace-pre-wrap">{post.body}</p>
          </div>
        </div>
      ) : null}

      {error ? <p className="px-4 mt-3 text-bad text-[13px]">{error}</p> : null}

      <h3 className="section-title px-4 mt-5 mb-1">{t.shareToChat}</h3>

      {recipients.length === 0 ? (
        <p className="px-6 py-8 text-center text-ink-500 text-[14px]">{t.shareNobody}</p>
      ) : (
        <ul>
          {recipients.map((person) => (
            <li key={person.id} className="flex items-center gap-3 px-4 py-3 border-b border-ink-100">
              <Avatar src={person.photoURL} name={peerName(person)} size={40} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[15px] truncate">{peerName(person)}</p>
                {person.nickname ? (
                  <p className="text-[13px] text-ink-500 truncate">@{person.nickname}</p>
                ) : null}
              </div>
              {sentTo === person.id ? (
                // Sent, and the way into the conversation it landed in — the
                // thing a reader wants next often enough to be worth a tap.
                <button
                  onClick={() => navigate(`/chats/${person.id}`)}
                  className="shrink-0 px-3 py-2 rounded-xl text-[13px] font-semibold bg-okSoft text-ok"
                >
                  {t.shareSent}
                </button>
              ) : (
                <button
                  onClick={() => shareWith(person)}
                  disabled={!!sendingTo}
                  className="shrink-0 px-3 py-2 rounded-xl text-[13px] font-semibold bg-brand-500 text-white active:scale-95 transition disabled:opacity-60"
                >
                  {sendingTo === person.id ? "…" : t.submit}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 mt-6">
        <button onClick={shareOutside} className="btn-secondary">
          {sentTo === "clipboard" ? t.linkCopied : t.shareOutside}
        </button>
      </div>

      <div className="h-6" />
    </MobileShell>
  );
}
