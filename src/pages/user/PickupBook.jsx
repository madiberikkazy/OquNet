import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import {
  getBook,
  getUserById,
  getActiveBorrowingByBook,
  getActiveBorrowingForUser,
  getPickupRequest,
  createPickupRequest,
  cancelPickupRequest,
  fulfillPickupRequest,
  transferBookHolder,
  updateBorrowing,
  updatePickupRequest,
  createNotification,
  toMillis,
} from "../../firebase/firestore.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { invalidateHolderCaches } from "../../lib/bookCaches.js";
import { newPickupCode } from "../../firebase/schema.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import { safeImageUrl } from "../../utils/validators.js";
import { t, getCurrentLang } from "../../utils/i18n.js";
import { logger } from "../../utils/logger.js";

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
  // loanDays tracks how many days the user wants — the return date is always
  // computed from NOW at submit, so a slow handoff doesn't eat into the loan.
  const [loanDays, setLoanDays]           = useState(7);
  const [digits, setDigits]               = useState(["", "", "", ""]);
  const [error, setError]                 = useState("");
  const [sending, setSending]             = useState(false);
  const [submitting, setSubmitting]       = useState(false);
  const [cancelling, setCancelling]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [resending, setResending]         = useState(false);
  const [resent, setResent]               = useState(false);
  const [success, setSuccess]             = useState(false);

  const maxDays = book?.maxDays || 14;

  useEffect(() => {
    (async () => {
      setLoading(true);
      const b = await getBook(id);
      setBook(b);
      const bookMaxDays = b?.maxDays || 14;

      let borrowing = null;
      if (b?.status === "unavailable") {
        borrowing = await getActiveBorrowingByBook(id);
        setExistingBorrowing(borrowing);
      }
      // Whoever has the book is who hands it over and names the code — that is
      // a previous reader when the book is free but still on their shelf.
      const holderId = holderIdOf(b);
      if (holderId) setCurrentHolder(await getUserById(holderId));

      let req = null;
      if (user?.id) {
        req = await getPickupRequest(id, user.id);
        // Reopening a stale request would hand out a code nobody remembers.
        if (req && isExpired(req)) {
          try { await cancelPickupRequest(req.id); } catch (err) {
            logger.warn("pickup.expireRequest", err?.message, { bookId: id });
          }
          req = null;
          setError(t.pickupRequestExpired);
        }
      }
      setPickupRequest(req);
      setStep(req ? 2 : 1);
      setLoanDays(Math.max(1, Math.min(req?.loanDays ?? 7, bookMaxDays)));

      setLoading(false);
    })();
  }, [id, user?.id]);

  function backToBook() {
    navigate(`/books/${id}`, { replace: true });
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      if (pickupRequest?.id) await cancelPickupRequest(pickupRequest.id);
    } catch (err) {
      logger.error("pickup.cancel", err?.message, { bookId: id });
    } finally {
      setCancelling(false);
      backToBook();
    }
  }

  /**
   * Step 1 → 2. Opens the pickup request and tells whoever holds the book which
   * code to read out. The book itself does not move until that code comes back
   * on step 2 — this only announces the intent.
   */
  async function handleSendCode() {
    if (sending || !user?.id || !book) return;
    setError("");

    // One active loan at a time; check before generating anything.
    const active = await getActiveBorrowingForUser(user.id);
    if (active && active.bookId !== id) { setError(t.pickupReturnOtherBook); return; }

    setSending(true);
    try {
      const base = {
        bookId: id,
        bookName: book.name,
        requesterId: user.id,
        requesterName: `${user.firstName} ${user.lastName}`.trim(),
        loanDays,
      };

      let req;
      if (existingBorrowing) {
        // The book is out on loan: the reader's own handoff code is the one
        // they read out. Every loan is born with one — see borrowingSchema.
        const code = existingBorrowing.pickupCode;
        req = await createPickupRequest(base);
        if (existingBorrowing.borrowerId && existingBorrowing.borrowerId !== user.id) {
          await createNotification({
            recipientId: existingBorrowing.borrowerId,
            title: "Хотят забрать вашу книгу",
            body: `${base.requesterName} хочет получить книгу «${book.name}», которую вы держите. Если он заберёт книгу — назовите ему код для смены читателя.`,
            read: false,
            type: "pickup-request",
            bookId: id,
            pickupCode: code,
          });
        }
      } else {
        // The book is free but still on its last holder's shelf — the code is
        // minted here and lives on the request.
        const code = newPickupCode();
        req = await createPickupRequest({ ...base, pickupCode: code });
        const holderId = currentHolder?.id || book.ownerId;
        if (holderId && holderId !== user.id) {
          await createNotification({
            recipientId: holderId,
            title: "Запрос на книгу",
            body: `${base.requesterName} хочет взять книгу «${book.name}», которая сейчас у вас. Назовите ему код для передачи:`,
            read: false,
            type: "borrow-request",
            bookId: id,
            pickupCode: code,
          });
        }
      }

      setPickupRequest(req);
      setStep(2);
    } catch (err) {
      logger.error("pickup.sendCode", err?.message, { code: err?.code, bookId: id });
      setError(err?.message || t.error);
    } finally {
      setSending(false);
    }
  }

  async function handleResend() {
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
    } finally { setResending(false); }
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

    setSubmitting(true);
    try {
      const active = await getActiveBorrowingForUser(user.id);
      if (active && active.bookId !== id) { setError(t.pickupReturnOtherBook); return; }

      const days = Math.max(1, Math.min(pickupRequest?.loanDays ?? loanDays, maxDays));
      const actualReturnTs = addDays(Date.now(), days).getTime();

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
    } finally { setSubmitting(false); }
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
            {/* Loan length */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-[15px] font-medium">{t.loanDaysLabel}</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setLoanDays((d) => Math.max(1, d - 1))}
                  disabled={loanDays <= 1}
                  className="w-9 h-9 rounded-full bg-ink-100 text-ink-700 flex items-center justify-center disabled:opacity-40 transition active:scale-95"
                  aria-label="−"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </button>
                <span className="w-8 text-center text-[20px] font-semibold tabular-nums">{loanDays}</span>
                <button
                  type="button"
                  onClick={() => setLoanDays((d) => Math.min(maxDays, d + 1))}
                  disabled={loanDays >= maxDays}
                  className="w-9 h-9 rounded-full bg-brand-500 text-white flex items-center justify-center disabled:opacity-40 transition active:scale-95"
                  aria-label="+"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Pickup + return dates */}
            <div className="grid grid-cols-2 gap-3">
              <DateCard label={t.pickupDateLabel} value={formatLongDate(pickupTs)} />
              <DateCard label={t.pickupReturnLabel} value={formatLongDate(returnTs)} />
            </div>

            {/* Who has the book, and how to reach them */}
            <div>
              <h2 className="text-[16px] font-semibold mb-2">{t.whoHasBookNow}</h2>
              <dl className="space-y-2.5">
                <ContactRow label={t.holderLabel} value={holderName} />
                <ContactRow label={t.address} value={currentHolder?.address || t.contactNotSet} />
                <ContactRow label={t.phone} value={currentHolder?.phone || t.contactNotSet} />
              </dl>
            </div>

            <InfoNote text={t.pickupHandoverNote} />

            {error ? <p className="text-bad text-[13px]">{error}</p> : null}

            <div className="space-y-2">
              <button onClick={handleSendCode} disabled={sending} className="btn-primary">
                {sending ? "…" : t.sendCode}
              </button>
              <button type="button" onClick={backToBook} className="btn-secondary">
                {t.cancel}
              </button>
            </div>
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
    <div className="flex items-start justify-between gap-4">
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
