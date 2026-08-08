import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import {
  getNotificationById,
  updateNotification,
  updateUser,
  getCommunity,
  cancelJoinRequest,
  createNotification,
  getRequestById,
  updateJoinRequest,
  updateLeaveRequest,
  toMillis,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { checkCommunityExit, exitBlockMessage } from "../../utils/communityExit.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";

// The two notifications that ask their reader for a decision rather than
// telling them something. Both name the request they are about.
const DECIDABLE = new Set(["join-request", "leave-request"]);

export default function NotificationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { community, setCommunity } = useCommunity();

  const [notification, setNotification] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The join/leave request this notification is about, when it is about one.
  // Read from the database rather than from the notification: a request can be
  // cancelled or already decided between the message arriving and being opened,
  // and its own `status` is the only honest answer to that.
  const [request, setRequest] = useState(null);
  const [blocked, setBlocked] = useState("");   // approval refused: books still out

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
        if (n && DECIDABLE.has(n.type) && n.requestId) {
          // Only the subject and the community's admin may read it, so a
          // refusal here is ordinary — it just means no decision to offer.
          getRequestById(n.requestId)
            .then(setRequest)
            .catch((err) => logger.error("notificationDetail.request", err?.message, {
              requestId: n.requestId, code: err?.code,
            }));
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  // ── Deciding a join request ─────────────────────────────────────────────────
  //
  // Approval does not add the member: it sends them an offer they still have to
  // accept, because joining is a write to their own profile and only they can
  // make it. The request id travels with the offer — the rules re-read it to
  // tell an accepted invitation from someone helping themselves to a community.
  async function decideJoin(approved) {
    setBusy(true);
    setError("");
    try {
      await updateJoinRequest(request.id, { status: approved ? "approved" : "rejected" });
      await createNotification(approved ? {
        recipientId: request.userId,
        title: t.joinApprovedTitle,
        body: t.joinApprovedBody(community?.name || notification.communityName || ""),
        read: false,
        type: "join-approved",
        requestId: request.id,
        communityId: request.communityId,
        communityName: community?.name || "",
        bookName: request.bookName || "",
        bookAuthor: request.bookAuthor || "",
        bookDescription: request.bookDescription || "",
        bookCoverUrl: request.bookCoverUrl || "",
        confirmed: "pending",
      } : {
        recipientId: request.userId,
        title: t.joinRejectedTitle,
        body: t.joinRejectedBody(community?.name || notification.communityName || ""),
        read: false,
        type: "join-rejected",
      });
      setRequest((prev) => ({ ...prev, status: approved ? "approved" : "rejected" }));
    } catch (err) {
      logger.error("notificationDetail.decideJoin", err?.message, { code: err?.code });
      setError(err?.message || t.error);
    } finally {
      setBusy(false);
    }
  }

  // ── Deciding a leave request ────────────────────────────────────────────────
  async function decideLeave(approved) {
    setBusy(true);
    setError("");
    setBlocked("");
    try {
      if (approved) {
        // The final gate, and the one that matters most: a request can sit here
        // for days, and in the meantime the member may have picked up a book.
        // Approval is what actually drops their membership, so the rules are
        // re-checked against live data right before that write.
        const verdict = await checkCommunityExit({
          userId: request.userId,
          communityId: request.communityId || community?.id,
        });
        if (!verdict.canLeave) {
          const message = exitBlockMessage(verdict.blockedBy);
          setBlocked(message);
          await createNotification({
            recipientId: request.userId,
            title: t.leaveTitle,
            body: message,
            read: false,
            type: "leave-blocked",
            communityId: request.communityId || community?.id,
          });
          return;
        }
        await updateLeaveRequest(request.id, { status: "approved" });
        await updateUser(request.userId, { communityId: null });
      } else {
        await updateLeaveRequest(request.id, { status: "rejected" });
      }

      await createNotification({
        recipientId: request.userId,
        title: approved ? t.leaveApprovedTitle : t.leaveRejectedTitle,
        body: approved
          ? t.leaveApprovedBody(community?.name || "")
          : t.leaveRejectedBody(community?.name || ""),
        read: false,
        type: approved ? "leave-approved" : "leave-rejected",
      });
      setRequest((prev) => ({ ...prev, status: approved ? "approved" : "rejected" }));
    } catch (err) {
      logger.error("notificationDetail.decideLeave", err?.message, { code: err?.code });
      setError(err?.message || t.error);
    } finally {
      setBusy(false);
    }
  }

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

  // A decision to make: a request this reader is entitled to act on, still
  // waiting. Anyone else either never receives this notification or cannot read
  // the request behind it, so there is nothing to hide from them here.
  const isLeaveRequest = notification.type === "leave-request";
  const decidable = DECIDABLE.has(notification.type) && !!request;

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

        {/* ── Join / leave request: the admin's decision ── */}
        {decidable ? (
          <div className="space-y-3">
            <div className="card px-4 py-3">
              <p className="text-[13px] text-ink-500">
                {isLeaveRequest ? t.leaveRequestSection : t.joinRequestSection}
              </p>
              <p className="font-semibold text-[15px] mt-0.5">
                {request.userName || `@${request.userNickname || ""}`}
              </p>
              {/* The book they are bringing in — the price of admission, and
                  the thing the admin is actually agreeing to. */}
              {request.bookName ? (
                <p className="text-[13px] text-ink-500 mt-1">
                  «{request.bookName}»{request.bookAuthor ? ` — ${request.bookAuthor}` : ""}
                </p>
              ) : null}
            </div>

            {blocked ? (
              <div className="rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2 leading-relaxed">
                {blocked}
              </div>
            ) : null}

            {request.status === "pending" ? (
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => (isLeaveRequest ? decideLeave(true) : decideJoin(true))}
                  className="flex-1 py-3 rounded-2xl bg-brand-500 text-white text-[14px] font-semibold active:scale-[0.98] transition disabled:opacity-60"
                >
                  {busy ? "…" : t.requestApprove}
                </button>
                <button
                  disabled={busy}
                  onClick={() => (isLeaveRequest ? decideLeave(false) : decideJoin(false))}
                  className="flex-1 py-3 rounded-2xl bg-badSoft text-bad text-[14px] font-semibold active:scale-[0.98] transition disabled:opacity-60"
                >
                  {busy ? "…" : t.requestReject}
                </button>
              </div>
            ) : (
              <div className="rounded-2xl bg-ink-100 px-4 py-3 text-[14px] text-ink-500 text-center">
                {request.status === "approved" ? t.requestApproved
                 : request.status === "rejected" ? t.requestRejected
                 : t.requestCancelledByUser}
              </div>
            )}
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