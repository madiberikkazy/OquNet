import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getCommunity,
  getActiveBorrowingForUser,
  getUserById,
  createNotification,
  listPendingReturnsForUser,
  openReturnRequest,
  cancelReturnRequest,
  expireReturnRequest,
  completeReturnToOwner,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { invalidateReturnRequest, invalidateHolderCaches } from "../../lib/bookCaches.js";
import { t } from "../../utils/i18n.js";
import { logger } from "../../utils/logger.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import {
  RETURN_STATE, needsSweep, returnStateFor, returnStateMessage,
} from "../../utils/bookReturn.js";
import {
  EXIT_BLOCK, evaluateExit, exitBlockMessage, loadExitBooks,
} from "../../utils/communityExit.js";
import { useLeaveCommunity } from "../../utils/useLeaveCommunity.js";

// A stable identity, so `allBooks` does not change on every render while the
// query is still loading and retrigger the memos below it.
const EMPTY_BOOKS = [];
const EMPTY_RETURNS = [];

/**
 * Step one of leaving: collecting the books you own.
 *
 * The screen is a list of the member's own books and, for each one that is with
 * somebody else, everything they need to go and get it — who has it, how to
 * reach them, and the button that sends that person a four-digit code. The code
 * itself is entered on the next screen, once the book is physically in hand.
 *
 * Nothing here decides *whether* they may leave: that verdict comes from
 * `evaluateExit` and is re-read from the server at the moment of the write. All
 * this screen owns is the errand list.
 */
export default function LeaveCommunity() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [error, setError] = useState("");
  const [busyBookId, setBusyBookId] = useState(null);

  const communityQuery = useQuery({
    queryKey: ["community", id],
    queryFn: () => getCommunity(id),
    enabled: !!id,
  });

  // Only the books this decision can turn on — the ones this user holds and the
  // ones they own — rather than the community's first two hundred. Two indexed
  // queries instead of a shelf scan, and the gate stops depending on whether a
  // stranded copy happened to fall inside that slice.
  const booksQuery = useQuery({
    queryKey: qk.books.forExit(user?.id, id),
    queryFn: () => loadExitBooks({ userId: user.id, communityId: id }),
    enabled: !!id && !!user?.id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Rule 1 is about the loan, not the book: a member is "reading" exactly while
  // they have an active borrowing. Read fresh — a cached "no active loan" from
  // before they picked a book up would open the door that must stay shut.
  const activeBorrowingQuery = useQuery({
    queryKey: qk.borrowings.forUser(user?.id, "active"),
    queryFn: () => getActiveBorrowingForUser(user.id),
    enabled: !!user?.id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Every return this member has open, in one query rather than one per book.
  const returnsQuery = useQuery({
    queryKey: qk.returnRequest.pendingForUser(user?.id),
    queryFn: () => listPendingReturnsForUser(user.id),
    enabled: !!user?.id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const allBooks = booksQuery.data ?? EMPTY_BOOKS;
  const returns = returnsQuery.data ?? EMPTY_RETURNS;

  // A filter over a set already scoped to this user by query — a handful of
  // rows, not a shelf.
  const myBooks = useMemo(
    () => allBooks.filter((b) => b.ownerId === user?.id),
    [allBooks, user?.id]
  );

  const returnByBook = useMemo(() => {
    const map = new Map();
    for (const r of returns) if (r.bookId) map.set(r.bookId, r);
    return map;
  }, [returns]);

  // One row per owned book, with the state of its handshake already resolved,
  // so the list below renders a verdict rather than working one out per branch.
  const rows = useMemo(
    () =>
      myBooks.map((book) => ({
        book,
        ...returnStateFor({
          book,
          request: returnByBook.get(book.id) ?? null,
          userId: user?.id,
        }),
      })),
    [myBooks, returnByBook, user?.id]
  );

  const away = useMemo(() => rows.filter((row) => row.state !== RETURN_STATE.HOME), [rows]);

  // Whoever is holding each of those copies. Fetched by id — the list is the
  // handful of people this member has to go and meet, not the community.
  const holderIds = useMemo(
    () => [...new Set(away.map((row) => row.holderId).filter(Boolean))].sort(),
    [away]
  );
  const holdersQuery = useQuery({
    queryKey: ["users", "holders", holderIds.join(",")],
    queryFn: async () => {
      const people = await Promise.all(holderIds.map((uid) => getUserById(uid).catch(() => null)));
      return Object.fromEntries(holderIds.map((uid, i) => [uid, people[i]]));
    },
    enabled: holderIds.length > 0,
  });
  const holders = holdersQuery.data ?? {};

  // The gate. Every condition and their order live in `evaluateExit`; this
  // screen only renders the verdict.
  const exit = useMemo(
    () =>
      evaluateExit({
        activeBorrowing: activeBorrowingQuery.data ?? null,
        books: allBooks,
        userId: user?.id,
      }),
    [activeBorrowingQuery.data, allBooks, user?.id]
  );
  const gateReady =
    !booksQuery.isPending && !activeBorrowingQuery.isPending && !returnsQuery.isPending;
  const canLeaveNow = gateReady && exit.canLeave;

  function refreshAll() {
    invalidateReturnRequest();
    queryClient.invalidateQueries({ queryKey: qk.books.forExit(user?.id, id) });
  }

  /**
   * Send the code — the whole of step one, for one book.
   *
   * A request that lapsed or went stale is closed first rather than reused: its
   * code is with somebody who has stopped expecting it (or never had the book),
   * and re-sending the same digits would be asking two different people for the
   * same handover.
   */
  const sendCode = useMutation({
    mutationFn: async (row) => {
      const { book, request, state } = row;

      if (needsSweep(state) && request?.id) {
        await (state === RETURN_STATE.EXPIRED
          ? expireReturnRequest(request.id)
          : cancelReturnRequest(request.id));
      }

      const { request: opened, created } = await openReturnRequest({
        bookId: book.id,
        requesterId: user.id,
        communityId: id,
        requesterName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      });

      // Already home — somebody handed it back from their own shelf while this
      // screen was open. Nothing to send, and the list will say so on refresh.
      if (!opened) return { bookId: book.id, sent: false };

      // The code is announced exactly once per request, and that is structural:
      // `created` can only be true for the call that wrote the request.
      if (created) {
        const holderId = opened.holderId || holderIdOf(book);
        if (holderId && holderId !== user.id) {
          await createNotification({
            recipientId: holderId,
            title: t.returnRequestNotifTitle,
            body: t.returnRequestNotifBody(
              `${user.firstName} ${user.lastName}`,
              book.name,
              opened.returnCode
            ),
            read: false,
            type: "return-request",
            bookId: book.id,
            bookName: book.name,
            // Both names, on purpose: `pickupCode` is what makes the big code
            // widget render on the notification screen, `returnCode` is what
            // this flow's own screens read.
            pickupCode: opened.returnCode,
            returnCode: opened.returnCode,
            requesterId: user.id,
          });
        }
      }
      return { bookId: book.id, sent: true };
    },
    onSuccess: ({ bookId, sent }) => {
      refreshAll();
      if (sent) navigate(`/community/${id}/leave/return/${bookId}`);
    },
    onError: (err) => {
      logger.error("leave.sendReturnCode", err?.message, { code: err?.code });
      setError(err?.message || t.error);
    },
    onSettled: () => setBusyBookId(null),
  });

  /** Call it off: the request dies and the copy goes back on the shelf. */
  const cancelReturn = useMutation({
    mutationFn: async (row) => {
      const { book, request } = row;
      if (!request?.id) return null;
      await cancelReturnRequest(request.id);
      const holderId = request.holderId || holderIdOf(book);
      if (holderId && holderId !== user.id) {
        await createNotification({
          recipientId: holderId,
          title: t.returnCancelledNotifTitle,
          body: t.returnCancelledNotifBody(
            `${user.firstName} ${user.lastName}`,
            book.name
          ),
          read: false,
          type: "return-cancelled",
          bookId: book.id,
          bookName: book.name,
        });
      }
      return book.id;
    },
    onSuccess: (bookId) => {
      if (bookId) invalidateHolderCaches(bookId);
      refreshAll();
    },
    onError: (err) => {
      logger.error("leave.cancelReturn", err?.message, { code: err?.code });
      setError(err?.message || t.error);
    },
    onSettled: () => setBusyBookId(null),
  });

  /**
   * Close a request that has stopped meaning anything — three days went by, or
   * the copy moved on to a reader the code was never sent to. Both end the same
   * way: the request is closed, the book goes back on the shelf if this request
   * is what took it off, and the owner can start again with a fresh code.
   */
  const resetRequest = useMutation({
    mutationFn: async (row) => {
      if (!row.request?.id) return null;
      await (row.state === RETURN_STATE.EXPIRED
        ? expireReturnRequest(row.request.id)
        : cancelReturnRequest(row.request.id));
      return row.book.id;
    },
    onSuccess: (bookId) => {
      if (bookId) invalidateHolderCaches(bookId);
      refreshAll();
    },
    onError: (err) => logger.error("leave.resetReturn", err?.message, { code: err?.code }),
    onSettled: () => setBusyBookId(null),
  });

  /**
   * The three tidy-ups nobody should have to press a button for.
   *
   *   1. Three days went by. The request is spent — this is where "the process
   *      cancels itself after three days" actually happens, because there is no
   *      server to do it on a timer: the owner's own screen closes it the next
   *      time they look, which frees the copy and lets them start again. The
   *      holder is told, so a code they were given stops meaning anything at a
   *      moment they can see rather than silently.
   *   2. The copy moved on to somebody the code was never sent to.
   *   3. The book came home some other way — its holder handed it back from
   *      their own shelf (`returnBookToOwner`, on the "books you have now"
   *      screen), so the code was for a handover that already happened. Closing
   *      it stops the row saying "waiting" about a book sitting in front of them.
   *
   * An effect rather than a button, because there is nothing to ask: these are
   * the owner's own requests, about their own books, and none of the three
   * changes anything anyone could still act on. The ref keeps it to one attempt
   * per request even though `rows` is rebuilt on every refetch.
   *
   * It does mean an owner who never opens the app again leaves a copy reserved.
   * That is the honest limit of a client-only sweep, and the fix is the same
   * scheduled function the rest of this project is waiting on.
   */
  const settledRef = useRef(new Set());
  useEffect(() => {
    if (!user?.id) return;
    for (const row of rows) {
      const request = returnByBook.get(row.book.id);
      if (!request?.id || settledRef.current.has(request.id)) continue;

      const expired = row.state === RETURN_STATE.EXPIRED;
      // A stale request goes the same way, and for a sharper reason: the copy
      // has moved on to a reader the code was never sent to, and until this row
      // is closed it is a pending return that stops *anyone* collecting the
      // book — a request nobody can act on holding a book nobody can borrow.
      const stale = row.state === RETURN_STATE.STALE;
      if (!expired && !stale && row.state !== RETURN_STATE.HOME) continue;
      settledRef.current.add(request.id);

      const settle = stale
        ? cancelReturnRequest(request.id)
        : expired
        ? expireReturnRequest(request.id).then(async () => {
            const holderId = request.holderId;
            if (holderId && holderId !== user.id) {
              await createNotification({
                recipientId: holderId,
                title: t.returnCancelledNotifTitle,
                body: t.returnExpiredNotifBody(
                  `${user.firstName} ${user.lastName}`, row.book.name
                ),
                read: false,
                type: "return-expired",
                bookId: row.book.id,
                bookName: row.book.name,
              });
            }
            invalidateHolderCaches(row.book.id);
          })
        : completeReturnToOwner({
            bookId: row.book.id, ownerId: user.id, requestId: request.id,
          });

      settle
        .then(() => invalidateReturnRequest())
        .catch((err) => logger.error("leave.settle", err?.message, { code: err?.code }));
    }
  }, [rows, returnByBook, user?.id]);

  // The exit itself lives in `useLeaveCommunity` — this screen and the one that
  // confirms the last book both walk through the same door.
  const leaveMutation = useLeaveCommunity(id);

  function run(mutation, row) {
    setError("");
    setBusyBookId(row.book.id);
    mutation.mutate(row);
  }

  const community = communityQuery.data;
  const blockedByReading = exit.blockedBy === EXIT_BLOCK.READING;
  const blockedByHeld = exit.blockedBy === EXIT_BLOCK.HELD;
  const mandatoryBlocked = blockedByReading || blockedByHeld;
  const anyBusy =
    sendCode.isPending || cancelReturn.isPending || resetRequest.isPending;

  return (
    <MobileShell>
      <SearchBar
        value=""
        onChange={() => {}}
        onBack={() => navigate(-1)}
        showFilter={false}
      />

      <div className="px-4 pt-2">
        <h1 className="text-[20px] font-bold leading-tight">{t.leaveTitle}</h1>
        {community?.name ? (
          <p className="text-[13px] text-ink-500 mt-1">«{community.name}»</p>
        ) : null}
        <p className="text-[14px] text-ink-700 mt-3 leading-relaxed">
          {t.leaveIntro}
        </p>
      </div>

      {/* The two blocking rules, each with the one place it is cleared. They
          are mutually exclusive by construction: reading is checked first. */}
      {blockedByReading && (
        <div className="mx-4 mt-4 rounded-2xl bg-badSoft px-4 py-3">
          <p className="text-[13px] text-bad leading-relaxed">{t.exitBlockedReading}</p>
          <button
            onClick={() => navigate("/profile/reading")}
            className="mt-2 text-[13px] font-semibold text-bad underline underline-offset-2"
          >
            {t.goToReadingBook}
          </button>
        </div>
      )}

      {blockedByHeld && (
        <div className="mx-4 mt-4 rounded-2xl bg-badSoft px-4 py-3">
          <p className="text-[13px] text-bad leading-relaxed">{t.exitBlockedHeld}</p>
          <p className="text-[12px] text-bad/80 mt-1">
            {t.exitHeldCount(exit.heldFromOthers.length)}
          </p>
          <button
            onClick={() => navigate("/profile/owned")}
            className="mt-2 text-[13px] font-semibold text-bad underline underline-offset-2"
          >
            {t.openHeldBooks}
          </button>
        </div>
      )}

      {booksQuery.isLoading ? (
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      ) : rows.length === 0 ? (
        <p className="px-6 py-10 text-center text-ink-500">{t.leaveNoBooks}</p>
      ) : (
        <ul className="mt-4 px-4 space-y-3">
          {rows.map((row) => (
            <BookRow
              key={row.book.id}
              row={row}
              holder={holders[row.holderId] ?? null}
              busy={busyBookId === row.book.id || anyBusy}
              onSendCode={() => run(sendCode, row)}
              onCancel={() => run(cancelReturn, row)}
              onReset={() => run(resetRequest, row)}
              onEnterCode={() =>
                navigate(`/community/${id}/leave/return/${row.book.id}`)
              }
            />
          ))}
        </ul>
      )}

      {/* Status band: still waiting on at least one copy. Suppressed while a
          mandatory rule is blocking — that banner is the actionable one. */}
      {!mandatoryBlocked && away.length > 0 && (
        <div className="mx-4 mt-5 rounded-2xl bg-warnSoft px-4 py-3">
          <p className="font-semibold text-[14px] text-warn">{t.waitingReturnsTitle}</p>
          <p className="text-[13px] text-ink-700 mt-1 leading-relaxed">
            {t.returnRemaining(away.length)}
          </p>
        </div>
      )}

      {error ? (
        <div className="mx-4 mt-4 rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2">
          {error}
        </div>
      ) : null}

      {/* The exit itself. It is only ever offered when every rule is clear —
          there is no second path and nothing to confirm past this button. */}
      <div className="px-4 mt-6 mb-6">
        <button
          onClick={() => {
            setError("");
            leaveMutation.mutate(undefined, {
              onError: (err) => setError(err?.message || t.error),
            });
          }}
          disabled={!canLeaveNow || leaveMutation.isPending || anyBusy}
          className="btn-primary"
        >
          {leaveMutation.isPending ? "…" : t.leaveNow}
        </button>
        <p className="text-[12px] text-ink-500 mt-2 text-center">
          {mandatoryBlocked
            ? exitBlockMessage(exit.blockedBy)
            : canLeaveNow
              ? t.returnAllHome
              : t.waitingReturnsBody}
        </p>
      </div>
    </MobileShell>
  );
}

/**
 * One book, and whatever it currently needs from its owner.
 *
 * The five states come from `returnStateFor`, and each one has exactly one
 * primary action — which is the point of deriving them centrally: the row does
 * not decide anything, it renders a decision.
 */
function BookRow({ row, holder, busy, onSendCode, onCancel, onEnterCode, onReset }) {
  const { book, state, onLoan } = row;
  const home = state === RETURN_STATE.HOME;
  const pending = state === RETURN_STATE.PENDING;
  const stale = needsSweep(state);

  const holderName = holder
    ? `${holder.firstName || ""} ${holder.lastName || ""}`.trim() || `@${holder.nickname}`
    : null;

  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="w-11 h-16 rounded-lg object-cover bg-ink-100 shrink-0"
          />
        ) : (
          <div className="w-11 h-16 rounded-lg bg-ink-100 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-[15px] truncate">{book.name}</p>
          <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
          <div className="mt-1.5">
            {home ? (
              <span className="pill bg-ok/10 text-ok text-[12px]">{t.bookWithYou}</span>
            ) : pending ? (
              <span className="pill bg-warnSoft text-warn text-[12px]">{t.returnRequestSent}</span>
            ) : (
              <span className="pill bg-ink-100 text-ink-700 text-[12px]">
                {onLoan ? t.unavailableStatus : t.bookOutOnLoan}
              </span>
            )}
          </div>
        </div>
      </div>

      {home ? null : (
        <>
          {/* Who to go and see. The address and phone are the whole point of
              this screen: the handover happens in person, and the app's only
              job is to say where. */}
          <div className="mt-3 rounded-2xl bg-ink-100/60 px-3.5 py-3">
            <p className="text-[12px] text-ink-500 mb-2">{t.whoHasBookNow}</p>
            {holder ? (
              <div className="flex items-center gap-3">
                <Avatar src={holder.photoURL} name={holderName} size={36} />
                <div className="min-w-0">
                  <p className="font-medium text-[14px] truncate">{holderName}</p>
                  <p className="text-[12px] text-ink-500 truncate">@{holder.nickname}</p>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-bad">{t.returnHolderMissing}</p>
            )}
            {holder ? (
              <dl className="mt-2.5 space-y-1.5">
                <ContactRow label={t.phone} value={holder.phone || t.contactNotSet} />
                <ContactRow label={t.address} value={holder.address || t.contactNotSet} />
              </dl>
            ) : null}
          </div>

          <p className="mt-2.5 text-[12px] text-ink-500 leading-snug">
            {returnStateMessage(state, { onLoan })}
          </p>
          {pending && row.request?.reservedBook ? (
            <p className="mt-1 text-[12px] text-ink-500 leading-snug">{t.returnReservedNote}</p>
          ) : null}

          <div className="mt-3 space-y-2">
            {pending ? (
              <>
                <button onClick={onEnterCode} disabled={busy} className="btn-primary">
                  {t.returnEnterCodeCta}
                </button>
                <button onClick={onCancel} disabled={busy} className="btn-secondary">
                  {busy ? "…" : t.returnCancelRequest}
                </button>
              </>
            ) : (
              <>
                <button onClick={onSendCode} disabled={busy} className="btn-primary">
                  {busy ? "…" : t.sendCode}
                </button>
                {stale ? (
                  <button onClick={onReset} disabled={busy} className="btn-secondary">
                    {t.returnCancelRequest}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function ContactRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-[13px] text-ink-500 shrink-0">{label}</dt>
      <dd className="text-[13px] font-medium text-right break-words">{value}</dd>
    </div>
  );
}
