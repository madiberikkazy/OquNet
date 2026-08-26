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
  listPendingReturnsForHolder,
  openReturnRequest,
  offerReturnToOwner,
  cancelReturnRequest,
  expireReturnRequest,
  completeReturnToOwner,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { invalidateReturnRequest, invalidateHolderCaches } from "../../lib/bookCaches.js";
import { t } from "../../utils/i18n.js";
import { canSeePhone } from "../../utils/contactVisibility.js";
import MessageButton from "../../components/MessageButton.jsx";
import { writeError } from "../../utils/writeError.js";
import { logger } from "../../utils/logger.js";
import { holderIdOf } from "../../utils/bookHolder.js";
import {
  RETURN_STATE, needsSweep, returnStateFor, returnStateMessage,
} from "../../utils/bookReturn.js";
import {
  EXIT_BLOCK, booksHeldFromOthers, evaluateExit, exitBlockMessage, loadExitBooks,
} from "../../utils/communityExit.js";
import { useLeaveCommunity } from "../../utils/useLeaveCommunity.js";
import Loading from "../../components/Loading.jsx";

// A stable identity, so `allBooks` does not change on every render while the
// query is still loading and retrigger the memos below it.
const EMPTY_BOOKS = [];
const EMPTY_RETURNS = [];

/**
 * Step one of leaving: the books, in both directions.
 *
 * Two lists, because leaving has two kinds of errand and both are handshakes:
 *
 *   · the member's own copies that are with other people — they go and collect
 *     each one, and the code is entered here once it is in hand;
 *   · other people's copies in the member's hands — they hand each one back,
 *     and the code is the four digits they read out when they do.
 *
 * The second list used to be a red banner with a count and a link to another
 * screen. That was the one blocking rule this page could state but not clear,
 * and it sent the member away from the errand list to find the errands. Both
 * halves now sit here, each with the same three states: send the code, wait
 * while it is out, or call it off.
 *
 * Which end holds the code is the same rule as everywhere else in the app —
 * whoever is handing the book over carries it, and whoever is receiving it
 * types it. So the member reads a code out for the books they are giving back,
 * and types one in for the books they are collecting.
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

  // The mirror of the query above: returns where this member is the one handing
  // a book over rather than the one collecting it. A return names its collector
  // in `requesterId`, so the two lists genuinely need two queries.
  const handoversQuery = useQuery({
    queryKey: qk.returnRequest.byHolder(user?.id, id),
    queryFn: () => listPendingReturnsForHolder({ holderId: user.id, communityId: id }),
    enabled: !!user?.id && !!id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const allBooks = booksQuery.data ?? EMPTY_BOOKS;
  const returns = returnsQuery.data ?? EMPTY_RETURNS;
  const handovers = handoversQuery.data ?? EMPTY_RETURNS;

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

  // ── The other direction: books of other people's, in this member's hands ──
  const handoverByBook = useMemo(() => {
    const map = new Map();
    for (const r of handovers) if (r.bookId) map.set(r.bookId, r);
    return map;
  }, [handovers]);

  // Derived from the books rather than from `exit`, which is computed further
  // down — and from the same helper the gate itself uses, so the list and the
  // rule that blocks on it can never count different books.
  //
  // `returnStateFor` reads the same two documents either way round: it asks
  // where the book is and whether a request is live, not who is asking.
  const heldRows = useMemo(
    () =>
      booksHeldFromOthers(allBooks, user?.id).map((book) => ({
        book,
        ...returnStateFor({
          book,
          request: handoverByBook.get(book.id) ?? null,
          userId: user?.id,
        }),
      })),
    [allBooks, handoverByBook, user?.id]
  );

  // Who each of those copies goes back to. Same shape as `holders` below, one
  // fetch per person rather than per book.
  const ownerIds = useMemo(
    () => [...new Set(heldRows.map((row) => row.book.ownerId).filter(Boolean))].sort(),
    [heldRows]
  );
  const ownersQuery = useQuery({
    queryKey: ["users", "owners", ownerIds.join(",")],
    queryFn: async () => {
      const people = await Promise.all(ownerIds.map((uid) => getUserById(uid).catch(() => null)));
      return Object.fromEntries(ownerIds.map((uid, i) => [uid, people[i]]));
    },
    enabled: ownerIds.length > 0,
  });
  const owners = ownersQuery.data ?? {};

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
      setError(writeError(err));
    },
    onSettled: () => setBusyBookId(null),
  });

  /**
   * The same errand in the other direction: offer a book back to its owner.
   *
   * The code this mints stays with the member — they are the one handing the
   * book over — and the owner is told a return is waiting, without the digits,
   * so that confirming it still takes the two of them meeting. Same call the
   * "books you have now" screen makes; the leave screen is simply where it
   * matters most, because this is the rule that stops the exit.
   */
  const offerBack = useMutation({
    mutationFn: async (row) => {
      const { book, request, state } = row;

      // A lapsed or stale offer is closed before a new one opens, for the same
      // reason a lapsed collection is: its digits are with somebody who has
      // stopped expecting them.
      if (needsSweep(state) && request?.id) {
        await (state === RETURN_STATE.EXPIRED
          ? expireReturnRequest(request.id)
          : cancelReturnRequest(request.id));
      }

      const { request: opened, created, alreadyHome } = await offerReturnToOwner({
        bookId: book.id,
        holderId: user.id,
      });
      if (alreadyHome || !opened) return { bookId: book.id, sent: false };

      // Announced exactly once per request — `created` can only be true for the
      // call that wrote it, so a second tap cannot produce a second message.
      if (created && book.ownerId && book.ownerId !== user.id) {
        await createNotification({
          recipientId: book.ownerId,
          title: t.returnOfferNotifTitle,
          body: t.returnOfferNotifBody(
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
            book.name
          ),
          read: false,
          type: "return-offer",
          bookId: book.id,
          bookName: book.name,
          holderId: user.id,
          // Deliberately no code: the owner is the one who types it.
        });
      }
      return { bookId: book.id, sent: true };
    },
    onSuccess: () => refreshAll(),
    onError: (err) => {
      logger.error("leave.offerReturn", err?.message, { code: err?.code });
      setError(writeError(err));
    },
    onSettled: () => setBusyBookId(null),
  });

  /** Withdraw an offer. Nothing moved, so nothing has to move back. */
  const cancelOffer = useMutation({
    mutationFn: async (row) => {
      const { book, request } = row;
      if (!request?.id) return null;
      await cancelReturnRequest(request.id);
      if (book.ownerId && book.ownerId !== user.id) {
        await createNotification({
          recipientId: book.ownerId,
          title: t.returnOfferCancelledNotifTitle,
          body: t.returnOfferCancelledNotifBody(
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
            book.name
          ),
          read: false,
          type: "return-offer-cancelled",
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
      logger.error("leave.cancelOffer", err?.message, { code: err?.code });
      setError(writeError(err));
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
      setError(writeError(err));
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
    sendCode.isPending || cancelReturn.isPending || resetRequest.isPending ||
    offerBack.isPending || cancelOffer.isPending;

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

      {/* No link out of here any more. This rule used to be stated with a
          count and a button to another screen; the books it counts are now
          listed below it, with the same handshake as everything else. */}
      {blockedByHeld && (
        <div className="mx-4 mt-4 rounded-2xl bg-badSoft px-4 py-3">
          <p className="text-[13px] text-bad leading-relaxed">{t.exitBlockedHeld}</p>
          <p className="text-[12px] text-bad/80 mt-1">
            {t.exitHeldCount(heldRows.length)}
          </p>
        </div>
      )}

      {booksQuery.isLoading ? (
        <Loading />
      ) : rows.length === 0 && heldRows.length === 0 ? (
        <p className="px-6 py-10 text-center text-ink-500">{t.leaveNoBooks}</p>
      ) : (
        <>
          {/* ── Books to hand back ──
              First, because it is the blocking rule: the exit will not open
              while any of these is still in this member's hands. */}
          {heldRows.length > 0 && (
            <section className="mt-4">
              <h2 className="px-4 text-[13px] font-semibold text-ink-500">
                {t.leaveHandBackTitle}
              </h2>
              <ul className="mt-2 px-4 space-y-3">
                {heldRows.map((row) => (
                  <HandBackRow
                    key={row.book.id}
                    row={row}
                    owner={owners[row.book.ownerId] ?? null}
                    busy={busyBookId === row.book.id || anyBusy}
                    onOffer={() => run(offerBack, row)}
                    onCancel={() => run(cancelOffer, row)}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* ── Books to collect ── */}
          {rows.length > 0 && (
            <section className="mt-5">
              {heldRows.length > 0 && (
                <h2 className="px-4 text-[13px] font-semibold text-ink-500">
                  {t.leaveCollectTitle}
                </h2>
              )}
              <ul className="mt-2 px-4 space-y-3">
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
            </section>
          )}
        </>
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
              onError: (err) => setError(writeError(err)),
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
/**
 * One book of somebody else's, in this member's hands, on its way back.
 *
 * The mirror of `BookRow`: same card, same three states, everything pointing
 * the other way. The member is handing this one over, so the four digits are
 * *shown* here rather than typed — they read them out at the handover and the
 * owner enters them. Which is why there is no "enter code" button on this row
 * and no route out of this screen: the member's part is done once the code is
 * out, and the rest is the owner's.
 */
function HandBackRow({ row, owner, busy, onOffer, onCancel }) {
  // Who is looking decides whether a phone number is drawn at all.
  const { user: viewer } = useAuth();
  const { book, state, request } = row;
  const pending = state === RETURN_STATE.PENDING;
  const stale = needsSweep(state);

  const ownerName = owner
    ? `${owner.firstName || ""} ${owner.lastName || ""}`.trim() || `@${owner.nickname}`
    : null;

  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" className="w-11 h-16 rounded-lg object-cover bg-ink-100 shrink-0" />
        ) : (
          <div className="w-11 h-16 rounded-lg bg-ink-100 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-[15px] truncate">{book.name}</p>
          <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
          <div className="mt-1.5">
            <span
              className={
                "pill text-[12px] " +
                (pending ? "bg-warnSoft text-warn" : "bg-ink-100 text-ink-700")
              }
            >
              {pending ? t.returnOfferWaiting : t.leaveHandBackPending}
            </span>
          </div>
        </div>
      </div>

      {/* Who it goes back to, and how to reach them — the handover happens in
          person, and saying where is the whole job of this card. */}
      <div className="mt-3 rounded-2xl bg-ink-100/60 px-3.5 py-3">
        <p className="text-[12px] text-ink-500 mb-2">{t.returnOfferWhoCollects}</p>
        {owner ? (
          <>
            <div className="flex items-center gap-3">
              <Avatar src={owner.photoURL} name={ownerName} size={36} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[14px] truncate">{ownerName}</p>
                <p className="text-[12px] text-ink-500 truncate">@{owner.nickname}</p>
              </div>
              <MessageButton userId={owner.id} compact />
            </div>
            <dl className="mt-2.5 space-y-1.5">
              {canSeePhone(viewer, owner) ? (
                <ContactRow label={t.phone} value={owner.phone || t.contactNotSet} />
              ) : null}
              <ContactRow label={t.address} value={owner.address || t.contactNotSet} />
            </dl>
          </>
        ) : (
          <p className="text-[13px] text-bad">{t.returnHolderMissing}</p>
        )}
      </div>

      {pending && request?.returnCode ? (
        <div className="mt-3 rounded-2xl bg-brand-50 px-3.5 py-3 flex flex-col items-center gap-2">
          <p className="text-[12px] text-ink-500">{t.returnOfferCodeTitle}</p>
          <div className="flex gap-2">
            {String(request.returnCode).split("").map((digit, i) => (
              <span
                key={i}
                className="w-10 h-12 flex items-center justify-center rounded-xl bg-base text-brand-500 text-xl font-bold"
              >
                {digit}
              </span>
            ))}
          </div>
          <p className="text-[12px] text-ink-500 text-center leading-snug">
            {t.returnOfferCodeNote}
          </p>
        </div>
      ) : (
        <p className="mt-2.5 text-[12px] text-ink-500 leading-snug">{t.leaveHandBackHint}</p>
      )}

      <div className="mt-3 space-y-2">
        {pending ? (
          <button onClick={onCancel} disabled={busy} className="btn-secondary">
            {busy ? "…" : t.returnOfferCancel}
          </button>
        ) : (
          <>
            <button onClick={onOffer} disabled={busy} className="btn-primary">
              {busy ? "…" : t.returnOfferSend}
            </button>
            {stale ? (
              <p className="text-[12px] text-ink-500 text-center">
                {returnStateMessage(state)}
              </p>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function BookRow({ row, holder, busy, onSendCode, onCancel, onEnterCode, onReset }) {
  const { user: viewer } = useAuth();
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
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[14px] truncate">{holderName}</p>
                  <p className="text-[12px] text-ink-500 truncate">@{holder.nickname}</p>
                </div>
                <MessageButton userId={holder.id} compact />
              </div>
            ) : (
              <p className="text-[13px] text-bad">{t.returnHolderMissing}</p>
            )}
            {holder ? (
              <dl className="mt-2.5 space-y-1.5">
                {canSeePhone(viewer, holder) ? (
                  <ContactRow label={t.phone} value={holder.phone || t.contactNotSet} />
                ) : null}
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
