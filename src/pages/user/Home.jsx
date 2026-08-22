import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { useNotifications } from "../../contexts/NotificationContext.jsx";
import PostCard from "../../components/PostCard.jsx";
import AppIcon from "../../components/AppIcon.jsx";
import Fab from "../../components/Fab.jsx";
import {
  watchPostsByCommunity, watchPublicPosts, getCommunity,
  searchCommunities, searchUsers, togglePostLike,
} from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";
import { navIconSrc } from "../../utils/icons.js";
import { t } from "../../utils/i18n.js";

export default function Home() {
  const { user, refresh } = useAuth();
  const { community }     = useCommunity();
  const { unreadCount }   = useNotifications();

  const [search, setSearch]         = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [foundComs, setFoundComs]   = useState([]);

  const communityId = user?.communityId ?? null;

  // ── The feed ────────────────────────────────────────────────────────────────
  //
  // Two shelves, in this order: everything from the community the user belongs
  // to, then everything public from the rest. Everyone signed in gets the second
  // shelf, member of anything or not — a public community's notices are public.
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
  // Both are subscriptions rather than one-shot reads. That is what makes the
  // rest of this screen true for more than an instant: a post published by
  // somebody else appears without a reload, and a like landing on a post already
  // on screen moves the number *every* reader sees, not just the one who tapped.
  //
  // A failure in one shelf must not empty the other, so each keeps its own
  // loaded flag: a user with no community still gets discovery, and a discovery
  // query that trips an index still leaves the member's own noticeboard intact.
  const [mine, setMine]                       = useState([]);
  const [discovered, setDiscovered]           = useState([]);
  const [mineLoaded, setMineLoaded]           = useState(false);
  const [discoveredLoaded, setDiscoveredLoaded] = useState(false);

  useEffect(() => {
    if (!communityId) { setMine([]); setMineLoaded(true); return; }
    setMineLoaded(false);
    return watchPostsByCommunity(communityId, {
      onRows: (rows) => { setMine(rows); setMineLoaded(true); },
      onError: (err) => {
        logger.error("home.feed.mine", err?.message, { code: err?.code, communityId });
        setMine([]);
        setMineLoaded(true);
      },
    });
  }, [communityId]);

  useEffect(() => {
    setDiscoveredLoaded(false);
    return watchPublicPosts({
      onRows: (rows) => { setDiscovered(rows); setDiscoveredLoaded(true); },
      onError: (err) => {
        logger.error("home.feed.public", err?.message, { code: err?.code });
        setDiscovered([]);
        setDiscoveredLoaded(true);
      },
    });
  }, []);

  const loading = !mineLoaded || !discoveredLoaded;

  const ordered = useMemo(() => {
    const seen = new Set(mine.map((p) => p.id));
    return [...mine, ...discovered.filter((p) => !seen.has(p.id))];
  }, [mine, discovered]);

  // One fetch per distinct community in the feed, not per post — the header
  // needs a name and a photo, and a page of posts is usually a handful of
  // communities. Cached across snapshots too: a like changes the posts, never
  // who published them, so re-fetching on every update would be one round trip
  // per heart tapped anywhere in the feed. The one already in context is free.
  const metaCache = useRef(new Map());
  const [metaById, setMetaById] = useState(() => new Map());
  const metaKey = useMemo(
    () => [...new Set(ordered.map((p) => p.communityId).filter(Boolean))].sort().join(","),
    [ordered]
  );

  useEffect(() => {
    if (community?.id) metaCache.current.set(community.id, community);
    const ids = metaKey ? metaKey.split(",") : [];
    const missing = ids.filter((id) => !metaCache.current.has(id));
    if (missing.length === 0) { setMetaById(new Map(metaCache.current)); return; }

    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (id) => [id, await getCommunity(id).catch(() => null)])
      );
      if (cancelled) return;
      entries.forEach(([id, meta]) => metaCache.current.set(id, meta));
      setMetaById(new Map(metaCache.current));
    })();
    return () => { cancelled = true; };
  }, [metaKey, community]);

  const feed = useMemo(
    () => ordered.map((p) => ({ ...p, communityMeta: metaById.get(p.communityId) ?? null })),
    [ordered, metaById]
  );

  // ── Likes ───────────────────────────────────────────────────────────────────
  //
  // The heart flips on tap and the write happens behind it. A like is not worth
  // a spinner, and it is not worth a round trip before the UI admits it
  // happened — but it is worth being honest when the write fails, so a failure
  // puts the card back the way it was.
  //
  // The total is *not* patched into the feed by hand any more. The feed is a
  // subscription now, and the number in it is the server's — which is the whole
  // point, because a hand-patched total was only ever true on the device that
  // tapped. What is kept here instead is a bump held over the top of the
  // server's number until the server's number moves off `base`: Firestore
  // reports its own pending write immediately, so that is usually within a
  // frame, and the localStorage fallback — which can only poll — is why the
  // overlay exists at all.
  const [likedIds, setLikedIds] = useState(() => new Set(user?.likedPostIds || []));
  useEffect(() => {
    setLikedIds(new Set(user?.likedPostIds || []));
  }, [user?.likedPostIds]);

  const [pending, setPending] = useState(() => new Map());  // postId -> { delta, base }

  function clearPending(postId) {
    setPending((prev) => {
      if (!prev.has(postId)) return prev;
      const next = new Map(prev);
      next.delete(postId);
      return next;
    });
  }

  // Drop a bump as soon as the server's own total has moved, or the post it
  // belonged to has left the feed.
  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev;
      const live = new Map(ordered.map((p) => [p.id, p.likeCount || 0]));
      const next = new Map(prev);
      for (const [postId, held] of prev) {
        if (!live.has(postId) || live.get(postId) !== held.base) next.delete(postId);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [ordered]);

  // …and drop it regardless once the write has settled and the fallback has had
  // time to poll. The rule above handles every ordinary case — under Firestore
  // it fires in the same frame, because the SDK reports this client's own
  // pending write — but it is a rule about the number *changing*, and there are
  // two ways for it never to change: nothing to subtract, and two people
  // cancelling each other out between the tap and the answer. Without this, one
  // of those would leave a bump on screen and a heart that could not be tapped
  // again until the screen was rebuilt.
  const PENDING_GRACE_MS = 6000;
  const releaseTimers = useRef(new Map());
  useEffect(() => () => {
    releaseTimers.current.forEach((timer) => clearTimeout(timer));
    releaseTimers.current.clear();
  }, []);

  function releasePending(postId, afterMs) {
    const timers = releaseTimers.current;
    clearTimeout(timers.get(postId));
    if (!afterMs) { timers.delete(postId); clearPending(postId); return; }
    timers.set(postId, setTimeout(() => {
      timers.delete(postId);
      clearPending(postId);
    }, afterMs));
  }

  async function onLike(post) {
    // One in flight per post: a second tap before the first settles would stack
    // two bumps on one `base` and undo only one of them.
    if (!user?.id || pending.has(post.id)) return;
    const wasLiked = likedIds.has(post.id);

    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(post.id); else next.add(post.id);
      return next;
    });
    setPending((prev) => new Map(prev).set(post.id, {
      delta: wasLiked ? -1 : 1,
      base: post.likeCount || 0,
    }));

    try {
      const { likeDelta } = await togglePostLike({
        postId: post.id,
        userId: user.id,
        likedPostIds: user.likedPostIds || [],
        liked: !wasLiked,
      });
      // A delta of zero means the total was already at zero and there was
      // nothing to subtract: it will never move off `base`, so the bump comes
      // down now rather than on the grace timer.
      releasePending(post.id, likeDelta ? PENDING_GRACE_MS : 0);
      refresh();
    } catch (err) {
      logger.error("home.like", err?.message, { postId: post.id });
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (wasLiked) next.add(post.id); else next.delete(post.id);
        return next;
      });
      releasePending(post.id, 0);
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

  // Writing a post is its own screen — /posts/new. The "+" below is a link to
  // it and nothing more: a composer rendered here would be a dialog over the
  // feed, which is both a worse place to write and a `position: fixed` element
  // inside MobileShell's transformed wrapper, where it does not stay put.

  return (
    <MobileShell
      // Chrome, not content — see the slot note in MobileShell.
      //
      // Hidden while searching: the screen is a list of people and communities
      // then, and a "+" over it would be about something else entirely.
      fab={!search && community?.id ? (
        <Fab fixed to="/posts/new" ariaLabel={t.newPost} />
      ) : null}
      header={
      <div className="pb-2">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Пайдаланушы немесе қоғамдастық іздеу"
          showFilter={false}
          rightSlot={
            <>
              {/* Liked posts. It sits next to the search field rather than on
                  the profile because it belongs to the feed — it is where the
                  hearts tapped below end up. */}
              <Link
                to="/profile/liked"
                aria-label={t.likedPosts}
                className="shrink-0 w-10 h-10 inline-flex items-center justify-center active:scale-90 transition"
              >
                <AppIcon name="heart" size={26} alt={t.likedPosts} />
              </Link>

              {/* The bell. It used to be a tab of its own; the conversations
                  list has that place now, and notifications keep their badge
                  up here — on the one screen everybody opens first. */}
              <Link
                to="/notifications"
                aria-label={t.navNotification}
                className="relative shrink-0 w-10 h-10 inline-flex items-center justify-center active:scale-90 transition"
              >
                <img
                  src={navIconSrc("notification", false)}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  style={{ width: 24, height: 24 }}
                  className="shrink-0 select-none"
                  draggable={false}
                />
                {unreadCount > 0 ? (
                  <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </Link>
            </>
          }
        />
      </div>
      }
    >
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

                    <PostCard
                      post={p}
                      community={p.communityMeta}
                      liked={likedIds.has(p.id)}
                      likeCount={(p.likeCount || 0) + (pending.get(p.id)?.delta ?? 0)}
                      onLike={() => onLike(p)}
                      likeDisabled={!user?.id}
                    />
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
