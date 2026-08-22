import { useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import LikeButton from "./LikeButton.jsx";
import { logger } from "../utils/logger.js";
import { formatPostStamp } from "../utils/time.js";
import { t } from "../utils/i18n.js";

/**
 * One post, wherever it is shown — the feed and the thread screen both draw it
 * with this, so a post cannot look like two different things depending on which
 * screen you reached it from.
 *
 * The layout is the one every feed has settled on, and each part of it is doing
 * a job: the avatar and the name identify the writer, the age of the post sits
 * on the same line because it is part of that identification, the text runs the
 * full width under both, and the three things you can do with it are a row at
 * the bottom rather than a column in the margin. The old arrangement had the
 * date and the heart stacked in a fixed 56px gutter on the right, which was
 * fine for one action and had nowhere to put a second.
 *
 * Two names, and the writer's is the first of them. A post is addressed to a
 * community, but it is *written by a person* — and now that anybody in the
 * community can write one, the name a reader looks for is theirs. So the author
 * takes the top line and the weight that goes with it, and the community drops
 * to the quieter line beneath, where it still says where this was posted. Each
 * name links to the thing it names.
 *
 * A post written before authors were recorded has no name to promote; the
 * community keeps the top line on those rather than leaving it blank.
 */
export default function PostCard({
  post,
  community = null,
  liked = false,
  likeCount = 0,
  onLike,
  likeDisabled = false,
  /** Full text and no link to itself — the thread screen showing its own post. */
  standalone = false,
}) {
  const stamp = formatPostStamp(post.createdAt);
  const handle = community?.nickname || community?.name || "";

  return (
    <article className="flex gap-3 px-4 py-4 border-b border-ink-100">
      <Link to={`/community/${post.communityId}`} className="shrink-0 active:opacity-70 transition">
        <Avatar src={community?.photoURL} name={community?.name ?? "?"} size={44} />
      </Link>

      <div className="flex-1 min-w-0">
        {/* The stamp is pushed to the far edge by `ml-auto` rather than sitting
            a space after the name: right-aligned it makes a column down the
            feed, and a name of any length stops moving it about. */}
        <div className="flex items-baseline gap-2">
          {post.authorName ? (
            <Link
              to={`/users/${post.authorId}`}
              className="font-bold text-[15px] text-brand-700 truncate active:opacity-70 transition"
            >
              {post.authorName}
            </Link>
          ) : (
            <Link
              to={`/community/${post.communityId}`}
              className="font-bold text-[15px] text-brand-700 truncate active:opacity-70 transition"
            >
              {handle}
            </Link>
          )}
          {stamp ? <span className="ml-auto text-[12px] text-ink-300 shrink-0">{stamp}</span> : null}
        </div>

        {post.authorName && handle ? (
          <Link
            to={`/community/${post.communityId}`}
            className="block text-[13px] text-ink-500 leading-snug truncate active:opacity-70 transition"
          >
            {handle}
          </Link>
        ) : null}

        {/* `title` only exists on posts written before the field was dropped. */}
        {post.title ? (
          <p className="text-[15px] text-ink-900 font-semibold leading-snug mt-1">{post.title}</p>
        ) : null}
        {post.body ? (
          <p className={
            "text-[15px] text-ink-900 whitespace-pre-wrap leading-relaxed mt-0.5" +
            // In the feed a very long notice is clipped rather than pushing
            // every other post off the screen; opening it shows all of it.
            (standalone ? "" : " line-clamp-6")
          }>
            {post.body}
          </p>
        ) : null}

        <div className="flex items-center gap-5 mt-3 -ml-1">
          <LikeButton
            liked={liked}
            count={likeCount}
            onClick={onLike}
            disabled={likeDisabled}
            size={22}
            inline
          />
          <CommentAction post={post} standalone={standalone} />
          <ShareAction post={post} handle={handle} />
        </div>
      </div>
    </article>
  );
}

/**
 * The reply count, and the way into the thread.
 *
 * A link, not a button — the thread is a place, so it deserves a URL, and this
 * is the only control here that navigates. On the thread screen itself it stops
 * being a link and just states the number: a link that leads where you already
 * are is a dead tap.
 */
function CommentAction({ post, standalone }) {
  const total = Math.max(0, Math.round(Number(post.commentCount) || 0));
  const inner = (
    <>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
      <span className="text-[12px] font-medium tabular-nums">{total}</span>
    </>
  );
  const className = "inline-flex items-center gap-1.5 text-ink-500 transition";

  if (standalone) {
    return <span className={className} aria-label={`${t.comments} (${total})`}>{inner}</span>;
  }
  return (
    <Link to={`/posts/${post.id}`} aria-label={`${t.comments} (${total})`} className={className + " active:scale-90"}>
      {inner}
    </Link>
  );
}

/**
 * Passing a post on.
 *
 * The OS share sheet where there is one — on a phone that is the whole point,
 * since it is the sheet the reader already knows and it reaches every app they
 * have. Everywhere else the link goes to the clipboard and the button says so
 * for a moment, because a share button that appears to do nothing is worse than
 * no share button. Same arrangement the profile's share has.
 */
function ShareAction({ post, handle }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/posts/${post.id}`;

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ text: t.sharePostText(handle || t.app), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // A cancelled share sheet rejects exactly like a failure does, and it is
      // by far the more common of the two — logged, never surfaced.
      logger.warn("post.share", err?.message, { postId: post.id });
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      aria-label={t.forward}
      className="relative inline-flex items-center text-ink-500 transition active:scale-90"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M3.5 12.2 20.5 4l-6.2 16.5-2.6-6.9-8.2-1.4Z"
          stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
        />
      </svg>
      {copied ? (
        <span
          className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink-900 px-2 py-1 text-[11px] font-medium"
          style={{ color: "var(--bg-base)" }}
        >
          {t.linkCopied}
        </span>
      ) : null}
    </button>
  );
}
