import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import { Skeleton } from "../../components/Skeleton.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useChats } from "../../contexts/ChatContext.jsx";
import { getUserById, otherMemberId, unreadFor } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { formatChatStamp } from "../../utils/time.js";
import { peerName } from "../../utils/chatPeer.js";
import { t } from "../../utils/i18n.js";

/**
 * Every conversation the reader is in, most recent first.
 *
 * The rows come from one subscription (ChatContext) and the people in them from
 * one batched fetch: a chat document names its members but not their names, and
 * a profile lookup per row on every snapshot would be a fetch storm every time
 * anybody typed anything. Keyed on the set of ids, so it re-runs when the
 * *cast* changes and not when the messages do.
 */
export default function Chats() {
  const { user } = useAuth();
  const { chats, loading } = useChats();
  const [search, setSearch] = useState("");

  // Rows whose other member cannot be identified are dropped rather than drawn:
  // a chat the reader is somehow not in has no peer to name, and there is
  // nothing useful to put in the row.
  const rows = useMemo(
    () =>
      chats
        .map((chat) => ({ chat, peerId: otherMemberId(chat, user?.id) }))
        .filter((row) => !!row.peerId),
    [chats, user?.id]
  );

  const peerIds = useMemo(
    () => [...new Set(rows.map((r) => r.peerId))].sort(),
    [rows]
  );

  const peersQuery = useQuery({
    queryKey: qk.chats.peers(peerIds.join(",")),
    enabled: peerIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      // A profile that has been deleted resolves to null and stays in the
      // lookup as one: the conversation still happened, and the row says so
      // rather than vanishing. Settled per id so one missing profile cannot
      // empty the whole list.
      const entries = await Promise.all(
        peerIds.map(async (id) => [id, await getUserById(id).catch(() => null)])
      );
      // A plain object, and it has to stay one. This query is persisted to
      // IndexedDB, and the persister serializes with JSON — which turns a Map
      // into `{}`. Nothing fails on the visit that writes it; the next launch
      // rehydrates the empty object, and `peers.get(...)` takes the whole
      // screen down with "peers.get is not a function". Same hazard the
      // Firestore Timestamp note in utils/time.js describes: only what JSON
      // round-trips may live in cached query data.
      return Object.fromEntries(entries);
    },
  });

  const peers = peersQuery.data ?? {};

  // Filtered at render, never before `peerIds`: narrowing that list would make
  // the profile query's key change on every keystroke, so typing would refetch
  // the cast and — worse — drop the names the filter is matching against.
  //
  // Client-side because the list is already here and already bounded. A chat
  // list is tens of rows, not thousands; a Firestore query per keystroke would
  // buy nothing and could not search the peer's name anyway, which is on their
  // profile rather than on the chat.
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(({ chat, peerId }) => {
      const peer = peers[peerId] ?? null;
      const haystack = [
        peerName(peer),
        peer?.nickname,
        // The last line of the conversation, so searching for something said
        // finds the thread it was said in.
        chat.lastMessage?.text,
      ];
      return haystack.some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [rows, peers, search]);

  return (
    <MobileShell
      header={
      <>
        <div className="px-4 pb-2 flex items-center justify-between gap-3">
          <h1 className="text-[22px] font-bold">{t.navChats}</h1>

          {/* Starting a conversation with somebody you have never messaged. The
              profile route stays the main one — you meet people through their
              books — but a chat app whose only way to start a chat is to go and
              find a profile first is a chat app missing a button. */}
          <Link
            to="/chats/new"
            aria-label={t.newChat}
            className="shrink-0 w-10 h-10 rounded-full bg-brand-500 text-white flex items-center justify-center active:scale-95 transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </Link>
        </div>

        {/* Searching what is already on screen, so it rides in the sticky bar
            with the title rather than scrolling away from the list it filters.
            Always drawn, however few conversations there are: it was once
            hidden below two of them on the grounds that a filter over one row
            is furniture, and the only thing that achieved was a search box
            nobody could find. A field that is sometimes there is worse than one
            that is always there. */}
        <div className="pb-2">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder={t.chatSearchPlaceholder}
            showFilter={false}
          />
        </div>
      </>
      }
    >
      {loading && rows.length === 0 ? (
        <ul className="mt-1">
          {[1, 2, 3, 4].map((i) => (
            <li key={i} className="flex gap-3 px-4 py-3.5 border-b border-ink-100">
              <Skeleton className="w-12 h-12 rounded-full shrink-0" />
              <div className="flex-1 space-y-2 py-1">
                <Skeleton className="h-3 w-32 rounded" />
                <Skeleton className="h-3 w-48 rounded" />
              </div>
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t.noChats}
          subtitle={t.noChatsHintPlus}
          icon={
            <svg width="120" height="120" viewBox="0 0 24 24" className="text-brand-500" fill="currentColor">
              <path d="M12 3C6.99 3 3 6.36 3 10.5c0 2.3 1.23 4.35 3.16 5.72-.14 1.2-.6 2.3-1.35 3.2a.5.5 0 0 0 .46.83c1.9-.3 3.4-1.02 4.5-1.8.7.16 1.44.25 2.23.25 5.01 0 9-3.36 9-7.5S17.01 3 12 3Z" />
            </svg>
          }
        />
      ) : visible.length === 0 ? (
        // Searched and found nothing — a different fact from having no chats,
        // and it must not offer the "start your first conversation" hint.
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">{t.noResults}</p>
      ) : (
        <ul>
          {visible.map(({ chat, peerId }) => {
            const peer = peers[peerId] ?? null;
            const unread = unreadFor(chat, user?.id);
            const mine = chat.lastMessage?.senderId === user?.id;

            return (
              <li key={chat.id}>
                <Link
                  to={`/chats/${peerId}`}
                  className="flex items-center gap-3 px-4 py-3.5 border-b border-ink-100 active:bg-ink-100/40 transition"
                >
                  <Avatar src={peer?.photoURL} name={peerName(peer)} size={48} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-[15px] truncate flex-1">
                        {peerName(peer)}
                      </p>
                      <span className="text-[12px] text-ink-500 shrink-0 tabular-nums">
                        {formatChatStamp(chat.lastMessage?.at ?? chat.updatedAt)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-0.5">
                      {/* One line, ellipsised — the preview is the whole message
                          as it was sent, not a summary of it. */}
                      <p
                        className={
                          "text-[13px] truncate flex-1 " +
                          (unread > 0 ? "text-ink-900 font-medium" : "text-ink-500")
                        }
                      >
                        {mine ? <span className="text-ink-500">{t.chatYouPrefix} </span> : null}
                        {chat.lastMessage?.text ?? ""}
                      </p>

                      {unread > 0 ? (
                        <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-brand-500 text-white text-[11px] font-bold flex items-center justify-center tabular-nums">
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </MobileShell>
  );
}
