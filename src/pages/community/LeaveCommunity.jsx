import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  getCommunity,
  listBooks,
  getActiveBorrowingByBook,
  createNotification,
  updateUser,
  deleteBook,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { t } from "../../utils/i18n.js";
import { logger } from "../../utils/logger.js";
import { readerHolderIdOf } from "../../utils/bookHolder.js";

function makeCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// A book is "with the leaving user" when it's not out on loan or when they
// happen to also be the current holder (unusual, but the data model allows it).
function isBookWithUser(book, userId) {
  if (!book) return false;
  if (book.status !== "unavailable") return true;
  return readerHolderIdOf(book) === userId;
}

export default function LeaveCommunity() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, setUser } = useAuth();
  const { setCommunity } = useCommunity();

  const communityQuery = useQuery({
    queryKey: ["community", id],
    queryFn: () => getCommunity(id),
    enabled: !!id,
  });

  // Reuse the exact key + fetcher shape the Books list already uses so the
  // cache is shared across screens.
  const booksQuery = useQuery({
    queryKey: qk.books.list(id, { search: "", status: null, genres: [] }),
    queryFn: () => listBooks({ communityId: id, pageSize: 200 }),
    enabled: !!id,
  });

  const myBooks = useMemo(() => {
    const raw = booksQuery.data;
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    return items.filter((b) => b.ownerId === user?.id);
  }, [booksQuery.data, user?.id]);

  // Selection scopes which books get a "please return" nudge. The leave itself
  // is gated on *every* owned book being with the user — anything else would
  // orphan books mid-loan when the owner walks away.
  const [selected, setSelected] = useState(() => new Set());
  const [requestSent, setRequestSent] = useState(() => new Set());
  const [error, setError] = useState("");

  useSelectionInit(myBooks, setSelected, user?.id);

  function toggle(bookId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }

  const selectedBooks = useMemo(
    () => myBooks.filter((b) => selected.has(b.id)),
    [myBooks, selected]
  );
  const outstanding = useMemo(
    () =>
      selectedBooks.filter(
        (b) => !isBookWithUser(b, user?.id) && !requestSent.has(b.id)
      ),
    [selectedBooks, user?.id, requestSent]
  );

  // Cannot leave while ANY owned book is still with someone else. This is
  // stricter than "the ones you ticked" — otherwise unchecking an out-book
  // would let you leave while it's still on loan, then we'd delete it out
  // from under the current reader.
  const allWithUser = myBooks.every((b) => isBookWithUser(b, user?.id));
  const canLeaveNow = myBooks.length === 0 || allWithUser;

  const sendReturnRequests = useMutation({
    mutationFn: async (books) => {
      const sent = [];
      for (const book of books) {
        try {
          const borrowing = await getActiveBorrowingByBook(book.id);
          const holderId = readerHolderIdOf(book, borrowing);
          if (!holderId || holderId === user.id) {
            sent.push(book.id);
            continue;
          }
          const code = makeCode();
          await createNotification({
            recipientId: holderId,
            title: t.returnRequestNotifTitle,
            body: t.returnRequestNotifBody(
              `${user.firstName} ${user.lastName}`,
              book.name,
              code
            ),
            read: false,
            type: "return-request",
            bookId: book.id,
            bookName: book.name,
            returnCode: code,
            requesterId: user.id,
          });
          sent.push(book.id);
        } catch (err) {
          logger.error("leave.sendReturn", err?.message, { bookId: book.id });
        }
      }
      return sent;
    },
    onSuccess: (sentIds) => {
      setRequestSent((prev) => {
        const next = new Set(prev);
        for (const id of sentIds) next.add(id);
        return next;
      });
    },
    onError: (err) => setError(err?.message || t.error),
  });

  // Leave: (1) remove every owned book from the community, (2) drop
  // membership, (3) sync local state so the profile re-renders without waiting
  // on a round-trip. We delete first so the writes still pass any
  // "must-be-a-member" security rules that might exist.
  const leaveMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(myBooks.map((b) => deleteBook(b.id).catch((err) => {
        logger.error("leave.deleteBook", err?.message, { bookId: b.id });
      })));
      await updateUser(user.id, { communityId: null });
    },
    onSuccess: () => {
      // Immediate local propagation. AuthContext's setUser + CommunityContext's
      // setCommunity both write to state that other screens read from; without
      // this, the profile would keep showing the old community until the
      // effect chain caught up (which was the bug).
      setUser({ ...user, communityId: null });
      setCommunity(null);

      queryClient.removeQueries({ queryKey: ["community", id] });
      queryClient.invalidateQueries({ queryKey: qk.books.all });
      queryClient.invalidateQueries({ queryKey: qk.profile.stats(user.id) });

      navigate("/community/join", { replace: true });
    },
    onError: (err) => setError(err?.message || t.error),
  });

  function handlePrimary() {
    setError("");
    if (canLeaveNow) {
      leaveMutation.mutate();
      return;
    }
    if (outstanding.length > 0) {
      sendReturnRequests.mutate(outstanding);
    }
  }

  const community = communityQuery.data;
  const someOutOnLoan = myBooks.some((b) => !isBookWithUser(b, user?.id));

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

      {booksQuery.isLoading ? (
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      ) : myBooks.length === 0 ? (
        <p className="px-6 py-10 text-center text-ink-500">{t.leaveNoBooks}</p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {myBooks.map((book) => {
            const withUser = isBookWithUser(book, user?.id);
            const sent = requestSent.has(book.id);
            const checked = selected.has(book.id);
            return (
              <li key={book.id} className="px-4 py-3">
                <label className="flex items-start gap-3 active:opacity-70">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(book.id)}
                    className="mt-1 w-5 h-5 accent-brand-500"
                    disabled={withUser}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[15px] truncate">{book.name}</p>
                    <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
                    <div className="mt-1">
                      {withUser ? (
                        <span className="pill bg-ok/10 text-ok text-[12px]">
                          {t.bookWithYou}
                        </span>
                      ) : sent ? (
                        <span className="pill bg-warnSoft text-warn text-[12px]">
                          {t.returnRequestSent}
                        </span>
                      ) : (
                        <span className="pill bg-ink-100 text-ink-700 text-[12px]">
                          {t.bookOutOnLoan}
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {/* Status band: still waiting for at least one book */}
      {someOutOnLoan && outstanding.length === 0 && (
        <div className="mx-4 mt-5 rounded-2xl bg-warnSoft px-4 py-3">
          <p className="font-semibold text-[14px] text-warn">{t.waitingReturnsTitle}</p>
          <p className="text-[13px] text-ink-700 mt-1 leading-relaxed">
            {t.waitingReturnsBody}
          </p>
        </div>
      )}

      {error ? (
        <div className="mx-4 mt-4 rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2">
          {error}
        </div>
      ) : null}

      {/* Primary action */}
      <div className="px-4 mt-6 mb-6">
        <button
          onClick={handlePrimary}
          disabled={
            sendReturnRequests.isPending ||
            leaveMutation.isPending ||
            (!canLeaveNow && outstanding.length === 0)
          }
          className="btn-primary"
        >
          {leaveMutation.isPending || sendReturnRequests.isPending
            ? "…"
            : canLeaveNow
              ? t.leaveNow
              : outstanding.length > 0
                ? t.sendReturnRequest
                : t.waitingReturnsTitle}
        </button>
        <p className="text-[12px] text-ink-500 mt-2 text-center">
          {canLeaveNow
            ? t.confirmLeave
            : outstanding.length > 0
              ? `${outstanding.length} · ${t.sendReturnRequest}`
              : t.waitingReturnsBody}
        </p>
      </div>
    </MobileShell>
  );
}

// One-time seed of the checked set once the book list arrives. We only tick
// the books that actually need action (out on loan and not yet held by user)
// — those with-you rows are display-only and stay unchecked.
function useSelectionInit(books, setSelected, userId) {
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (books.length === 0) return;
    initializedRef.current = true;
    setSelected(
      new Set(
        books.filter((b) => !isBookWithUser(b, userId)).map((b) => b.id)
      )
    );
  }, [books, setSelected, userId]);
}
