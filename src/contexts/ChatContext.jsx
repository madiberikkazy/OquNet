import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { getUserById, watchChatsForUser, unreadFor } from "../firebase/firestore.js";
import { sendNotification } from "../utils/notificationService.js";
import { peerName } from "../utils/chatPeer.js";
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

  useMessageNotifications(ordered, userId);

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

/**
 * Announce an arriving message in the phone's own notification tray.
 *
 * A message used to move a badge and nothing else, which meant the app had to
 * be looked at to learn that somebody had written — the one thing a chat is not
 * supposed to require. The subscription above already knows the moment a
 * message lands; this turns that into the notification.
 *
 * ── What it will and will not reach ──────────────────────────────────────────
 * This fires wherever the app is *running*: on another screen, or in the
 * background with the tab alive. It cannot fire when the app has been closed —
 * nothing of ours is running to notice, and a page cannot ask to be woken. That
 * needs a push subscription and a server to send to it, which is a separate
 * piece of infrastructure and not something this hook can stand in for.
 *
 * Four things are deliberately not announced: the reader's own messages, a
 * thread they are looking at right now, anything already read on another
 * device, and the whole backlog on the first snapshot after opening the app —
 * a list arriving is not five messages arriving.
 */
function useMessageNotifications(chats, userId) {
  const { pathname } = useLocation();
  // The route is read through a ref so that opening a chat does not re-run the
  // announcement effect over an unchanged list — it is a condition checked at
  // the moment a message lands, not an input the effect depends on.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  /** chatId -> the stamp of the newest message already accounted for. */
  const seenRef = useRef(new Map());
  const seededRef = useRef(false);
  /** Profiles resolved for a title, kept so a busy thread is one lookup. */
  const peerRef = useRef(new Map());

  // A different account is a different inbox: forget everything, and take the
  // next list as the new baseline rather than announcing it.
  useEffect(() => {
    seenRef.current = new Map();
    peerRef.current = new Map();
    seededRef.current = false;
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const seen = seenRef.current;

    // The first list is the starting position, not news. Without this, opening
    // the app would fire a notification for every unread conversation in it.
    if (!seededRef.current) {
      chats.forEach((chat) => seen.set(chat.id, toMillis(chat.lastMessage?.at)));
      seededRef.current = true;
      return;
    }

    for (const chat of chats) {
      const at = toMillis(chat.lastMessage?.at);
      // `<=` rather than `!==`: a local write whose serverTimestamp has not
      // resolved reads as 0 here, and must not count as newer than what it
      // replaces.
      if (at <= (seen.get(chat.id) ?? 0)) continue;
      seen.set(chat.id, at);

      const senderId = chat.lastMessage?.senderId;
      if (!senderId || senderId === userId) continue;      // my own message
      if (unreadFor(chat, userId) === 0) continue;          // read elsewhere
      if (pathRef.current === `/chats/${senderId}`) continue; // on that screen

      announce(chat, senderId, peerRef.current);
    }
  }, [chats, userId]);
}

async function announce(chat, senderId, peerCache) {
  try {
    if (!peerCache.has(senderId)) {
      peerCache.set(senderId, await getUserById(senderId).catch(() => null));
    }
    const sender = peerCache.get(senderId);

    await sendNotification(peerName(sender), {
      body: chat.lastMessage?.text ?? "",
      // One notification per conversation: a second message replaces the first
      // rather than stacking, the way every messaging app behaves.
      tag: `chat-${chat.id}`,
      // The chat route is keyed by the other person, and here that is whoever
      // sent this. Tapping opens the thread — sw.js reads this in
      // `notificationclick`.
      data: { url: `/chats/${senderId}` },
    });
  } catch (err) {
    logger.warn("chats.notify", err?.message, { chatId: chat.id });
  }
}
