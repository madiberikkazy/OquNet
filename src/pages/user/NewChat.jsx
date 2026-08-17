import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useChats } from "../../contexts/ChatContext.jsx";
import { listUsersByCommunity, otherMemberId, searchUsers } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

/**
 * Who to talk to.
 *
 * Two ways in, because there are two questions being asked. Left alone, it
 * lists the reader's own community — the people they actually share books with,
 * which is who a message is usually for. Typed into, it searches every account
 * by nickname, the same prefix search Home uses, because the other case is
 * looking for one specific person who may be nowhere near.
 *
 * Nobody already in a conversation appears in the default list: that thread is
 * one tap away on the previous screen, and offering it here as a "new" chat
 * would suggest a second one is possible. Search still finds them — searching
 * for a name you already talk to should not come back empty — and tapping any
 * row lands in the same thread either way, since the id is the pair.
 */
export default function NewChat() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { chats } = useChats();

  const [search, setSearch] = useState("");
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState(false);

  const selfId = user?.id ?? null;
  const communityId = user?.communityId ?? null;

  // Everyone the reader is already talking to — excluded from the suggestions
  // below, and the reason this screen needs the chat list at all.
  const talkingTo = useMemo(
    () => new Set(chats.map((chat) => otherMemberId(chat, selfId)).filter(Boolean)),
    [chats, selfId]
  );

  const membersQuery = useQuery({
    queryKey: qk.chats.candidates(communityId),
    enabled: !!communityId,
    staleTime: 60_000,
    queryFn: () => listUsersByCommunity(communityId),
  });

  const suggestions = useMemo(
    () => (membersQuery.data ?? []).filter((u) => u.id !== selfId && !talkingTo.has(u.id)),
    [membersQuery.data, selfId, talkingTo]
  );

  // Debounced, because this runs a query per keystroke otherwise — the same
  // shape Home's search has, with a pause added: that one filters a feed the
  // reader is already looking at, this one is the whole screen.
  useEffect(() => {
    const term = search.trim();
    if (!term) { setFound([]); setSearching(false); return undefined; }

    setSearching(true);
    const timer = setTimeout(() => {
      searchUsers(term)
        .then((rows) => setFound(rows.filter((u) => u.id !== selfId)))
        .catch((err) => {
          logger.error("newChat.search", err?.message, { code: err?.code });
          setFound([]);
        })
        .finally(() => setSearching(false));
    }, 250);

    return () => clearTimeout(timer);
  }, [search, selfId]);

  const showing = search.trim() ? found : suggestions;
  const loading = search.trim() ? searching : membersQuery.isLoading;

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[18px] font-bold flex-1 truncate">{t.newChat}</h1>
      </div>

      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder={t.newChatSearch}
        showFilter={false}
      />

      {!search.trim() && suggestions.length > 0 ? (
        <h3 className="section-title px-4 mt-4 mb-1">{t.newChatFromCommunity}</h3>
      ) : null}

      {loading ? (
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
      ) : showing.length === 0 ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">
          {search.trim() ? t.noResults : t.newChatNobody}
        </p>
      ) : (
        <ul className="mt-1">
          {showing.map((person) => (
            <li key={person.id}>
              <button
                onClick={() => navigate(`/chats/${person.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3 border-b border-ink-100 active:bg-ink-100/40 transition text-left"
              >
                <Avatar src={person.photoURL} name={peerName(person)} size={44} />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-[15px] truncate">{peerName(person)}</span>
                  {person.nickname ? (
                    <span className="block text-[13px] text-ink-500 truncate">@{person.nickname}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </MobileShell>
  );
}
