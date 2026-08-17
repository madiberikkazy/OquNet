import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  cancelReturnRequest, createNotification, getBook, getPendingReturnForBook,
  getUserById, offerReturnToOwner,
} from "../../firebase/firestore.js";
import { invalidateHolderCaches, invalidateReturnRequest } from "../../lib/bookCaches.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import { safeImageUrl } from "../../utils/validators.js";
import { t } from "../../utils/i18n.js";
import { writeError } from "../../utils/writeError.js";
import { logger } from "../../utils/logger.js";

/**
 * Handing a book back to its owner — the holder's half of the handshake.
 *
 * This screen is the mirror of PickupBook, and it exists because returning used
 * to be the one handoff with nobody on the other side of it: a button on the
 * "books you have now" list wrote the book home and told its owner afterwards.
 * The owner had no say in a claim about where their own property was.
 *
 * The shape is the same as every other handoff in the app, so there is nothing
 * new to learn: whoever is giving the book away holds the code, and whoever is
 * receiving it types it in. Here that means the code stays on this screen, and
 * the owner gets a notification saying a return is waiting for them — without
 * the digits in it, because a code sent to the person who enters it is a
 * confirm button wearing a code's clothes.
 *
 * Nothing here moves the book. `completeReturnToOwner` does, on the owner's
 * screen, once the four digits match.
 */
export default function ReturnToOwner() {
  const { id: bookId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [book, setBook]       = useState(null);
  const [owner, setOwner]     = useState(null);
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [notice, setNotice]   = useState("");
  const [busy, setBusy]       = useState("");   // "send" | "cancel"

  // Refs rather than state, for the same reason PickupBook uses them: `busy` is
  // only visible to the *next* render, so two taps inside one await would both
  // read it as free and both send a code.
  const sendingRef = useRef(false);
  const cancellingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const b = await getBook(bookId);
        if (cancelled) return;
        setBook(b);
        if (!b) { setError(t.returnBookGone); return; }

        // Only the person actually holding it may hand it over, and never to
        // themselves. Both are checked again in the data layer and in the
        // rules; this is so the screen says so instead of a write failing.
        if (b.ownerId === user?.id) { setNotice(t.returnOfferAlreadyHome); return; }
        if (holderIdOf(b) !== user?.id) { setError(t.notAuthorized); return; }

        const [person, existing] = await Promise.all([
          getUserById(b.ownerId).catch(() => null),
          getPendingReturnForBook({ bookId, communityId: b.communityId }).catch(() => null),
        ]);
        if (cancelled) return;
        setOwner(person);
        if (existing) {
          setRequest(existing);
          setNotice(t.returnOfferExisting);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId, user?.id]);

  /**
   * Open the return and tell the owner. The notification is sent only when this
   * call is what created the request — `offerReturnToOwner` hands back an
   * already-open one rather than a second, so a second tap cannot produce a
   * second code or a second message.
   */
  async function handleSend() {
    if (sendingRef.current || !book || !user?.id) return;
    sendingRef.current = true;
    setBusy("send");
    setError("");
    try {
      const { request: opened, created, alreadyHome } = await offerReturnToOwner({
        bookId, holderId: user.id,
      });
      if (alreadyHome) { setNotice(t.returnOfferAlreadyHome); return; }

      setRequest(opened);
      if (created) {
        await createNotification({
          recipientId: book.ownerId,
          title: t.returnOfferNotifTitle,
          body: t.returnOfferNotifBody(
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
            book.name
          ),
          read: false,
          type: "return-offer",
          bookId,
          bookName: book.name,
          holderId: user.id,
          // No `pickupCode` and no `returnCode`. The owner is the one who types
          // the digits; handing them the answer would make the code decorative.
        }).catch((err) => {
          // The request stands and the code is on screen — the owner can still
          // be told in person. Worth logging, not worth failing the return over.
          logger.warn("returnToOwner.notify", err?.message, { bookId });
        });
      } else {
        setNotice(t.returnOfferExisting);
      }
      invalidateReturnRequest();
    } catch (err) {
      logger.error("returnToOwner.send", err?.message, { code: err?.code, bookId });
      setError(writeError(err));
    } finally {
      sendingRef.current = false;
      setBusy("");
    }
  }

  /** Withdraw the offer. Nothing moved, so nothing has to move back. */
  async function handleCancel() {
    if (cancellingRef.current || !request?.id) return;
    cancellingRef.current = true;
    setBusy("cancel");
    try {
      await cancelReturnRequest(request.id);
      if (book?.ownerId && book.ownerId !== user?.id) {
        await createNotification({
          recipientId: book.ownerId,
          title: t.returnOfferCancelledNotifTitle,
          body: t.returnOfferCancelledNotifBody(
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
            book.name
          ),
          read: false,
          type: "return-offer-cancelled",
          bookId,
          bookName: book.name,
        }).catch((err) => logger.warn("returnToOwner.notifyCancel", err?.message, { bookId }));
      }
      invalidateReturnRequest();
      invalidateHolderCaches(bookId);
      navigate(-1);
    } catch (err) {
      logger.error("returnToOwner.cancel", err?.message, { code: err?.code, bookId });
      setError(writeError(err));
    } finally {
      cancellingRef.current = false;
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

  const ownerName = owner
    ? `${owner.firstName || ""} ${owner.lastName || ""}`.trim() || `@${owner.nickname}`
    : t.contactNotSet;
  const code = request?.returnCode || "";

  return (
    <MobileShell withNav={false}>
      <div className="relative flex items-center justify-center px-4 pt-2 pb-1">
        <button onClick={() => navigate(-1)} className="absolute left-4 icon-btn" aria-label={t.back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[19px] font-semibold">{t.returnOfferTitle}</h1>
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

        {notice ? (
          <div className="rounded-2xl bg-warnSoft px-4 py-3">
            <p className="text-[13px] text-ink-900 leading-relaxed">{notice}</p>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2">{error}</div>
        ) : null}

        {/* Who to hand it to, and how to reach them — the same card the owner's
            screen shows about the holder, pointing the other way. */}
        {owner ? (
          <div className="rounded-2xl bg-ink-100/60 px-4 py-3.5">
            <p className="text-[12px] text-ink-500 mb-2">{t.returnOfferWhoCollects}</p>
            <div className="flex items-center gap-3">
              <Avatar src={owner.photoURL} name={ownerName} size={40} />
              <div className="min-w-0">
                <p className="font-medium text-[15px] truncate">{ownerName}</p>
                <p className="text-[12px] text-ink-500 truncate">@{owner.nickname}</p>
              </div>
            </div>
            <dl className="mt-3 space-y-2">
              <ContactRow label={t.phone} value={owner.phone || t.contactNotSet} />
              <ContactRow label={t.address} value={owner.address || t.contactNotSet} />
            </dl>
          </div>
        ) : null}

        {code ? (
          <>
            <div className="card p-5 flex flex-col items-center gap-3">
              <p className="text-[13px] text-ink-500 font-medium">{t.returnOfferCodeTitle}</p>
              <div className="flex gap-3">
                {String(code).split("").map((digit, i) => (
                  <div
                    key={i}
                    className="w-14 h-16 flex items-center justify-center rounded-2xl bg-brand-50 text-brand-500 text-2xl font-bold"
                  >
                    {digit}
                  </div>
                ))}
              </div>
              <p className="text-[12px] text-ink-500 text-center">{t.returnOfferCodeNote}</p>
            </div>

            <p className="text-[13px] text-ink-500 text-center">{t.returnOfferWaiting}</p>

            <button
              onClick={handleCancel}
              disabled={busy === "cancel"}
              className="btn-secondary"
            >
              {busy === "cancel" ? "…" : t.returnOfferCancel}
            </button>
          </>
        ) : (
          <>
            <p className="text-[14px] text-ink-700 leading-relaxed">{t.returnOfferIntro}</p>
            <button
              onClick={handleSend}
              disabled={busy === "send" || !book || book.ownerId === user?.id}
              className="btn-primary"
            >
              {busy === "send" ? "…" : t.returnOfferSend}
            </button>
          </>
        )}
      </div>
    </MobileShell>
  );
}

function ContactRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-ink-500 shrink-0">{label}</dt>
      <dd className="text-[13px] text-ink-900 text-right break-words min-w-0">{value}</dd>
    </div>
  );
}
