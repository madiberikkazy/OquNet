import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import {
  getNotificationById,
  updateNotification,
  updateUser,
  getCommunity,
  cancelJoinRequest,
  toMillis,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";

export default function NotificationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { setCommunity } = useCommunity();

  const [notification, setNotification] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getNotificationById(id)
      .then((n) => {
        setNotification(n);
        // Mark as read when opened
        if (n && !n.read) {
          updateNotification(id, { read: true });
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleJoinAccept() {
    setBusy(true);
    setError("");
    try {
      // `joinRequestId` is not decoration: joining is a write to your own user
      // document, and the only thing that distinguishes an accepted invitation
      // from helping yourself to a community is the approved request behind it.
      // The rules re-read that request server-side, so the id has to be part of
      // the write rather than merely checked here.
      await updateUser(user.id, {
        communityId: notification.communityId,
        joinRequestId: notification.requestId,
      });
      await updateNotification(id, { confirmed: "accepted", read: true });
      setNotification((prev) => ({ ...prev, confirmed: "accepted", read: true }));
      await refresh();
      const c = await getCommunity(notification.communityId);
      setCommunity(c);
    } catch (err) {
      setError(err?.message || "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelRequest() {
    setBusy(true);
    setError("");
    try {
      if (notification.requestId) {
        await cancelJoinRequest(notification.requestId);
      }
      await updateNotification(id, { requestStatus: "cancelled", read: true });
      setNotification((prev) => ({ ...prev, requestStatus: "cancelled", read: true }));
    } catch (err) {
      setError(err?.message || "Қате");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinDecline() {
    setBusy(true);
    setError("");
    try {
      await updateNotification(id, { confirmed: "declined", read: true });
      setNotification((prev) => ({ ...prev, confirmed: "declined", read: true }));
    } catch (err) {
      setError(err?.message || "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500">Загрузка...</p>
      </MobileShell>
    );
  }

  if (!notification) {
    return (
      <MobileShell withNav={false}>
        <div className="flex items-center gap-3 px-4 pt-2">
          <button onClick={() => navigate(-1)} className="icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="px-6 py-12 text-center text-ink-500">Уведомление не найдено.</p>
      </MobileShell>
    );
  }

  const date = notification.createdAt
    ? new Date(toMillis(notification.createdAt)).toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "";

  const isJoinApproved  = notification.type === "join-approved";
  const isJoinRequestSent = notification.type === "join-request-sent";
  const isPending  = notification.confirmed === "pending";
  const isAccepted = notification.confirmed === "accepted";
  const isDeclined = notification.confirmed === "declined";

  const requestCancelled = notification.requestStatus === "cancelled";

  // Show the code widget for ANY notification that carries a pickupCode field.
  const hasCode = Boolean(notification.pickupCode);

  return (
    <MobileShell withNav={false}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-2">
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold flex-1 truncate">Уведомление</h1>
      </div>

      <div className="px-5 pt-5 space-y-4">
        {/* Title + date */}
        <div>
          <h2 className="text-xl font-bold leading-snug">{notification.title}</h2>
          {date ? <p className="text-[12px] text-ink-500 mt-1">{date}</p> : null}
        </div>

        {/* Full body text */}
        <p className="text-[15px] text-ink-700 leading-relaxed whitespace-pre-wrap">
          {notification.body}
        </p>

        {/* ── Code widget — shown for any notification that carries a pickupCode ── */}
        {hasCode ? (
          <div className="card p-5 flex flex-col items-center gap-3">
            <p className="text-[13px] text-ink-500 font-medium">Код передачи книги</p>
            <div className="flex gap-3">
              {String(notification.pickupCode).split("").map((digit, i) => (
                <div
                  key={i}
                  className="w-14 h-16 flex items-center justify-center rounded-2xl bg-brand-50 text-brand-500 text-2xl font-bold"
                >
                  {digit}
                </div>
              ))}
            </div>
            <p className="text-[12px] text-ink-500 text-center">
              Назовите этот код новому читателю, когда физически передадите книгу.
            </p>
          </div>
        ) : null}

        {/* ── Join-request-sent: cancel button ── */}
        {isJoinRequestSent ? (
          <div className="space-y-3">
            {/* Community card */}
            {notification.communityName ? (
              <div className="card px-4 py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                    <circle cx="9" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M3 21c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M16 3.1a3 3 0 0 1 0 5.8M21 21c0-2.7-1.7-5-4-5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-[15px]">{notification.communityName}</p>
                  <p className="text-[12px] text-ink-500">Қоғамдастық</p>
                </div>
              </div>
            ) : null}

            {requestCancelled ? (
              <div className="rounded-2xl bg-ink-100 px-4 py-3 text-[14px] text-ink-500 text-center">
                Өтінішіңіз болдырылмады.
              </div>
            ) : (
              <button
                onClick={handleCancelRequest}
                disabled={busy}
                className="w-full py-3 rounded-2xl bg-bad/10 text-bad font-semibold text-[14px] active:scale-[0.99] transition disabled:opacity-60"
              >
                {busy ? "…" : "Өтінішті болдырмау"}
              </button>
            )}
          </div>
        ) : null}

        {/* ── Join-approved: book info + Yes/No buttons ── */}
        {isJoinApproved ? (
          <>
            {notification.bookName ? (
              <div className="card p-4">
                <p className="text-[13px] text-ink-500 mb-1">Книга для добавления в сообщество</p>
                <p className="font-semibold">«{notification.bookName}»</p>
                {notification.bookAuthor ? (
                  <p className="text-[13px] text-ink-500">{notification.bookAuthor}</p>
                ) : null}
              </div>
            ) : null}

            {isPending ? (
              <div className="space-y-2 pt-1">
                <button
                  disabled={busy}
                  onClick={handleJoinAccept}
                  className="btn-primary"
                >
                  {busy ? "..." : "Да, вступить в сообщество"}
                </button>
                <button
                  disabled={busy}
                  onClick={handleJoinDecline}
                  className="btn-secondary"
                >
                  {busy ? "..." : "Нет, отказаться"}
                </button>
              </div>
            ) : isAccepted ? (
              <div className="rounded-2xl bg-okSoft px-4 py-3 text-[14px] text-ok font-medium">
                ✓ Вы вступили в сообщество «{notification.communityName}»
              </div>
            ) : isDeclined ? (
              <div className="rounded-2xl bg-ink-100 px-4 py-3 text-[14px] text-ink-500">
                Вы отказались от вступления в сообщество.
              </div>
            ) : null}
          </>
        ) : null}

        {error ? <p className="text-bad text-[13px]">{error}</p> : null}
      </div>
    </MobileShell>
  );
}