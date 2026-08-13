import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import {
  getBook,
  getUserById,
  getReturnRequest,
  openReturnRequest,
  cancelReturnRequest,
  expireReturnRequest,
  updateReturnRequest,
  completeReturnToOwner,
  createNotification,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { checkCommunityExit } from "../../utils/communityExit.js";
import { useLeaveCommunity } from "../../utils/useLeaveCommunity.js";
import { invalidateHolderCaches, invalidateReturnRequest } from "../../lib/bookCaches.js";
import { newPickupCode } from "../../firebase/schema.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import {
  RETURN_STATE, needsSweep, returnStateFor,
} from "../../utils/bookReturn.js";
import { safeImageUrl } from "../../utils/validators.js";
import { t } from "../../utils/i18n.js";
import { writeError } from "../../utils/writeError.js";
import { logger } from "../../utils/logger.js";

/**
 * Step two of collecting a book on the way out of a community: the code.
 *
 * The owner and the holder meet, the holder reads out the four digits they were
 * sent, and the owner types them here. That is the only thing on this screen —
 * and it is deliberately the only thing that moves the book, because the button
 * is a claim about the physical world and the code is the other person's half
 * of it. See utils/bookReturn.js for the states either side of this one.
 *
 * Everything it can find on arrival is already decided elsewhere: the request
 * comes from the data layer, the state from `returnStateFor`. What is left here
 * is the four inputs, and what to do when the answer is right.
 */
export default function ReturnBook() {
  const { id: communityId, bookId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [book, setBook]       = useState(null);
  const [holder, setHolder]   = useState(null);
  const [request, setRequest] = useState(null);
  const [digits, setDigits]   = useState(["", "", "", ""]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [notice, setNotice]   = useState("");
  const [busy, setBusy]       = useState("");   // "submit" | "cancel" | "resend"
  const [done, setDone]       = useState(null); // { closedBorrowing, canLeave }

  // Refs, not state: each of these writes something, and `busy` is only visible
  // to the *next* render — two taps inside one await would both read it as free.
  const submittingRef = useRef(false);
  const resendingRef = useRef(false);

  // The same door the leave screen uses. Offered here only once the exit rules
  // are clear, and never taken automatically — see the success screen below.
  const leaveMutation = useLeaveCommunity(communityId);

  const backToLeave = () => navigate(`/community/${communityId}/leave`, { replace: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const b = await getBook(bookId);
        if (cancelled) return;
        setBook(b);
        if (!b) { setError(t.returnBookGone); return; }
        if (b.ownerId !== user?.id) { setError(t.notAuthorized); return; }

        const req = await getReturnRequest(bookId, user.id);
        const { state } = returnStateFor({ book: b, request: req, userId: user.id });

        // A request that lapsed or lost its holder is cleared on sight rather
        // than shown: its code is with somebody who is no longer part of this
        // handover, and leaving it open would keep the book off the shelf.
        if (req && needsSweep(state)) {
          try {
            await (state === RETURN_STATE.EXPIRED
              ? expireReturnRequest(req.id)
              : cancelReturnRequest(req.id));
            invalidateReturnRequest();
          } catch (err) {
            logger.warn("returnBook.sweep", err?.message, { bookId });
          }
          if (cancelled) return;
          setRequest(null);
          setNotice(state === RETURN_STATE.EXPIRED ? t.returnExpiredNote : t.returnStaleNote);
        } else {
          setRequest(req);
        }

        // The book may have come home some other way while this screen was
        // being opened — the holder can hand it back from their own shelf.
        if (state === RETURN_STATE.HOME) {
          setNotice(t.returnAlreadyHome);
          if (req?.id) {
            await completeReturnToOwner({ bookId, ownerId: user.id, requestId: req.id })
              .catch((err) => logger.warn("returnBook.settleHome", err?.message, { bookId }));
            invalidateReturnRequest();
          }
        }

        const hid = holderIdOf(b);
        if (hid && hid !== user.id) {
          const person = await getUserById(hid).catch(() => null);
          if (!cancelled) setHolder(person);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId, user?.id]);

  /**
   * Send the code from here, for the owner who arrived without one — a request
   * that was just swept, or a screen reached straight from a link. Same call
   * the leave screen makes, so the same idempotence applies: the notification
   * goes out only for a request this call actually created.
   */
  async function handleSendCode() {
    if (busy || !user?.id || !book) return;
    setBusy("resend");
    setError("");
    try {
      const { request: opened, created } = await openReturnRequest({
        bookId,
        requesterId: user.id,
        communityId: communityId || book.communityId,
        requesterName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      });
      if (!opened) { setNotice(t.returnAlreadyHome); return; }
      setRequest(opened);
      invalidateReturnRequest();
      if (created) await notifyHolder(opened.returnCode, t.returnRequestNotifTitle);
    } catch (err) {
      logger.error("returnBook.sendCode", err?.message, { code: err?.code, bookId });
      setError(writeError(err));
    } finally {
      setBusy("");
    }
  }

  /** A fresh four digits, which invalidates the ones already out there. */
  async function handleResend() {
    if (resendingRef.current || !request?.id) return;
    resendingRef.current = true;
    setBusy("resend");
    setError("");
    try {
      const code = newPickupCode();
      await updateReturnRequest(request.id, { returnCode: code });
      setRequest((prev) => ({ ...prev, returnCode: code }));
      await notifyHolder(code, t.returnCodeResentTitle);
      setNotice(t.codeResent);
    } catch (err) {
      logger.error("returnBook.resend", err?.message, { code: err?.code, bookId });
      setError(writeError(err));
    } finally {
      resendingRef.current = false;
      setBusy("");
    }
  }

  async function notifyHolder(code, title) {
    const holderId = request?.holderId || holderIdOf(book);
    if (!holderId || holderId === user.id) return;
    await createNotification({
      recipientId: holderId,
      title,
      body: t.returnRequestNotifBody(
        `${user.firstName} ${user.lastName}`, book.name, code
      ),
      read: false,
      type: "return-request",
      bookId,
      bookName: book.name,
      pickupCode: code,
      returnCode: code,
      requesterId: user.id,
    });
  }

  /** Call the whole thing off. The copy goes back on the shelf. */
  async function handleCancel() {
    if (busy) return;
    setBusy("cancel");
    try {
      if (request?.id) {
        await cancelReturnRequest(request.id);
        const holderId = request.holderId || holderIdOf(book);
        if (holderId && holderId !== user.id) {
          await createNotification({
            recipientId: holderId,
            title: t.returnCancelledNotifTitle,
            body: t.returnCancelledNotifBody(
              `${user.firstName} ${user.lastName}`, book?.name || ""
            ),
            read: false,
            type: "return-cancelled",
            bookId,
            bookName: book?.name || "",
          });
        }
        invalidateHolderCaches(bookId);
      }
    } catch (err) {
      logger.error("returnBook.cancel", err?.message, { code: err?.code, bookId });
    } finally {
      setBusy("");
      backToLeave();
    }
  }

  function handleDigit(index, value) {
    const cleaned = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = cleaned;
    setDigits(next);
    if (cleaned && index < 3) document.getElementById(`rdigit-${index + 1}`)?.focus();
  }
  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      document.getElementById(`rdigit-${index - 1}`)?.focus();
    }
  }

  /**
   * The write that moves the book. The code is compared here, on the client,
   * for the same reason a pickup's is: it is a handshake between two people
   * standing in the same room, not a secret the server can keep (see the note
   * at the top of firestore.rules).
   *
   * Afterwards the exit is re-checked against live data, so the success screen
   * can say what this member has left to do — one more book, or nothing.
   */
  async function onSubmit(e) {
    e.preventDefault();
    if (submittingRef.current || !user?.id || !book) return;
    setError("");

    const entered = digits.join("");
    if (entered.length < 4) { setError(t.pickupCodeMissing); return; }
    if (!request?.returnCode || entered !== request.returnCode) {
      setError(t.pickupCodeWrong);
      return;
    }

    submittingRef.current = true;
    setBusy("submit");
    try {
      const { closedBorrowing } = await completeReturnToOwner({
        bookId,
        ownerId: user.id,
        requestId: request.id,
      });

      const holderId = request.holderId || holderIdOf(book);
      if (holderId && holderId !== user.id) {
        await createNotification({
          recipientId: holderId,
          title: t.returnCompletedNotifTitle,
          body: t.returnCompletedNotifBody(
            `${user.firstName} ${user.lastName}`, book.name
          ),
          read: false,
          type: "return-completed",
          bookId,
          bookName: book.name,
        }).catch((err) => logger.warn("returnBook.notify", err?.message, { bookId }));
      }

      invalidateHolderCaches(bookId);

      // Whether this was the last errand. Read from the server rather than from
      // the list this screen was opened from: collecting a book takes a walk,
      // and a lot can have changed by the time it is confirmed.
      const verdict = await checkCommunityExit({ userId: user.id, communityId })
        .catch(() => ({ canLeave: false }));
      setDone({ closedBorrowing, canLeave: verdict.canLeave });
    } catch (err) {
      logger.error("returnBook.confirm", err?.message, { code: err?.code, bookId });
      setError(writeError(err));
    } finally {
      submittingRef.current = false;
      setBusy("");
    }
  }

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      </MobileShell>
    );
  }

  // ── The book is back ─────────────────────────────────────────────────────
  if (done) {
    return (
      <MobileShell withNav={false}>
        <div className="flex flex-col items-center px-6 pt-20 pb-10 gap-7 text-center">
          <div className="w-28 h-28 rounded-full bg-okSoft flex items-center justify-center">
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-bold">{t.returnDoneTitle}</h1>
            <p className="text-[16px] text-ink-700 leading-relaxed">
              {t.returnDoneBody(book?.name || "")}
            </p>
            {done.closedBorrowing ? (
              <p className="text-[13px] text-ink-500">{t.returnDoneLoanClosed}</p>
            ) : null}
            <p className="text-[14px] font-medium">
              {done.canLeave ? t.returnAllHome : t.waitingReturnsBody}
            </p>
          </div>

          {/* The last book closes the last condition, so the exit is offered
              right here rather than sending them back to look for it — but it
              is still a press. Leaving deletes every book this member owns from
              the community, and that is not something to do on their behalf
              because they typed four digits correctly. */}
          {error ? <p className="text-bad text-[13px]">{error}</p> : null}
          {done.canLeave ? (
            <div className="w-full space-y-2">
              <button
                onClick={() => {
                  setError("");
                  leaveMutation.mutate(undefined, {
                    onError: (err) => setError(writeError(err)),
                  });
                }}
                disabled={leaveMutation.isPending}
                className="btn-primary"
              >
                {leaveMutation.isPending ? "…" : t.leaveNow}
              </button>
              <button onClick={backToLeave} className="btn-secondary">
                {t.backToLeave}
              </button>
            </div>
          ) : (
            <button onClick={backToLeave} className="btn-primary">
              {t.backToLeave}
            </button>
          )}
        </div>
      </MobileShell>
    );
  }

  const holderName = holder
    ? `${holder.firstName || ""} ${holder.lastName || ""}`.trim() || `@${holder.nickname}`
    : t.contactNotSet;
  const codeComplete = digits.every((d) => d);

  return (
    <MobileShell withNav={false}>
      <div className="relative flex items-center justify-center px-4 pt-2 pb-1">
        <button onClick={backToLeave} className="absolute left-4 icon-btn" aria-label={t.back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[19px] font-semibold">{t.returnFlowTitle}</h1>
      </div>

      <div className="px-5 pt-4 pb-6 space-y-5">
        {book ? (
          <div className="flex flex-col items-center gap-2">
            <img
              src={safeImageUrl(book.coverUrl) || undefined}
              alt={book.name || ""}
              onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
              className="w-[112px] h-[160px] rounded-xl object-cover bg-ink-100 shadow-soft"
            />
            <p className="text-[15px] text-ink-700">{book.name}</p>
          </div>
        ) : null}

        {/* Who to collect it from — the same card as step one, because this
            screen is also the one open while walking there. */}
        {holder ? (
          <div className="rounded-2xl bg-ink-100/60 px-4 py-3.5">
            <p className="text-[12px] text-ink-500 mb-2">{t.whoHasBookNow}</p>
            <div className="flex items-center gap-3">
              <Avatar src={holder.photoURL} name={holderName} size={40} />
              <div className="min-w-0">
                <p className="font-medium text-[15px] truncate">{holderName}</p>
                <p className="text-[12px] text-ink-500 truncate">@{holder.nickname}</p>
              </div>
            </div>
            <dl className="mt-3 space-y-2">
              <ContactRow label={t.phone} value={holder.phone || t.contactNotSet} />
              <ContactRow label={t.address} value={holder.address || t.contactNotSet} />
            </dl>
          </div>
        ) : null}

        {notice ? (
          <div className="rounded-2xl bg-warnSoft px-4 py-3">
            <p className="text-[13px] text-ink-900 leading-relaxed">{notice}</p>
          </div>
        ) : null}

        {request ? (
          <>
            <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-3.5">
              <p className="text-[13px] font-semibold text-brand-700 mb-0.5">
                {t.returnCodeTitle}
              </p>
              <p className="text-[12px] text-brand-600 leading-relaxed">
                {t.returnCodeBody} {holder ? `@${holder.nickname}` : ""}
              </p>
            </div>

            <form onSubmit={onSubmit} className="space-y-5">
              <div>
                <div className="flex gap-3 justify-center">
                  {digits.map((d, i) => (
                    <input
                      key={i}
                      id={`rdigit-${i}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={d}
                      onChange={(e) => handleDigit(i, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(i, e)}
                      aria-label={`${t.codeFrom} ${i + 1}`}
                      className="w-14 h-16 text-center text-2xl font-bold rounded-2xl bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-surface transition"
                    />
                  ))}
                </div>
                <div className="mt-4 flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={!!busy}
                    className="text-[13px] text-brand-500 font-medium hover:underline underline-offset-2 disabled:opacity-50 transition"
                  >
                    {busy === "resend" ? "…" : t.resendCode}
                  </button>
                </div>
              </div>

              <InfoNote text={t.returnHandoverNote} />
              {error ? <p className="text-bad text-[13px]">{error}</p> : null}

              <div className="space-y-2">
                {/* Stays soft until all four digits are in — the design's cue
                    that this button is waiting on the holder, not the owner. */}
                <button
                  disabled={busy === "submit" || !codeComplete}
                  className={
                    "w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] " +
                    (codeComplete
                      ? "bg-brand-500 hover:bg-brand-600 text-white"
                      : "bg-brand-50 text-brand-500")
                  }
                >
                  {busy === "submit" ? "…" : t.enterCode}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={!!busy}
                  className="btn-secondary disabled:opacity-60"
                >
                  {busy === "cancel" ? "…" : t.returnCancelRequest}
                </button>
              </div>
            </form>
          </>
        ) : (
          // No live request — swept on arrival, or never opened. One button,
          // and it is the same one step one offers.
          <div className="space-y-3">
            <InfoNote text={t.returnSendCodeNote} />
            {error ? <p className="text-bad text-[13px]">{error}</p> : null}
            <button
              onClick={handleSendCode}
              disabled={!!busy || !book || book.ownerId !== user?.id}
              className="btn-primary"
            >
              {busy === "resend" ? "…" : t.sendCode}
            </button>
            <button type="button" onClick={backToLeave} className="btn-secondary">
              {t.backToLeave}
            </button>
          </div>
        )}

        <InfoNote text={t.returnExpiryNote} />
      </div>
    </MobileShell>
  );
}

function ContactRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-[14px] text-ink-500 shrink-0">{label}</dt>
      <dd className="text-[14px] font-medium text-right break-words">{value}</dd>
    </div>
  );
}

function InfoNote({ text }) {
  return (
    <div className="flex items-start gap-2.5">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5 text-ink-500">
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <path d="M12 10.5v6" stroke="var(--bg-surface)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="7.5" r="1.2" fill="var(--bg-surface)" />
      </svg>
      <p className="text-[13px] text-ink-500 leading-snug">{text}</p>
    </div>
  );
}
