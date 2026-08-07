import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import LikeButton from "../../components/LikeButton.jsx";
import {
  listPostsByCommunity, listPublicPosts, getCommunity,
  searchCommunities, searchUsers, togglePostLike,
} from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";
import { formatPostDate } from "../../utils/time.js";
import { t } from "../../utils/i18n.js";

export default function Home() {
  const { user, refresh } = useAuth();
  const { community }     = useCommunity();

  const [feed, setFeed]             = useState([]);   // enriched posts with communityMeta
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [foundComs, setFoundComs]   = useState([]);

  // The feed is two shelves, in this order: everything from the community the
  // user belongs to, then everything public from the rest.
  //
  // It is two queries because it has to be. A single query cannot say "mine OR
  // public" — Firestore has no OR across different fields with one sort — and
  // the security rule wants each query to name the ground it stands on: the
  // membership one for the first, the `isPublic` flag for the second. Merging
  // is what keeps the user's own community first without hiding everyone else.
  //
  // The two overlap whenever the user's community is public, so the second list
  // is filtered against the first by id.
  //
  // A failure in one shelf must not empty the other: `allSettled` means a user
  // with no community still gets discovery, and a discovery query that trips an
  // index still leaves the member's own noticeboard intact.
  useEffect(() => {
    const communityId = user?.communityId ?? null;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const [mineResult, publicResult] = await Promise.allSettled([
          communityId ? listPostsByCommunity(communityId, 100) : Promise.resolve([]),
          listPublicPosts(),
        ]);

        if (mineResult.status === "rejected") {
          logger.error("home.feed.mine", mineResult.reason?.message, {
            code: mineResult.reason?.code, communityId,
          });
        }
        if (publicResult.status === "rejected") {
          logger.error("home.feed.public", publicResult.reason?.message, {
            code: publicResult.reason?.code,
          });
        }

        const mine = mineResult.status === "fulfilled" ? mineResult.value : [];
        const discovered = publicResult.status === "fulfilled" ? publicResult.value : [];

        const seen = new Set(mine.map((p) => p.id));
        const others = discovered.filter((p) => !seen.has(p.id));
        const ordered = [...mine, ...others];

        // One fetch per distinct community in the feed, not per post — the
        // header needs a name and a photo, and a page of posts is usually a
        // handful of communities. The one already in context is free.
        const ids = [...new Set(ordered.map((p) => p.communityId).filter(Boolean))];
        const metaEntries = await Promise.all(
          ids.map(async (id) => [
            id,
            community?.id === id ? community : await getCommunity(id).catch(() => null),
          ])
        );
        if (cancelled) return;

        const metaById = new Map(metaEntries);
        setFeed(ordered.map((p) => ({ ...p, communityMeta: metaById.get(p.communityId) ?? null })));
      } catch (err) {
        if (!cancelled) {
          logger.error("home.feed", err?.message, { code: err?.code, communityId });
          setFeed([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [community, user?.communityId]);

  // ── Likes ───────────────────────────────────────────────────────────────────
  //
  // The heart flips on tap and the writes happen behind it. A like is not worth
  // a spinner, and it is not worth a round trip before the UI admits it
  // happened — but it is worth being honest when the write fails, so a failure
  // puts the card back the way it was.
  const [likedIds, setLikedIds] = useState(() => new Set(user?.likedPostIds || []));
  useEffect(() => {
    setLikedIds(new Set(user?.likedPostIds || []));
  }, [user?.likedPostIds]);

  async function onLike(post) {
    if (!user?.id) return;
    const wasLiked = likedIds.has(post.id);

    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(post.id); else next.add(post.id);
      return next;
    });
    setFeed((list) => list.map((p) => (
      p.id === post.id
        ? { ...p, likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? -1 : 1)) }
        : p
    )));

    try {
      await togglePostLike({
        postId: post.id,
        userId: user.id,
        likedPostIds: user.likedPostIds || [],
        liked: !wasLiked,
      });
      refresh();
    } catch (err) {
      logger.error("home.like", err?.message, { postId: post.id });
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (wasLiked) next.add(post.id); else next.delete(post.id);
        return next;
      });
      setFeed((list) => list.map((p) => (
        p.id === post.id
          ? { ...p, likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? 1 : -1)) }
          : p
      )));
    }
  }

  // Search
  useEffect(() => {
    if (!search) { setFoundUsers([]); setFoundComs([]); return; }
    Promise.all([searchUsers(search), searchCommunities(search)]).then(([u, c]) => {
      setFoundUsers(u);
      setFoundComs(c);
    });
  }, [search]);

  return (
    <MobileShell>
      <div className="pb-2">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Пайдаланушы немесе қоғамдастық іздеу"
          showFilter={false}
          rightSlot={
            /* Liked posts. It sits next to the search field rather than on the
               profile because it belongs to the feed — it is where the hearts
               tapped below end up. */
            <Link
              to="/profile/liked"
              aria-label={t.likedPosts}
              className="shrink-0 w-10 h-10 inline-flex items-center justify-center text-brand-500 active:scale-90 transition"
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 20.5s-7.5-4.7-7.5-10.4a4.3 4.3 0 0 1 7.5-2.85 4.3 4.3 0 0 1 7.5 2.85c0 5.7-7.5 10.4-7.5 10.4Z"
                  stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
                />
              </svg>
            </Link>
          }
        />
      </div>

      {/* ── Search results ── */}
      {search ? (
        <div className="px-4 mt-2 space-y-3">
          {foundComs.length > 0 && (
            <section>
              <h3 className="section-title mb-2">Қоғамдастықтар</h3>
              <ul className="card divide-y divide-ink-100">
                {foundComs.map((c) => (
                  <li key={c.id}>
                    <Link to={`/community/${c.id}`} className="flex items-center gap-3 px-4 py-3">
                      <Avatar src={c.photoURL} name={c.name} size={36} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{c.name}</p>
                        <p className="text-[13px] text-ink-500">@{c.nickname}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {foundUsers.length > 0 && (
            <section>
              <h3 className="section-title mb-2">Пайдаланушылар</h3>
              <ul className="card divide-y divide-ink-100">
                {foundUsers.map((u) => (
                  <li key={u.id}>
                    <Link to={`/users/${u.id}`} className="flex items-center gap-3 px-4 py-3">
                      <Avatar src={u.photoURL} name={`${u.firstName} ${u.lastName}`} size={36} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{u.firstName} {u.lastName}</p>
                        <p className="text-[13px] text-ink-500">@{u.nickname}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {foundUsers.length === 0 && foundComs.length === 0 && (
            <p className="text-center text-ink-500 py-8">Ештеңе табылмады</p>
          )}
        </div>
      ) : (
        /* ── Community feed ── */
        <div className="mt-1">
          {loading ? (
            <div>
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3 px-4 py-4 border-b border-ink-100 animate-pulse">
                  <div className="w-11 h-11 rounded-full bg-ink-100 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-28 rounded bg-ink-100" />
                    <div className="h-3 w-full rounded bg-ink-100" />
                    <div className="h-3 w-2/3 rounded bg-ink-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : feed.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-ink-100 mx-auto flex items-center justify-center mb-4">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-ink-400">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="font-medium text-ink-600">Жазба жоқ</p>
              <p className="text-[13px] text-ink-400 mt-1">Қоғамдастықтардың жазбалары осында пайда болады</p>
            </div>
          ) : (
            /* One row per post, separated by a hairline — no cards. The three
               columns are fixed so the feed reads as a single column of text:
               avatar, the post, then the date and its heart stacked at the
               right edge. */
            <ul className="pb-4">
              {feed.map((p, idx) => {
                const isOwnCommunity = p.communityId === community?.id;
                const prevIsOwnCommunity = idx > 0 && feed[idx - 1].communityId === community?.id;
                const showDivider = idx > 0 && !isOwnCommunity && prevIsOwnCommunity;

                return (
                  <li key={p.id}>
                    {/* Where the user's own community ends and discovery begins */}
                    {showDivider && (
                      <div className="flex items-center gap-3 px-4 py-3">
                        <div className="flex-1 h-px bg-ink-100" />
                        <p className="text-[11px] text-ink-400 font-medium shrink-0">
                          {t.otherCommunities}
                        </p>
                        <div className="flex-1 h-px bg-ink-100" />
                      </div>
                    )}

                    <article className="flex gap-3 px-4 py-4 border-b border-ink-100">
                      <Link to={`/community/${p.communityId}`} className="shrink-0 active:opacity-70 transition">
                        <Avatar
                          src={p.communityMeta?.photoURL}
                          name={p.communityMeta?.name ?? "?"}
                          size={44}
                        />
                      </Link>

                      <div className="flex-1 min-w-0">
                        <Link
                          to={`/community/${p.communityId}`}
                          className="font-bold text-[15px] text-brand-700 active:opacity-70 transition"
                        >
                          {p.communityMeta?.nickname
                            ? p.communityMeta.nickname
                            : p.communityMeta?.name}
                        </Link>

                        {/* The title carries the same weight as the handle above
                            it, so a post that has one reads as a headline and a
                            post that is only text still looks like the design. */}
                        {p.title ? (
                          <p className="text-[15px] text-ink-900 font-semibold leading-snug mt-1">
                            {p.title}
                          </p>
                        ) : null}
                        {p.body ? (
                          <p className="text-[15px] text-ink-900 whitespace-pre-wrap leading-relaxed mt-0.5">
                            {p.body}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex flex-col items-end gap-3 shrink-0 w-14">
                        <span className="text-[12px] text-ink-300 tabular-nums">
                          {formatPostDate(p.createdAt)}
                        </span>
                        <LikeButton
                          liked={likedIds.has(p.id)}
                          count={p.likeCount || 0}
                          onClick={() => onLike(p)}
                          disabled={!user?.id}
                        />
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </MobileShell>
  );
}
