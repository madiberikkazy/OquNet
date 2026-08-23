import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import {
  listCommunities, searchCommunities,
  listUsersByCommunity,
} from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";

export default function JoinCommunity() {
  const navigate = useNavigate();
  const [communities, setCommunities] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    (search ? searchCommunities(search) : listCommunities()).then(async (rows) => {
      // Member counts only. A book count would mean reading the shelves of
      // every community on this screen — which is exactly what somebody
      // browsing from the outside is not entitled to do, and the security
      // rules now say so. Profiles stay public enough to be counted; books
      // belong to their community.
      const enriched = await Promise.all(
        rows.map(async (c) => {
          const members = await listUsersByCommunity(c.id).catch(() => []);
          return { ...c, memberCount: members.length };
        })
      );
      setCommunities(enriched);
      setLoading(false);
    });
  }, [search]);

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-3 px-4 mb-2">
        <button onClick={() => navigate(-1)} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold">{t.communitiesTitle}</h1>
      </div>

      <SearchBar value={search} onChange={setSearch} showFilter={false} />

      {loading ? (
        <p className="text-center text-ink-400 text-[14px] mt-10">{t.loading}</p>
      ) : (
        <ul className="mt-3 px-4 space-y-3">
          {communities.length === 0 ? (
            <li className="py-10 text-center text-ink-500">
              {search ? t.noResults : t.noCommunitiesYet}
            </li>
          ) : (
            communities.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => navigate(`/community/${c.id}`)}
                  className="w-full card flex items-center gap-3 px-4 py-3 text-left active:scale-[0.99] transition"
                >
                  <Avatar src={c.photoURL} name={c.name} size={48} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-[15px] truncate">{c.name}</p>
                      {c.isPrivate && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-ink-400 shrink-0">
                          <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      )}
                    </div>
                    <p className="text-[13px] text-ink-500">@{c.nickname}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-[12px] text-ink-400">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <circle cx="9" cy="7" r="3" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M3 21c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <path d="M16 3.1a3 3 0 0 1 0 5.8M21 21c0-2.7-1.7-5-4-5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                        {t.memberCount(c.memberCount)}
                      </span>
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </MobileShell>
  );
}
