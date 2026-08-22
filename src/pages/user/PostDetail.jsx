import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import PostCard from "../../components/PostCard.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  createComment, deleteComment, getCommunity, getPost, togglePostLike, watchComments,
} from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { formatPostStamp } from "../../utils/time.js";
import { t } from "../../utils/i18n.js";

/**
 * One post and its replies.
 *
 * The thread is a *place*, which is why it is a route rather than a sheet: it
 * is what the comment icon in the feed points at, what the share button hands
 * somebody, and what a reader comes back to. The post at the top is the same
 * component the feed draws, with its text no longer clipped.
 *
 * The replies are a live subscription rather than a fetch, for the reason the
 * feed is: a thread is the one screen two people are most likely to be looking
 * at simultaneously, and a reply that only appears on reload is a conversation
 * with a delay nobody can see the reason for.
 */
export default function PostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { community: myCommunity } = useCommunity();

  const [post, setPost] = useState(null);
  const [community, setCommunity] = useState(null);
  const [loading, setLoading] = useState(true);

  const [comments, setComments] = useState([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const [liked, setLiked] = useState(false);
  useEffect(() => { setLiked((user?.likedPostIds || []).includes(id)); }, [user?.likedPostIds, id]);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    getPost(id)
      .then(async (p) => {
        if (cancelled) return;
        setPost(p);
        // The community is what the card is addressed to — its name and photo
        // are the identity on the row, so a thread opened from a shared link
        // has to fetch it rather than inherit it from the feed.
        if (p?.communityId) {
          const c = await getCommunity(p.communityId).catch(() => null);
          if (!cancelled) setCommunity(c);
        }
      })
      .catch((err) => logger.error("postDetail.load", err?.message, { postId: id, code: err?.code }))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // The audience the query has to name — the caller's own community, or the
  // public flag. A post from somebody else's public community is read through
  // the second, which is exactly how the discovery feed reached it.
  const sameCommunity = !!post?.communityId && post.communityId === myCommunity?.id;

  useEffect(() => {
    if (!post?.id) return undefined;
    return watchComments(
      { postId: post.id, communityId: sameCommunity ? post.communityId : null },
      {
        onRows: setComments,
        onError: (err) => logger.error("postDetail.comments", err?.message, { code: err?.code }),
      }
    );
  }, [post?.id, post?.communityId, sameCommunity]);

  async function send(e) {
    e.preventDefault();
    if (sending || !body.trim() || !post?.id || !user?.id) return;
    setSending(true);
    setError("");
    try {
      await createComment({
        postId: post.id,
        // Copied from the post, and re-checked against it by the rules: a reply
        // is exactly as visible as the thing it replies to, never more.
        communityId: post.communityId,
        isPublic: post.isPublic === true,
        authorId: user.id,
        authorName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
        photoURL: user.photoURL || "",
        body: body.trim(),
      });
      setBody("");
      // The subscription brings the reply back; only the counter on the card
      // above is this screen's own copy to move.
      setPost((prev) => (prev ? { ...prev, commentCount: (prev.commentCount || 0) + 1 } : prev));
    } catch (err) {
      logger.error("postDetail.send", err?.message, { code: err?.code });
      setError(writeError(err));
    } finally {
      setSending(false);
    }
  }

  async function removeComment(comment) {
    try {
      await deleteComment({ id: comment.id, postId: post.id });
      setPost((prev) => (prev ? { ...prev, commentCount: Math.max(0, (prev.commentCount || 0) - 1) } : prev));
    } catch (err) {
      logger.error("postDetail.delete", err?.message, { commentId: comment.id, code: err?.code });
      setError(writeError(err));
    }
  }

  async function onLike() {
    if (!user?.id || !post?.id) return;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setPost((prev) => (prev
      ? { ...prev, likeCount: Math.max(0, (prev.likeCount || 0) + (wasLiked ? -1 : 1)) }
      : prev));
    try {
      await togglePostLike({
        postId: post.id, userId: user.id, likedPostIds: user.likedPostIds || [], liked: !wasLiked,
      });
      refresh();
    } catch (err) {
      logger.error("postDetail.like", err?.message, { postId: post.id });
      setLiked(wasLiked);
      setPost((prev) => (prev
        ? { ...prev, likeCount: Math.max(0, (prev.likeCount || 0) + (wasLiked ? 1 : -1)) }
        : prev));
    }
  }

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <Header onBack={() => navigate(-1)} />
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      </MobileShell>
    );
  }

  if (!post) {
    return (
      <MobileShell withNav={false}>
        <Header onBack={() => navigate(-1)} />
        <EmptyState title={t.postNotFound} />
      </MobileShell>
    );
  }

  return (
    <MobileShell
      withNav={false}
      // Its own surface, unlike the bare action bar a book page puts here: a
      // composer is a place to type, and text scrolling behind the field you
      // are typing into is the one thing this bar must not allow. Same material
      // and hairline as the chat composer, the other place in the app where you
      // write into a list.
      bottomBarSurface
      bottomBar={
        <form onSubmit={send} className="flex items-end gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t.writeComment}
            rows={1}
            className="input flex-1 resize-none py-2.5"
          />
          <button
            type="submit"
            disabled={sending || !body.trim()}
            aria-label={t.submit}
            className="shrink-0 w-11 h-11 rounded-full bg-brand-500 text-white inline-flex items-center justify-center active:scale-95 transition disabled:opacity-50"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 12.2 20.5 4l-6.2 16.5-2.6-6.9-8.2-1.4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      }
    >
      <Header onBack={() => navigate(-1)} />

      <PostCard
        post={post}
        community={community}
        liked={liked}
        likeCount={post.likeCount || 0}
        onLike={onLike}
        likeDisabled={!user?.id}
        standalone
      />

      {error ? <p className="px-4 mt-3 text-bad text-[13px]">{error}</p> : null}

      {comments.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-ink-500 text-[14px]">{t.noComments}</p>
          <p className="text-ink-300 text-[13px] mt-1">{t.noCommentsHint}</p>
        </div>
      ) : (
        <ul>
          {comments.map((c) => (
            <li key={c.id} className="flex gap-3 px-4 py-3 border-b border-ink-100">
              <Avatar src={c.photoURL} name={c.authorName || "?"} size={36} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-[14px] truncate">{c.authorName || t.deletedUser}</span>
                  <span className="text-[12px] text-ink-300 shrink-0">{formatPostStamp(c.createdAt)}</span>
                </div>
                <p className="text-[15px] text-ink-900 whitespace-pre-wrap leading-relaxed mt-0.5">{c.body}</p>
              </div>
              {/* Only on your own reply. An admin may remove anybody's — the
                  rules say so — but that belongs on a moderation screen, not as
                  a bin beside every line of a conversation. */}
              {c.authorId === user?.id ? (
                <button
                  onClick={() => removeComment(c)}
                  aria-label={t.delete}
                  className="shrink-0 w-8 h-8 rounded-lg text-ink-300 inline-flex items-center justify-center active:scale-95 transition"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 7h14M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </MobileShell>
  );
}

function Header({ onBack }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <button onClick={onBack} aria-label={t.back} className="icon-btn shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <h1 className="text-[18px] font-bold flex-1 truncate">{t.comments}</h1>
    </div>
  );
}
