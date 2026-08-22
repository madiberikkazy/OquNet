import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SettingsPage from "../../components/SettingsPage.jsx";
import Avatar from "../../components/Avatar.jsx";
import LikeButton from "../../components/LikeButton.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { getPostsByIds, getCommunity, togglePostLike } from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";
import { formatPostDate } from "../../utils/time.js";
import { t } from "../../utils/i18n.js";

/**
 * The posts this user has liked, newest like first.
 *
 * The order is the order of `likedPostIds`, not of the posts themselves —
 * `togglePostLike` puts each new like at the front, so this reads as a history
 * of what the user liked rather than a second copy of the feed.
 *
 * A post that has since gone private or been deleted simply isn't here: the
 * read is refused and dropped. The id stays on the profile, so if the community
 * opens up again the post comes back.
 */
export default function LikedPosts() {
  const { user, setUser } = useAuth();

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  const likedIds = user?.likedPostIds || [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await getPostsByIds(likedIds);
        const ids = [...new Set(rows.map((p) => p.communityId).filter(Boolean))];
        const meta = new Map(
          await Promise.all(ids.map(async (id) => [id, await getCommunity(id).catch(() => null)]))
        );
        if (cancelled) return;
        setPosts(rows.map((p) => ({ ...p, communityMeta: meta.get(p.communityId) ?? null })));
      } catch (err) {
        if (!cancelled) {
          logger.error("likedPosts.load", err?.message);
          setPosts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-runs when the set of liked ids changes, not on every profile write.
  }, [likedIds.join(",")]);

  async function unlike(post) {
    if (!user?.id) return;
    setPosts((list) => list.filter((p) => p.id !== post.id));
    try {
      const { likedPostIds } = await togglePostLike({
        postId: post.id,
        userId: user.id,
        likedPostIds: user.likedPostIds || [],
        liked: false,
      });
      // The stored list, straight back into the context, rather than a re-read
      // that may not land before the next tap. Two quick unlikes used to build
      // the second write from a list that still had the first post in it, which
      // put that post back on the profile with its counter already taken down.
      setUser((prev) => (prev && prev.id === user.id ? { ...prev, likedPostIds } : prev));
    } catch (err) {
      logger.error("likedPosts.unlike", err?.message, { postId: post.id });
      setPosts((list) => [post, ...list]);
    }
  }

  return (
    <SettingsPage title={t.likedPosts} backTo="/profile">
      <div className="px-4 pt-2">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card p-4 animate-pulse space-y-2">
                <div className="h-3 w-32 rounded bg-ink-100" />
                <div className="h-4 w-3/4 rounded bg-ink-100" />
                <div className="h-3 w-full rounded bg-ink-100" />
              </div>
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-ink-100 mx-auto flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-ink-300">
                <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="font-medium text-ink-600">{t.noLikedPosts}</p>
            <p className="text-[13px] text-ink-400 mt-1">{t.noLikedPostsHint}</p>
          </div>
        ) : (
          <ul className="space-y-3 pb-4">
            {posts.map((p) => (
              <li key={p.id} className="card p-4">
                <Link
                  to={`/community/${p.communityId}`}
                  className="flex items-center gap-2 mb-3 active:opacity-70 transition"
                >
                  <Avatar src={p.communityMeta?.photoURL} name={p.communityMeta?.name ?? "?"} size={28} />
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-[13px] truncate block">
                      {p.communityMeta?.name}
                    </span>
                    <span className="text-[11px] text-ink-500">@{p.communityMeta?.nickname}</span>
                  </div>
                </Link>

                <h4 className="font-semibold text-[15px] leading-snug">{p.title}</h4>
                {p.body ? (
                  <p className="text-[14px] text-ink-700 mt-1.5 whitespace-pre-wrap leading-relaxed">
                    {p.body}
                  </p>
                ) : null}

                <div className="flex items-center justify-between mt-2">
                  <LikeButton liked count={p.likeCount || 0} onClick={() => unlike(p)} />
                  <p className="text-[11px] text-ink-400">{formatPostDate(p.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsPage>
  );
}
