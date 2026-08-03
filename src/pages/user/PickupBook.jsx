import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import {
  getBook,
  getUserById,
  getActiveBorrowingByBook,
  getActiveBorrowingForUser,
  getPickupRequest,
  cancelPickupRequest,
  fulfillPickupRequest,
  transferBookHolder,
  updateBorrowing,
  updatePickupRequest,
  createNotification,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { invalidateHolderCaches } from "../../lib/bookCaches.js";
import { holderIdOf } from "../../utils/bookHolder.js";

function makeCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function fmt(d) { return new Date(d).toISOString().slice(0, 10); }

export default function PickupBook() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [book, setBook]                   = useState(null);
  const [currentHolder, setCurrentHolder] = useState(null);
  const [existingBorrowing, setExistingBorrowing] = useState(null);
  const [pickupRequest, setPickupRequest] = useState(null);
  // loanDays tracks how many days the user wants — always computed from NOW at submit
  const [loanDays, setLoanDays]           = useState(7);
  const [returnDate, setReturnDate]       = useState("");
  const [digits, setDigits]               = useState(["", "", "", ""]);
  const [error, setError]                 = useState("");
  const [submitting, setSubmitting]       = useState(false);
  const [cancelling, setCancelling]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [resending, setResending]         = useState(false);
  const [resent, setResent]               = useState(false);
  const [success, setSuccess]             = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const b = await getBook(id);
      setBook(b);
      const defaultDays = Math.min(7, b?.maxDays || 14);
      setLoanDays(defaultDays);
      setReturnDate(fmt(addDays(Date.now(), defaultDays)));

      let borrowing = null;
      if (b?.status === "unavailable") {
        borrowing = await getActiveBorrowingByBook(id);
        setExistingBorrowing(borrowing);
      }
      // Whoever has the book is who hands it over and names the code — that is
      // a previous reader when the book is free but still on their shelf.
      const holderId = holderIdOf(b, borrowing);
      if (holderId) setCurrentHolder(await getUserById(holderId));

      if (user?.id) {
        const req = await getPickupRequest(id, user.id);
        setPickupRequest(req);
      }

      setLoading(false);
    })();
  }, [id, user?.id]);

  async function handleCancel() {
    setCancelling(true);
    try {
      if (pickupRequest?.id) await cancelPickupRequest(pickupRequest.id);
    } catch (e) { console.error(e); }
    finally {
      setCancelling(false);
      navigate(`/books/${id}`, { replace: true });
    }
  }

  async function handleResend() {
    setResending(true);
    setResent(false);
    try {
      const newCode = makeCode();

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
    } catch (err) { console.error(err); }
    finally { setResending(false); }
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
    if (submitting || !user?.id || !book) return; // double-tap + missing-prereq guard
    setError("");
    const enteredCode = digits.join("");
    if (enteredCode.length < 4) { setError("Введите 4-значный код"); return; }

    if (existingBorrowing) {
      // Case 1: book held by someone
      if (enteredCode !== existingBorrowing.pickupCode) {
        setError("Неверный код. Попросите текущего читателя назвать вам код или отправьте напоминание.");
        return;
      }
      setSubmitting(true);
      try {
        const active = await getActiveBorrowingForUser(user.id);
        if (active && active.bookId !== id) { setError("Сначала верните взятую вами книгу."); return; }

        const actualReturnTs = addDays(Date.now(), loanDays).getTime();
        // Taking the book off a live reader: their loan closes, ours opens, and
        // the holder moves to us. The owner is untouched — `transferBookHolder`
        // reads it off the stored book and hands it back for the notification.
        const { ownerId } = await transferBookHolder({
          bookId: id,
          toUserId: user.id,
          previousBorrowingId: existingBorrowing.id,
          borrowing: {
            bookName: book.name,
            communityId: book.communityId,
            startDate: Date.now(),
            returnDate: actualReturnTs,
            pickupCode: makeCode(), // stored silently, revealed when the next reader asks
          },
        });
        // Notify owner — no code, just info
        if (ownerId && ownerId !== user.id) {
          await createNotification({
            recipientId: ownerId,
            title: "Кітап жаңа оқырманда",
            body: `«${book.name}» кітабы енді ${user.firstName} ${user.lastName} (@${user.nickname}) қолында.`,
            read: false,
            type: "book-transferred",
            bookId: id,
          });
        }
        if (pickupRequest?.id) await fulfillPickupRequest(pickupRequest.id);
        invalidateHolderCaches(id);
        setSuccess(true);
      } catch (err) {
        setError(err?.message || "Ошибка");
      } finally { setSubmitting(false); }
      return;
    }

    // Case 2: free book
    const expectedCode = pickupRequest?.pickupCode;
    if (!expectedCode || enteredCode !== expectedCode) {
      setError("Неверный код. Проверьте код у владельца книги или отправьте напоминание.");
      return;
    }
    setSubmitting(true);
    try {
      const active = await getActiveBorrowingForUser(user.id);
      if (active && active.bookId !== id) { setError("Сначала верните взятую вами книгу."); return; }
      if (loanDays > (book.maxDays || 14)) {
        setError(`Максимальный срок — ${book.maxDays || 14} дней.`);
        return;
      }

      const actualReturnTs = addDays(Date.now(), loanDays).getTime();
      // Collecting a book that is free but still on its last holder's shelf.
      // No loan to close — just open ours and move the holder.
      const { ownerId } = await transferBookHolder({
        bookId: id,
        toUserId: user.id,
        borrowing: {
          bookName: book.name,
          communityId: book.communityId,
          startDate: Date.now(),
          returnDate: actualReturnTs,
          pickupCode: makeCode(), // stored silently, used when the next reader asks
        },
      });
      // Notify owner — just confirmation, no code
      if (ownerId && ownerId !== user.id) {
        await createNotification({
          recipientId: ownerId,
          title: "Кітап берілді",
          body: `${user.firstName} ${user.lastName} сіздің «${book.name}» кітабыңызды алды.`,
          read: false,
          type: "book-transferred",
          bookId: id,
        });
      }
      if (pickupRequest?.id) await fulfillPickupRequest(pickupRequest.id);
      invalidateHolderCaches(id);
      setSuccess(true);
    } catch (err) {
      setError(err?.message || "Ошибка");
    } finally { setSubmitting(false); }
  }

  if (loading || !book) {
    return (
      <MobileShell withNav={false}>
        <p className="px-6 py-12 text-center text-ink-500">Загрузка...</p>
      </MobileShell>
    );
  }

  // ── Success screen ───────────────────────────────────────────────────────
  if (success) {
    return (
      <MobileShell withNav={false}>
        <div className="flex flex-col items-center px-6 pt-20 pb-10 gap-7 text-center">
          {/* Big checkmark circle */}
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

          <button
            onClick={() => navigate(`/books/${id}`, { replace: true })}
            className="btn-primary"
          >
            Кітапқа өту →
          </button>
        </div>
      </MobileShell>
    );
  }

  const isUnavailable = book.status === "unavailable";
  const needsCode = isUnavailable || Boolean(pickupRequest?.pickupCode);
  // Name the person who actually has the book; fall back to their role only
  // when we could not load them.
  const holderLabel = currentHolder
    ? `@${currentHolder.nickname}`
    : isUnavailable
      ? "текущего читателя"
      : "владельца книги";

  return (
    <MobileShell withNav={false}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-2">
        <button onClick={() => navigate(`/books/${id}`, { replace: true })} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold truncate">Получить книгу</h1>
      </div>

      <div className="px-5 pt-5 space-y-5">
        {/* Book card */}
        <div className="card p-4 flex gap-3">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt={book.name}
              className="w-14 h-20 rounded-md object-cover bg-ink-100 shrink-0" />
          ) : null}
          <div className="min-w-0">
            <p className="font-semibold text-[15px] truncate">{book.name}</p>
            <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
          </div>
        </div>

        {needsCode ? (
          <>
            <div className="rounded-2xl bg-brand-50 border border-brand-200 px-4 py-4">
              <p className="text-[14px] font-semibold text-brand-900 mb-1">
                Когда получите книгу — введите код
              </p>
              <p className="text-[13px] text-brand-700 leading-relaxed">
                Попросите {holderLabel} назвать вам 4-значный код.
              </p>
            </div>

            <form onSubmit={onSubmit} className="space-y-5">
              {/* Code boxes */}
              <div>
                <p className="section-title mb-3 text-center">
                  Код от {holderLabel}
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
                    {resending ? "Отправляем..." : "Отправить код повторно"}
                  </button>
                  {resent ? (
                    <p className="text-[12px] text-ok text-center">
                      ✓ Код повторно отправлен {holderLabel}.
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Return date — loanDays is recalculated from NOW, so the
                  actual return date is always relative to the real handoff date */}
              <div>
                <p className="section-title mb-1">Дата возврата</p>
                <input
                  type="date"
                  value={returnDate}
                  min={fmt(Date.now())}
                  max={fmt(addDays(Date.now(), book.maxDays || 14))}
                  onChange={(e) => {
                    setReturnDate(e.target.value);
                    const days = Math.round(
                      (new Date(e.target.value).getTime() - Date.now()) / 86400000
                    );
                    setLoanDays(Math.max(1, Math.min(days, book.maxDays || 14)));
                  }}
                  className="input"
                />
                <p className="text-[12px] text-ink-500 mt-1">
                  Максимум {book.maxDays || 14} дней
                </p>
              </div>

              {error ? <p className="text-bad text-[13px]">{error}</p> : null}

              <button disabled={submitting} className="btn-primary">
                {submitting ? "…" : "Подтвердить получение"}
              </button>
              <button type="button" onClick={handleCancel} disabled={cancelling} className="btn-secondary">
                {cancelling ? "…" : "Отмена"}
              </button>
            </form>
          </>
        ) : (
          <div className="rounded-2xl bg-ink-100 px-4 py-5 text-center space-y-3">
            <p className="text-[14px] text-ink-700">
              Запрос на книгу не найден. Вернитесь назад и нажмите «Получить книгу» снова.
            </p>
            <button onClick={handleCancel} className="btn-secondary">Назад</button>
          </div>
        )}
      </div>
    </MobileShell>
  );
}
