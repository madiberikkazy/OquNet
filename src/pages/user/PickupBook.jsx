import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import {
  getBook,
  getUserById,
  getActiveBorrowingByBook,
  getActiveBorrowingForUser,
  hasUserCompletedBook,
  getPendingPickupForUser,
  getPendingReturnForBook,
  getPickupRequest,
  openPickupRequest,
  PickupBlockedError,
  cancelPickupRequest,
  holdBookForPickup,
  releasePickupHold,
  fulfillPickupRequest,
  transferBookHolder,
  updateBorrowing,
  updatePickupRequest,
  createNotification,
  toMillis,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { invalidateHolderCaches, invalidatePickupRequest } from "../../lib/bookCaches.js";
import { newPickupCode } from "../../firebase/schema.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import { loanDaysForPages, pagesForBook, pagesRangeLabel } from "../../utils/bookPages.js";
import { safeImageUrl } from "../../utils/validators.js";
import { t, getCurrentLang } from "../../utils/i18n.js";
import { canSeePhone } from "../../utils/contactVisibility.js";
import MessageButton from "../../components/MessageButton.jsx";
import { logger } from "../../utils/logger.js";
import { attempt, retryAfterSeconds } from "../../utils/rateLimit.js";

// A pickup that nobody acts on stops blocking the book after three days —
// the same window the screen promises in its footer note.
const PICKUP_EXPIRY_DAYS = 3;

const DATE_LOCALES = { ru: "ru-RU", en: "en-GB" };
// Chromium's kk-KZ data has no long month names — it renders "2026 M08 3" — so
// Kazakh dates are spelled out here rather than handed to Intl.
const KZ_MONTHS = [
  "қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым",
  "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан",
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function formatLongDate(ts) {
  const d = new Date(ts);
  const locale = DATE_LOCALES[getCurrentLang()];
  if (!locale) return `${d.getDate()} ${KZ_MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
  try {
    return d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return d.toLocaleDateString();
  }
}
/** Why a reader cannot start this pickup, in words. */
export function blockMessage(reason) {
  if (reason === "other-pickup") return t.pickupOtherPending;
  // Somebody else got to it first and is on their way to collect it.
  if (reason === "held") return t.bookBeingCollected;
  // Not this reader's fault and not their errand: the copy is on its way back
  // to the person who owns it, who is on their way out of the community.
  if (reason === "returning") return t.bookBeingReturned;
  return t.pickupReturnOtherBook;
}

function isExpired(request) {
  const created = toMillis(request?.createdAt, null);
  // A request whose createdAt hasn't resolved yet (serverTimestamp) is brand new.
  if (created == null) return false;
  return Date.now() - created > PICKUP_EXPIRY_DAYS * 86400000;
}

export default function PickupBook() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [book, setBook]                   = useState(null);
  const [currentHolder, setCurrentHolder] = useState(null);
  const [existingBorrowing, setExistingBorrowing] = useState(null);
  const [pickupRequest, setPickupRequest] = useState(null);
  // Step 1 picks the terms and sends the code; step 2 enters it.
  const [step, setStep]                   = useState(1);
  const [digits, setDigits]               = useState(["", "", "", ""]);
  const [error, setError]                 = useState("");
  const [sending, setSending]             = useState(false);
  const [submitting, setSubmitting]       = useState(false);
  const [cancelling, setCancelling]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [resending, setResending]         = useState(false);
  const [resent, setResent]               = useState(false);
  const [success, setSuccess]             = useState(false);
  // A pickup this reader has open on some *other* book, which is what stops
  // them starting a second one. Null when they are free to collect this book.
  const [blockedBy, setBlockedBy]         = useState(null);

  // Guards `handleSendCode` against a second press landing while the first is
  // still in flight. A ref and not the `sending` state: state is only visible to
  // the *next* render, so two taps inside one await both read `sending === false`
  // and both send a code. The data layer refuses the duplicate either way; this
  // is what stops the second notification from being written at all.
  const sendingRef = useRef(false);
  // Whether the holder has already been told, for this visit. The request is
  // opened on load now, so "was it created just now" no longer answers it.
  const codeSentRef = useRef(false);
  const resendingRef = useRef(false);
  const submittingRef = useRef(false);

  // How long this book may be kept. Not a choice any more: the admin picked the
  // book's page band and the loan follows from it, one day per fifty pages. The
  // reader is told the period rather than asked for one — a short book is a
  // short loan, and that is a property of the book, not of the borrower.
  const loanDays = loanDaysForPages(pagesForBook(book));

  useEffect(() => {
    (async () => {
      setLoading(true);
      const b = await getBook(id);
      setBook(b);

      let borrowing = null;
      if (b?.status === "unavailable") {
        borrowing = await getActiveBorrowingByBook(id);
        setExistingBorrowing(borrowing);
      }
      // Whoever has the book is who hands it over and names the code — that is
      // a previous reader when the book is free but still on their shelf.
      const holderId = holderIdOf(b);
      if (holderId) setCurrentHolder(await getUserById(holderId));

      // Is the owner already on their way to collect this copy? Asked before
      // anything is offered, because a reader who walks across town for a book
      // that is going home to its owner has been failed by this screen, not by
      // the write that eventually refuses them.
      const returning = await getPendingReturnForBook({
        bookId: id, communityId: b?.communityId,
      }).catch(() => null);

      let req = null;
      let blocker = returning ? { reason: "returning", bookId: null } : null;
      if (user?.id && !returning) {
        req = await getPickupRequest(id, user.id);
        // Reopening a stale request would hand out a code nobody remembers —
        // and, now that a request holds the book off the shelf, would keep a
        // book out of circulation for a reader who walked away three days ago.
        // The hold goes back with it.
        if (req && isExpired(req)) {
          try { await cancelPickupRequest(req.id); } catch (err) {
            logger.warn("pickup.expireRequest", err?.message, { bookId: id });
          }
          await releasePickupHold({ bookId: id, userId: user.id }).catch((err) => {
            logger.warn("pickup.expireHold", err?.message, { bookId: id });
          });
          req = null;
          setError(t.pickupRequestExpired);
        }
        // Only worth asking when this book has no request of its own: a reader
        // already partway through collecting *this* book is not blocked by it.
        if (!req) {
          const [elsewhere, loan] = await Promise.all([
            getPendingPickupForUser(user.id).catch(() => null),
            getActiveBorrowingForUser(user.id).catch(() => null),
          ]);
          if (elsewhere) blocker = { reason: "other-pickup", bookId: elsewhere.bookId };
          else if (loan && loan.bookId !== id) blocker = { reason: "other-loan", bookId: loan.bookId };
        }
      }
      // ── Arriving here is the start of the errand, so the book comes off
      //    the shelf now rather than when the code is sent.
      //
      // A pickup takes days. Leaving the copy available for all of them is how
      // two readers each got halfway through collecting the same book, and the
      // second one to arrive found an empty shelf and no explanation. The
      // request is what records the hold — whose it is, and when it started, so
      // that the three days above can be counted — which is why it is opened
      // here rather than by the button below. The button now does what it says
      // on it: sends the code.
      //
      // Nothing is held for a reader who is blocked, and nothing is held twice:
      // `openPickupRequest` returns the existing request untouched, and the
      // rules refuse a second hold on a book somebody else is collecting.
      if (user?.id && !req && !blocker) {
        try {
          const opened = await openPickupRequest({
            bookId: id,
            requesterId: user.id,
            requesterName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
            communityId: b?.communityId,
            bookName: b?.name,
          });
          req = opened.request;
          await holdBookForPickup({ bookId: id, userId: user.id }).catch((err) => {
            // The request stands and the pickup can go ahead; the copy simply
            // stays visible on the shelf. Worth a log, not worth stopping for.
            logger.warn("pickup.hold", err?.message, { bookId: id, code: err?.code });
          });
          setBook(await getBook(id));
          invalidatePickupRequest();
          invalidateHolderCaches(id);
        } catch (err) {
          if (err instanceof PickupBlockedError) {
            blocker = { reason: err.reason, bookId: err.bookId };
          } else {
            logger.error("pickup.open", err?.message, { bookId: id, code: err?.code });
          }
        }
      }

      setPickupRequest(req);
      setBlockedBy(blocker);
      setStep(req ? 2 : 1);

      setLoading(false);
    })();
  }, [id, user?.id]);

  function backToBook() {
    navigate(`/books/${id}`, { replace: true });
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      if (pickupRequest?.id) {
        await cancelPickupRequest(pickupRequest.id);
        // …and the book goes back on the shelf in the same breath. A cancelled
        // errand that left the copy held would be worse than never starting.
        await releasePickupHold({ bookId: id, userId: user?.id }).catch((err) => {
          logger.warn("pickup.cancelHold", err?.message, { bookId: id });
        });
        // Frees this reader to ask for a different book, and puts the book page
        // back to offering a fresh request rather than "continue".
        invalidatePickupRequest();
        invalidateHolderCaches(id);
      }
    } catch (err) {
      logger.error("pickup.cancel", err?.message, { bookId: id });
    } finally {
      setCancelling(false);
      backToBook();
    }
  }

  /**
   * Step 1 → 2. Tells whoever holds the book which code to read out.
   *
   * The request itself was opened when this screen loaded — that is what holds
   * the copy off the shelf while the two readers arrange to meet — so this
   * button no longer creates anything. It announces. The book still does not
   * move until the code comes back on step 2.
   *
   * `openPickupRequest` is called anyway, and returns the request that is
   * already open. It is not a fallback bolted on: the load may have been
   * refused for a reason that has since cleared, and this is the one place that
   * can tell the reader why rather than leaving a button that does nothing.
   * Whether a request was *created* here decides whether anybody is notified,
   * so pressing this twice sends one code, not two.
   */
  async function handleSendCode() {
    if (sendingRef.current || !user?.id || !book) return;

    // Opening a pickup writes a request, holds the book, and notifies the
    // holder. Repeating it does not make the other person answer sooner, and
    // each repeat is all three of those again.
    const gate = attempt("pickup.request");
    if (!gate.allowed) {
      setError(t.rateLimited(retryAfterSeconds(gate.retryAfterMs)));
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setError("");

    try {
      const base = {
        bookId: id,
        bookName: book.name,
        requesterId: user.id,
        requesterName: `${user.firstName} ${user.lastName}`.trim(),
        loanDays,
      };

      // The code differs by where the book is, so it has to be settled before
      // the request is written: a book out on loan reuses the reader's own
      // handoff code (every loan is born with one — see borrowingSchema), a
      // free book on somebody's shelf gets a fresh one stored on the request.
      const { request, created } = existingBorrowing
        ? await openPickupRequest(base)
        : await openPickupRequest({ ...base, pickupCode: newPickupCode() });

      setPickupRequest(request);
      setStep(2);

      if (created) {
        // Only reachable when the load could not open the request — the hold
        // belongs with it either way.
        await holdBookForPickup({ bookId: id, userId: user.id }).catch((err) => {
          logger.warn("pickup.hold", err?.message, { bookId: id, code: err?.code });
        });
      } else if (codeSentRef.current) {
        // This screen already sent it. Saying so beats silently doing nothing
        // after a button press.
        setError(t.pickupCodeAlreadySent);
        return;
      }
      codeSentRef.current = true;

      // The book page asks whether this reader has a request open — for this
      // book, and for any book. Both answers just changed.
      invalidatePickupRequest();

      if (existingBorrowing) {
        if (existingBorrowing.borrowerId && existingBorrowing.borrowerId !== user.id) {
          await createNotification({
            recipientId: existingBorrowing.borrowerId,
            title: "Хотят забрать вашу книгу",
            body: `${base.requesterName} хочет получить книгу «${book.name}», которую вы держите. Если он заберёт книгу — назовите ему код для смены читателя.`,
            read: false,
            type: "pickup-request",
            bookId: id,
            pickupCode: existingBorrowing.pickupCode,
          });
        }
      } else {
        const holderId = currentHolder?.id || book.ownerId;
        if (holderId && holderId !== user.id) {
          await createNotification({
            recipientId: holderId,
            title: "Запрос на книгу",
            body: `${base.requesterName} хочет взять книгу «${book.name}», которая сейчас у вас. Назовите ему код для передачи:`,
            read: false,
            type: "borrow-request",
            bookId: id,
            pickupCode: request.pickupCode,
          });
        }
      }
    } catch (err) {
      if (err instanceof PickupBlockedError) {
        setBlockedBy({ reason: err.reason, bookId: err.bookId });
        setError(blockMessage(err.reason));
      } else {
        logger.error("pickup.sendCode", err?.message, { code: err?.code, bookId: id });
        setError(err?.message || t.error);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function handleResend() {
    // Same reason as `sendingRef`: this rotates the code and notifies, so a
    // double-tap is two codes, and the second invalidates the first. The
    // window below is the same guard held across a remount of this screen,
    // which `resendingRef` cannot see.
    if (resendingRef.current || !user?.id || !book) return;
    const gate = attempt("pickup.request");
    if (!gate.allowed) {
      setError(t.rateLimited(retryAfterSeconds(gate.retryAfterMs)));
      return;
    }
    resendingRef.current = true;
    setResending(true);
    setResent(false);
    try {
      const newCode = newPickupCode();

      if (existingBorrowing) {
        // Refresh the code on the active borrowing so the holder sees a new one
        await updateBorrowing(existingBorrowing.id, { pickupCode: newCode });
        setExistingBorrowing((prev) => ({ ...prev, pickupCode: newCode }));
        await createNotification({
          recipientId: existingBorrowing.borrowerId,
          title: "Жаңа код: кітап беру",
          body: `${user.firstName} ${user.lastName} «${book.name}» кітабын алғысы келеді. Жаңа 4 таңбалы код:`,
          read: false,
          type: "pickup-request",
          bookId: id,
          pickupCode: newCode,
        });
      } else if (pickupRequest) {
        // Refresh the code on the pickup request so the holder sees a new one
        await updatePickupRequest(pickupRequest.id, { pickupCode: newCode });
        setPickupRequest((prev) => ({ ...prev, pickupCode: newCode }));
        await createNotification({
          recipientId: currentHolder?.id || book.ownerId,
          title: "Жаңа код: кітап беру",
          body: `${user.firstName} ${user.lastName} «${book.name}» кітабын алғысы келеді. Жаңа 4 таңбалы код:`,
          read: false,
          type: "borrow-request",
          bookId: id,
          pickupCode: newCode,
        });
      }
      setResent(true);
    } catch (err) {
      logger.error("pickup.resend", err?.message, { code: err?.code, bookId: id });
    } finally {
      resendingRef.current = false;
      setResending(false);
    }
  }

  function handleDigit(index, value) {
    const cleaned = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = cleaned;
    setDigits(next);
    if (cleaned && index < 3) document.getElementById(`digit-${index + 1}`)?.focus();
  }
  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      document.getElementById(`digit-${index - 1}`)?.focus();
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    // Ref, not state: this is the write that moves the book, and `submitting`
    // is only false-then-true across a render.
    if (submittingRef.current || !user?.id || !book) return;
    setError("");
    const enteredCode = digits.join("");
    if (enteredCode.length < 4) { setError(t.pickupCodeMissing); return; }

    // The code lives on the active loan when the book is out, and on the
    // request itself when it is merely sitting on someone's shelf.
    const expectedCode = existingBorrowing
      ? existingBorrowing.pickupCode
      : pickupRequest?.pickupCode;
    if (!expectedCode || enteredCode !== expectedCode) {
      setError(t.pickupCodeWrong);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const active = await getActiveBorrowingForUser(user.id);
      if (active && active.bookId !== id) { setError(t.pickupReturnOtherBook); return; }

      // One read each. The book page stops offering the button to somebody who
      // has already finished this book, but a typed URL reaches this screen
      // without passing that, and the rules cannot express "has read this
      // before" — it is a question about a collection, not about this document.
      // So it is asked here, at the write, where it decides something.
      //
      // The owner is exempt: their own copy is theirs to pick up again.
      if (book.ownerId !== user.id && await hasUserCompletedBook(id, user.id).catch(() => false)) {
        setError(t.alreadyReadBook);
        return;
      }

      // Re-asked at the moment of the write, not only on arrival: a request
      // opened days ago is a code this reader still has, and the owner may have
      // started collecting the book in between.
      const returning = await getPendingReturnForBook({
        bookId: id, communityId: book.communityId,
      }).catch(() => null);
      if (returning) {
        setBlockedBy({ reason: "returning", bookId: null });
        setError(t.bookBeingReturned);
        return;
      }

      // The book's own allowance, read at submit rather than taken from the
      // request: a request written before the admin re-banded the book would
      // otherwise hand out the old period. `loanDays` is derived, so there is
      // nothing here for a stale form value to override.
      const actualReturnTs = addDays(Date.now(), loanDays).getTime();

      // Taking the book off a live reader closes their loan; collecting a free
      // book has none to close. Either way the holder moves to us and the owner
      // is untouched — `transferBookHolder` reads it off the stored book.
      const { ownerId } = await transferBookHolder({
        bookId: id,
        toUserId: user.id,
        previousBorrowingId: existingBorrowing?.id || null,
        // No `pickupCode` here: borrowingSchema mints one on every loan, so the
        // code the *next* reader will be given exists from the moment this one
        // starts — it is simply not shown until somebody asks for the book.
        borrowing: {
          bookName: book.name,
          communityId: book.communityId,
          startDate: Date.now(),
          returnDate: actualReturnTs,
        },
      });

      // The owner gets a heads-up, never the code.
      if (ownerId && ownerId !== user.id) {
        await createNotification({
          recipientId: ownerId,
          title: existingBorrowing ? "Кітап жаңа оқырманда" : "Кітап берілді",
          body: existingBorrowing
            ? `«${book.name}» кітабы енді ${user.firstName} ${user.lastName} (@${user.nickname}) қолында.`
            : `${user.firstName} ${user.lastName} сіздің «${book.name}» кітабыңызды алды.`,
          read: false,
          type: "book-transferred",
          bookId: id,
        });
      }
      if (pickupRequest?.id) await fulfillPickupRequest(pickupRequest.id);
      invalidateHolderCaches(id);
      setSuccess(true);
    } catch (err) {
      logger.error("pickup.confirm", err?.message, { code: err?.code, bookId: id });
      setError(err?.message || t.error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading || !book) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      </MobileShell>
    );
  }

  // ── Success screen ───────────────────────────────────────────────────────
  if (success) {
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
            <h1 className="text-3xl font-bold">Керемет!</h1>
            <p className="text-[16px] text-ink-700 leading-relaxed">
              Кітап{" "}
              <span className="font-semibold">«{book.name}»</span>{" "}
              енді{" "}
              <span className="font-semibold">«Қазір оқып жатқан кітап»</span>{" "}
              бөліміне қосылды.
            </p>
          </div>

          <button onClick={backToBook} className="btn-primary">
            Кітапқа өту →
          </button>
        </div>
      </MobileShell>
    );
  }

  const holderName = currentHolder
    ? `${currentHolder.firstName || ""} ${currentHolder.lastName || ""}`.trim() ||
      `@${currentHolder.nickname}`
    : t.contactNotSet;
  const holderLabel = currentHolder ? `@${currentHolder.nickname}` : t.holderLabel;
  const pickupTs = Date.now();
  const returnTs = addDays(pickupTs, loanDays).getTime();
  const codeComplete = digits.every((d) => d);

  return (
    <MobileShell withNav={false}>
      {/* Header — centred title with the back arrow floating left */}
      <div className="relative flex items-center justify-center px-4 pt-2 pb-1">
        <button
          onClick={backToBook}
          className="absolute left-4 icon-btn"
          aria-label={t.back}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[19px] font-semibold">{t.pickupTitle}</h1>
      </div>

      <div className="px-5 pt-4 pb-6 space-y-5">
        {/* Book — cover above its title, both centred */}
        <div className="flex flex-col items-center gap-2">
          <img
            src={safeImageUrl(book.coverUrl) || undefined}
            alt={book.name || ""}
            onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
            className="w-[112px] h-[160px] rounded-xl object-cover bg-ink-100 shadow-soft"
          />
          <p className="text-[15px] text-ink-700">{book.name}</p>
        </div>

        {step === 1 ? (
          <>
            {/* Loan length — stated, not chosen. The page band beside it is the
                reason it is what it is, so the reader can see the rule rather
                than just its result. */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-[15px] font-medium">{t.loanTermLabel}</span>
              <div className="text-right">
                <p className="text-[20px] font-semibold tabular-nums leading-none">
                  {loanDays} {t.loanDaysUnit}
                </p>
                <p className="text-[12px] text-ink-500 mt-1">
                  {pagesRangeLabel(pagesForBook(book))} {t.pagesUnit}
                </p>
              </div>
            </div>

            {/* Pickup + return dates */}
            <div className="grid grid-cols-2 gap-3">
              <DateCard label={t.pickupDateLabel} value={formatLongDate(pickupTs)} />
              <DateCard label={t.pickupReturnLabel} value={formatLongDate(returnTs)} />
            </div>

            {/* Who has the book, and how to reach them.
                "How" is a chat, not a phone number. Arranging a handoff needs
                the two of them to be able to talk; it does not need a reader to
                walk away holding somebody's number for good, which is what
                printing it here amounted to. The number stays visible to the
                community's admin — see utils/contactVisibility.js. */}
            <div>
              <h2 className="text-[16px] font-semibold mb-2">{t.whoHasBookNow}</h2>
              <dl className="space-y-2.5">
                <ContactRow label={t.holderLabel} value={holderName} />
                <ContactRow label={t.address} value={currentHolder?.address || t.contactNotSet} />
                {canSeePhone(user, currentHolder) ? (
                  <ContactRow label={t.phone} value={currentHolder?.phone || t.contactNotSet} />
                ) : null}
                {currentHolder?.id ? (
                  <ContactRow
                    label={t.message}
                    value={<MessageButton userId={currentHolder.id} compact />}
                  />
                ) : null}
              </dl>
            </div>

            <InfoNote text={t.pickupHandoverNote} />

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            {/* One errand at a time. Shown here rather than only on the button
                press, so a reader who cannot collect this book learns it before
                choosing a loan length — with a way to reach the book that is
                actually in their way. */}
            {blockedBy ? (
              <div className="space-y-2">
                <div className="rounded-2xl bg-warnSoft px-4 py-3.5">
                  <p className="text-[13px] text-ink-900 leading-relaxed">
                    {blockMessage(blockedBy.reason)}
                  </p>
                </div>
                {blockedBy.bookId ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/books/${blockedBy.bookId}`, { replace: true })}
                    className="btn-primary"
                  >
                    {t.pickupOpenBlockingBook}
                  </button>
                ) : null}
                <button type="button" onClick={backToBook} className="btn-secondary">
                  {t.cancel}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <button onClick={handleSendCode} disabled={sending} className="btn-primary">
                  {sending ? "…" : t.sendCode}
                </button>
                <button type="button" onClick={backToBook} className="btn-secondary">
                  {t.cancel}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-3.5">
              <p className="text-[13px] font-semibold text-brand-700 mb-0.5">
                {t.enterCodeTitle}
              </p>
              <p className="text-[12px] text-brand-600 leading-relaxed">
                {t.enterCodeBody} {holderLabel}
              </p>
            </div>

            <form onSubmit={onSubmit} className="space-y-5">
              <div>
                <p className="section-title mb-3 text-center">
                  {t.codeFrom} {holderLabel}
                </p>
                <div className="flex gap-3 justify-center">
                  {digits.map((d, i) => (
                    <input
                      key={i}
                      id={`digit-${i}`}
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
                    disabled={resending}
                    className="text-[13px] text-brand-500 font-medium hover:underline underline-offset-2 disabled:opacity-50 transition"
                  >
                    {resending ? "…" : t.resendCode}
                  </button>
                  {resent ? (
                    <p className="text-[12px] text-ok text-center">
                      ✓ {t.codeResent} — {holderLabel}
                    </p>
                  ) : null}
                </div>
              </div>

              <InfoNote text={t.pickupHandoverNote} />

              {error ? <p className="text-bad text-[13px]">{error}</p> : null}

              <div className="space-y-2">
                {/* Stays soft until all four digits are in — the design's cue
                    that this button is waiting on the holder, not the user. */}
                <button
                  disabled={submitting || !codeComplete}
                  className={
                    "w-full font-semibold rounded-xl py-3.5 transition active:scale-[0.99] " +
                    (codeComplete
                      ? "bg-brand-500 hover:bg-brand-600 text-white"
                      : "bg-brand-50 text-brand-500")
                  }
                >
                  {submitting ? "…" : t.enterCode}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="btn-secondary disabled:opacity-60"
                >
                  {cancelling ? "…" : t.cancel}
                </button>
              </div>
            </form>
          </>
        )}

        <InfoNote text={t.pickupExpiryNote} />
      </div>
    </MobileShell>
  );
}

// ─── Small presentational helpers ────────────────────────────────────────────

function DateCard({ label, value }) {
  return (
    <div className="rounded-2xl bg-ink-100 px-4 py-3.5">
      <div className="flex items-center gap-2 text-ink-900">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" className="shrink-0">
          <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="text-[15px] font-medium">{label}</span>
      </div>
      <p className="text-[14px] text-ink-700 mt-2.5">{value}</p>
    </div>
  );
}

function ContactRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[15px] text-ink-500 shrink-0">{label}</dt>
      <dd className="text-[15px] font-medium text-right break-words">{value}</dd>
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
