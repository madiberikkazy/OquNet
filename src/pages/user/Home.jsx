import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  listPostsByCommunity, getCommunity,
  searchCommunities, searchUsers, toMillis,
} from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";

export default function Home() {
  const { user }      = useAuth();
  const { community } = useCommunity();

  const [feed, setFeed]             = useState([]);   // enriched posts with communityMeta
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [foundComs, setFoundComs]   = useState([]);

  // The feed is the user's own community, and only theirs.
  //
  // It used to pull every post in the database and drop the private ones in the
  // browser, which is not a filter so much as a delivery mechanism: the posts
  // arrived either way. Posts are now readable only to members of the community
  // that owns them, so the query has to name a community it is allowed to read
  // — and the one community a user can read is their own.
  useEffect(() => {
    const communityId = user?.communityId ?? null;
    if (!communityId) {
      setFeed([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [posts, meta] = await Promise.all([
          listPostsByCommunity(communityId, 150),
          // `community` from context is usually already loaded; fetching it here
          // as well keeps the feed from rendering headerless on a cold start.
          community?.id === communityId ? Promise.resolve(community) : getCommunity(communityId),
        ]);
        if (cancelled) return;
        setFeed(posts.map((p) => ({ ...p, communityMeta: meta ?? null })));
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
        <div className="px-4 mt-2">
          {loading ? (
            <div className="space-y-3 mt-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="card p-4 animate-pulse space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-ink-100" />
                    <div className="h-3 w-32 rounded bg-ink-100" />
                  </div>
                  <div className="h-4 w-3/4 rounded bg-ink-100" />
                  <div className="h-3 w-full rounded bg-ink-100" />
                  <div className="h-3 w-2/3 rounded bg-ink-100" />
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
              <p className="text-[13px] text-ink-400 mt-1">Қоғамдастығыңыздың жазбалары осында пайда болады</p>
            </div>
          ) : (
            <ul className="space-y-3 pb-4">
              {feed.map((p, idx) => {
                const isOwnCommunity = p.communityId === community?.id;
                const prevIsOwnCommunity = idx > 0 && feed[idx - 1].communityId === community?.id;
                const showDivider = idx > 0 && !isOwnCommunity && prevIsOwnCommunity;

                return (
                  <li key={p.id}>
                    {/* Divider between own community posts and others */}
                    {showDivider && (
                      <div className="flex items-center gap-3 mb-3 mt-1">
                        <div className="flex-1 h-px bg-ink-100" />
                        <p className="text-[11px] text-ink-400 font-medium shrink-0">Басқа қоғамдастықтар</p>
                        <div className="flex-1 h-px bg-ink-100" />
                      </div>
                    )}

                    <div className="card p-4">
                      {/* Community header */}
                      <Link
                        to={`/community/${p.communityId}`}
                        className="flex items-center gap-2 mb-3 active:opacity-70 transition"
                      >
                        <Avatar
                          src={p.communityMeta?.photoURL}
                          name={p.communityMeta?.name ?? "?"}
                          size={28}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="font-semibold text-[13px] truncate block">
                            {p.communityMeta?.name}
                          </span>
                          <span className="text-[11px] text-ink-500">
                            @{p.communityMeta?.nickname}
                          </span>
                        </div>
                        {isOwnCommunity && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 shrink-0">
                            Сіздің
                          </span>
                        )}
                      </Link>

                      {/* Post content */}
                      <h4 className="font-semibold text-[15px] leading-snug">{p.title}</h4>
                      {p.body ? (
                        <p className="text-[14px] text-ink-700 mt-1.5 whitespace-pre-wrap leading-relaxed">
                          {p.body}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-ink-400 mt-2">
                        {p.createdAt
                          ? new Date(toMillis(p.createdAt)).toLocaleDateString("ru-RU", {
                              day: "2-digit", month: "short", year: "numeric",
                              hour: "2-digit", minute: "2-digit",
                            })
                          : ""}
                      </p>
                    </div>
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
