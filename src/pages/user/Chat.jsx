import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useChats } from "../../contexts/ChatContext.jsx";
import {
  chatIdFor, getUserById, isOnline, lastSeenAt, markChatRead, messageStatus,
  needsReadReceipt, PRESENCE_HEARTBEAT_MS, sendMessage, unreadFor, watchMessages,
} from "../../firebase/firestore.js";
import MessageTicks from "../../components/MessageTicks.jsx";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { attempt, release, retryAfterSeconds } from "../../utils/rateLimit.js";
import { track } from "../../utils/analytics.js";
import { dayStamp, formatClock, formatDayLabel, formatLastSeen, toMillis } from "../../utils/time.js";
import { t } from "../../utils/i18n.js";
import { LIMITS } from "../../utils/validators.js";

/**
 * One conversation.
 *
 * Addressed by the other person's id rather than by the chat's, because that is
 * what every entry point already has — a profile, a row in the list — and
 * because the chat id is a pure function of the pair, so there is nothing to
 * look up before the screen can open. A conversation that has never been used
 * opens exactly like one with a year of history behind it; the difference is
 * whether the query finds anything.
 *
 * The layout is three fixed rows rather than MobileShell's single scrolling
 * column: a chat has a header that stays, a history that scrolls, and a
 * composer that sits above the keyboard. Sharing the shell here would put the
 * composer at the bottom of the *history* — which is to say, wherever the last
 * message happens to be.
 */
export default function Chat() {
  const { userId: peerId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { chats } = useChats();

  const selfId = user?.id ?? null;

  // Nobody is offered this — the Message button is absent on your own profile —
  // but a typed URL reaches it, and a screen that looks like a working composer
  // and silently swallows everything typed into it is worse than one that says
  // no. The data layer refuses the same pair, one layer down.
  const selfChat = !!selfId && peerId === selfId;

  // Same id on both devices, computed rather than fetched. Null when the pair
  // is not a pair — a signed-out reader, or the reader's own profile, which the
  // Message button already refuses to offer.
  const chatId = useMemo(() => {
    if (!selfId || !peerId) return null;
    try {
      return chatIdFor(selfId, peerId);
    } catch (err) {
      logger.warn("chat.id", err?.message, { peerId });
      return null;
    }
  }, [selfId, peerId]);

  const peerQuery = useQuery({
    queryKey: qk.users.byId(peerId),
    enabled: !!peerId,
    // Short, and re-read on a timer, because this document now carries
    // something that changes while the screen is open: the other person's
    // heartbeat. A minute of staleness was fine for a name and a photo; it
    // would make "online" mean "was online a minute ago". The interval matches
    // the heartbeat itself, and React Query pauses it for a hidden tab, so a
    // backgrounded chat costs nothing.
    staleTime: PRESENCE_HEARTBEAT_MS,
    refetchInterval: PRESENCE_HEARTBEAT_MS,
    queryFn: () => getUserById(peerId),
  });
  const peer = peerQuery.data ?? null;
  const peerMissing = !peerQuery.isLoading && !peer;

  // ── History ─────────────────────────────────────────────────────────────────
  //
  // Newest-first from the database because that is the only way to ask for the
  // last page of something unbounded, and reversed here because that is the
  // only way anybody reads a conversation.
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!chatId) { setMessages([]); setLoaded(true); return undefined; }
    setLoaded(false);
    return watchMessages(chatId, {
      onRows: (rows) => {
        setMessages([...rows].reverse());
        setLoaded(true);
      },
      onError: (err) => {
        logger.error("chat.messages", err?.message, { code: err?.code, chatId });
        setMessages([]);
        setLoaded(true);
      },
    });
  }, [chatId]);

  // ── Read state ──────────────────────────────────────────────────────────────
  //
  // Opening the thread is what marks it read. Driven off the counter in the
  // chat list — which this screen already has, live — so a message arriving
  // while the reader is sitting here is cleared too, and a chat with nothing
  // unread costs no write at all.
  const chat = useMemo(() => chats.find((c) => c.id === chatId) ?? null, [chats, chatId]);
  const unread = unreadFor(chat, selfId);

  // Opening the thread clears the badge *and* stamps the read watermark, which
  // is what turns the other person's ticks blue. Driven by `needsReadReceipt`
  // rather than the badge alone: a message arriving while the reader is already
  // sitting in the thread never raises the counter, and without the second half
  // of that check its sender would never see it marked read.
  const owesReceipt = needsReadReceipt(chat, selfId);
  useEffect(() => {
    if (!chatId || !selfId || !owesReceipt) return;
    markChatRead({ chatId, userId: selfId }).catch((err) =>
      logger.error("chat.markRead", err?.message, { code: err?.code, chatId })
    );
  }, [chatId, selfId, owesReceipt]);

  // ── Sticking to the bottom ──────────────────────────────────────────────────
  //
  // A chat opens at the newest message and stays there as messages arrive —
  // unless the reader has scrolled up, in which case yanking them back down
  // would be the app taking the screen away from them mid-sentence. "Near the
  // bottom" is the standard compromise, and sending always wins: you are
  // looking at what you just wrote.
  const scrollerRef = useRef(null);
  const bottomRef = useRef(null);
  const stickRef = useRef(true);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 120;
  }

  useEffect(() => {
    if (!stickRef.current) return;
    // `auto` rather than `smooth` for the first paint of a long history: a
    // hundred messages animating past on open is a scroll, not a chat.
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loaded]);

  // ── Composing ───────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  // Why the composer is closed, if it is — the placeholder says which.
  const blockedReason = selfChat ? t.chatSelfError : peerMissing ? t.chatPeerGone : "";
  const canSend = !!chatId && !blockedReason && draft.trim().length > 0 && !sending;

  async function send(e) {
    e?.preventDefault?.();
    if (!canSend) return;

    // The composer keeps its text on a refusal — nothing is cleared until the
    // send is actually going, which is the same rule the failure path below
    // follows.
    const gate = attempt("chat.send");
    if (!gate.allowed) {
      setError(t.rateLimited(retryAfterSeconds(gate.retryAfterMs)));
      return;
    }

    const text = draft.trim();
    setSending(true);
    setError("");
    // Cleared before the write, not after: the message is going, and a composer
    // that holds the text until the server answers is a composer people type
    // into twice. It comes back on failure, with the cursor where it was.
    setDraft("");
    stickRef.current = true;

    try {
      await sendMessage({ senderId: selfId, recipientId: peerId, text });
      track("chat.send", { length: text.length });
    } catch (err) {
      logger.error("chat.send", err?.message, { code: err?.code, chatId });
      release("chat.send");
      setDraft(text);
      setError(t.chatSendFailed);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    // Enter sends where there is a keyboard to press it on; Shift+Enter is the
    // newline. On a phone the on-screen return key inserts one, which is what
    // `enterKeyHint` below asks the OS to draw instead.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const grouped = useMemo(() => groupByDay(messages), [messages]);

  return (
    // Exactly one viewport tall, so the middle row is the only thing that
    // scrolls. `100dvh` inline overrides the `h-screen` class where the browser
    // understands it — on a phone, `100vh` is the height the page would have if
    // the URL bar were not there, which puts the composer just under the bottom
    // edge of the screen.
    <div className="h-screen bg-base flex flex-col" style={{ height: "100dvh" }}>
      {/* ── Who this is ── */}
      <header className="shrink-0 bg-surface border-b border-ink-100">
        <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl flex items-center gap-3 px-3 py-2.5">
          <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          {/* The header is the way back to the profile — the same gesture as
              every other messaging app, and the only place this screen names
              who it is talking to. */}
          <Link to={`/users/${peerId}`} className="flex items-center gap-3 min-w-0 flex-1 active:opacity-70 transition">
            <Avatar src={peer?.photoURL} name={peerName(peer)} size={38} />
            <span className="min-w-0">
              <span className="block font-semibold text-[15px] truncate">{peerName(peer)}</span>
              {/* Presence replaces the handle rather than joining it: two lines
                  is what the header has room for, and "online" is the more
                  useful of the two while you are talking to somebody. The
                  handle is one tap away on the profile this row opens. */}
              <PeerPresence peer={peer} />
            </span>
          </Link>
        </div>
      </header>

      {/* ── History ── */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto no-scrollbar"
      >
        <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl px-4 py-4">
          {!loaded ? (
            <p className="py-12 text-center text-ink-500 text-[14px]">{t.loading}</p>
          ) : messages.length === 0 ? (
            <div className="py-16 text-center">
              <p className="font-medium text-ink-600">
                {selfChat ? t.chatSelfError : t.chatEmptyTitle}
              </p>
              <p className="text-[13px] text-ink-400 mt-1">
                {blockedReason ? "" : t.chatEmptyHint}
              </p>
            </div>
          ) : (
            grouped.map((group) => (
              <section key={group.day}>
                <div className="flex justify-center my-3">
                  <span className="rounded-full bg-ink-100 text-ink-500 text-[11px] font-medium px-3 py-1">
                    {group.label}
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {group.messages.map((m) => {
                    const mine = m.senderId === selfId;
                    return (
                      <li key={m.id} className={"flex " + (mine ? "justify-end" : "justify-start")}>
                        <div
                          className={
                            "max-w-[80%] px-3 py-2 text-[15px] leading-snug break-words whitespace-pre-wrap " +
                            (mine
                              ? "bg-brand-500 text-white rounded-2xl rounded-br-md"
                              : "bg-ink-100 text-ink-900 rounded-2xl rounded-bl-md")
                          }
                        >
                          {m.text}
                          {/* The clock rides inside the bubble, dimmed against
                              its own background, so a column of messages stays
                              a column of messages. */}
                          <span
                            className={
                              "flex items-center justify-end gap-1 text-[10px] mt-1 tabular-nums " +
                              (mine ? "text-white/70" : "text-ink-500")
                            }
                          >
                            {formatClock(m.createdAt) || t.chatSendingMark}
                            {/* Only on your own messages — a tick on theirs
                                would be reporting on yourself. */}
                            {mine ? (
                              <MessageTicks status={messageStatus(m, chat, peerId)} />
                            ) : null}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Composer ── */}
      <form
        onSubmit={send}
        className="shrink-0 bg-surface border-t border-ink-100"
        style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
      >
        <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl px-3 pt-2 flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, LIMITS.MESSAGE_MAX))}
            onKeyDown={onKeyDown}
            rows={1}
            enterKeyHint="enter"
            disabled={!!blockedReason}
            placeholder={blockedReason || t.chatPlaceholder}
            aria-label={t.chatPlaceholder}
            className="input flex-1 resize-none max-h-32 py-2.5 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={t.chatSend}
            className="shrink-0 w-11 h-11 rounded-full bg-brand-500 text-white flex items-center justify-center active:scale-95 transition disabled:opacity-40"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M20 12 4 4l6 8-6 8 16-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {error ? <p className="px-4 pt-1 text-[12px] text-red-500">{error}</p> : null}
      </form>
    </div>
  );
}

/**
 * Messages under one heading per calendar day.
 *
 * A thread read weeks later is a wall of times with no dates; the separator is
 * what makes "14:32" mean something. Grouping happens here rather than in the
 * data layer because it is a fact about the reader's own timezone, not about
 * the messages.
 */
function groupByDay(messages) {
  const groups = [];
  for (const message of messages) {
    // A message whose stamp has not resolved yet belongs to today — it was sent
    // a moment ago, on this device.
    const ms = toMillis(message.createdAt, null) ?? Date.now();
    const day = dayStamp(ms) || dayStamp(Date.now());
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.messages.push(message);
    else groups.push({ day, label: formatDayLabel(ms), messages: [message] });
  }
  return groups;
}
/**
 * "online", or when they were last seen.
 *
 * Re-rendered on a timer as well as on new data, because this is a statement
 * about elapsed time: with no clock of its own, a header opened at 14:00 would
 * still claim somebody was online at 14:30. The peer document itself refreshes
 * on its own query; this only re-reads the same document against a newer `now`.
 *
 * Silent for a profile that has never reported — an account that predates
 * presence should say nothing rather than "last seen 1 January 1970".
 */
function PeerPresence({ peer }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), PRESENCE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const seen = lastSeenAt(peer);
  if (!seen) return null;

  return isOnline(peer, now) ? (
    <span className="flex items-center gap-1.5 text-[12px] text-ok">
      <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />
      {t.presenceOnline}
    </span>
  ) : (
    <span className="block text-[12px] text-ink-500 truncate">
      {t.presenceLastSeen(formatLastSeen(seen, now))}
    </span>
  );
}

/** How often the line above re-reads the clock. */
const PRESENCE_TICK_MS = 30_000;
