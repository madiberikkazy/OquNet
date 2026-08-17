import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext.jsx";
import { watchChatsForUser, unreadFor } from "../firebase/firestore.js";
import { toMillis } from "../utils/time.js";
import { logger } from "../utils/logger.js";

/**
 * The reader's conversations, once, for the whole app.
 *
 * Two screens need this list and they must not disagree: the Chats tab draws
 * it, and the badge on that tab counts it. One subscription serves both — a
 * second one would be a second Firestore listener billed per document on every
 * change, for the privilege of showing a number that could drift from the list
 * it belongs to.
 *
 * It is a subscription and not a query for the reason chat is chat: a message
 * arriving has to move the list without anybody asking it to.
 */
const ChatContext = createContext(null);

export function ChatProvider({ children }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setChats([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    return watchChatsForUser(userId, {
      onRows: (rows) => { setChats(rows); setLoading(false); },
      onError: (err) => {
        // An empty list rather than a broken screen: the tab still opens and
        // says there is nothing here, which is the truth as far as it knows.
        logger.error("chats.watch", err?.message, { code: err?.code, userId });
        setChats([]);
        setLoading(false);
      },
    });
  }, [userId]);

  // The query already sorts, so this is not the sort — it is the tie-break for
  // the moment a message has been written locally and its `serverTimestamp()`
  // has not resolved yet. Firestore reports that document with a null stamp,
  // which would drop the reader's own newest chat to the bottom of their list
  // for a frame or two. Sorting again here holds it in place.
  const ordered = useMemo(
    () => [...chats].sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt)),
    [chats]
  );

  const unreadTotal = useMemo(
    () => ordered.reduce((sum, chat) => sum + unreadFor(chat, userId), 0),
    [ordered, userId]
  );

  const value = useMemo(
    () => ({ chats: ordered, loading, unreadTotal }),
    [ordered, loading, unreadTotal]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChats() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChats must be used inside <ChatProvider>");
  return ctx;
}
