import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import {
  getUserById, listBooksHeldBy, listUsersByCommunity, reassignHeldBook, updateUser,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { safeImageUrl } from "../../utils/validators.js";
import { t } from "../../utils/i18n.js";

/**
 * Ejecting a member — a screen, because it is a decision with a settlement
 * attached rather than a yes/no.
 *
 * It was a confirmation dialog, and a dialog cannot ask the question that
 * actually matters: this person may be holding books, and removing them without
 * asking leaves every one of those books recorded as being in the hands of
 * somebody who is no longer in the community — invisible on the shelf and
 * reachable by nobody. So the books come first, one row each, and the admin
 * says where each is going. The removal is the last thing that happens, and it
 * only happens once every book has somewhere to be.
 *
 * No tab bar: this is a task with a beginning and an end, not a place.
 */
export default function RemoveMember() {
  const { id: communityId, userId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // bookId -> the member who will take it. Empty until the admin chooses; a
  // book with nobody named is what keeps the remove button disabled.
  const [holders, setHolders] = useState({});
  const [error, setError] = useState("");

  const memberQuery = useQuery({
    queryKey: qk.users.byId(userId),
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: () => getUserById(userId),
  });

  // Read fresh every time this screen opens, never from cache: it is the list
  // the whole decision is made from, and a book collected an hour ago must not
  // be missing from it.
  const booksQuery = useQuery({
    queryKey: qk.books.heldBy(userId, communityId),
    enabled: !!userId && !!communityId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => listBooksHeldBy({ communityId, userId }),
  });

  const membersQuery = useQuery({
    queryKey: qk.communities.members(communityId),
    enabled: !!communityId,
    staleTime: 60_000,
    queryFn: () => listUsersByCommunity(communityId),
  });

  const member = memberQuery.data ?? null;
  const books = booksQuery.data ?? [];

  // Anybody but the person being removed. The admin themselves is on this list
  // on purpose: taking the books yourself is the obvious answer when nobody
  // else is an obvious one.
  const candidates = useMemo(
    () => (membersQuery.data ?? []).filter((m) => m.id !== userId),
    [membersQuery.data, userId]
  );

  const removal = useMutation({
    mutationFn: async () => {
      // Books first, membership last. The rules let a *member's* admin write
      // these books; nothing about that depends on the person being removed
      // still being a member, but the order keeps the failure honest — a
      // half-done handover leaves them in the community, where the admin can
      // simply open this screen again.
      for (const book of books) {
        const toUserId = holders[book.id];
        if (!toUserId) throw new Error(t.chooseHolderForAll);
        await reassignHeldBook({
          bookId: book.id,
          toUserId,
          // A copy this person owned goes with the book. Left behind, it would
          // belong to somebody outside the community — the same orphan the
          // holder field would have been.
          transferOwnership: book.ownerId === userId,
        });
      }
      await updateUser(userId, { communityId: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.books.all });
      queryClient.invalidateQueries({ queryKey: qk.communities.members(communityId) });
      queryClient.invalidateQueries({ queryKey: qk.users.byId(userId) });
      navigate(`/community/${communityId}`, { replace: true });
    },
    onError: (err) => {
      logger.error("removeMember", err?.message, { userId, code: err?.code });
      setError(err?.code ? writeError(err) : err?.message || t.error);
    },
  });

  const loading = memberQuery.isLoading || booksQuery.isLoading || membersQuery.isLoading;
  const allAssigned = books.every((b) => holders[b.id]);
  const nobodyToPassTo = books.length > 0 && candidates.length === 0;

  if (loading) {
    return (
      <MobileShell withNav={false}>
        <Header onBack={() => navigate(-1)} />
        <p className="px-6 py-12 text-center text-ink-500">{t.loading}</p>
      </MobileShell>
    );
  }

  if (!member) {
    return (
      <MobileShell withNav={false}>
        <Header onBack={() => navigate(-1)} />
        <EmptyState title={t.userNotFound} subtitle={t.userNotFoundHint} />
      </MobileShell>
    );
  }

  return (
    <MobileShell
      withNav={false}
      bottomBar={
        <div className="space-y-2">
          {error ? <p className="text-bad text-[13px] text-center">{error}</p> : null}
          <button
            onClick={() => { setError(""); removal.mutate(); }}
            disabled={removal.isPending || !allAssigned || nobodyToPassTo}
            className="w-full py-3.5 rounded-2xl bg-badSoft text-bad font-semibold text-[15px] active:scale-[0.99] transition disabled:opacity-60"
          >
            {removal.isPending ? "…" : t.removeMemberAction}
          </button>
          {/* Says why the button is off rather than leaving it greyed and
              unexplained — the reason is a decision the admin has not made yet. */}
          {!allAssigned && !nobodyToPassTo ? (
            <p className="text-[12px] text-ink-500 text-center">{t.chooseHolderForAll}</p>
          ) : null}
          {nobodyToPassTo ? (
            <p className="text-[12px] text-ink-500 text-center">{t.noOtherMembers}</p>
          ) : null}
        </div>
      }
    >
      <Header onBack={() => !removal.isPending && navigate(-1)} />

      <div className="px-4">
        <div className="card px-4 py-3 flex items-center gap-3">
          <Avatar src={member.photoURL} name={peerName(member)} size={44} />
          <div className="min-w-0">
            <p className="font-semibold text-[15px] truncate">{peerName(member)}</p>
            {member.nickname ? (
              <p className="text-[13px] text-ink-500 truncate">@{member.nickname}</p>
            ) : null}
          </div>
        </div>
        <p className="text-[13px] text-ink-500 mt-3 leading-relaxed">{t.removeMemberWarning}</p>
      </div>

      {books.length === 0 ? (
        <div className="px-4 mt-5">
          <div className="card px-4 py-5 text-center">
            <p className="font-semibold text-[15px]">{t.memberHasNoBooks}</p>
            <p className="text-[13px] text-ink-500 mt-1">{t.memberHasNoBooksHint}</p>
          </div>
        </div>
      ) : (
        <section className="mt-5">
          <h3 className="section-title px-4">{t.memberHeldTitle}</h3>
          <p className="px-4 text-[13px] text-ink-500 mt-1 leading-relaxed">{t.removeMemberBooksHint}</p>

          <ul className="px-4 mt-3 space-y-3">
            {books.map((book) => (
              <li key={book.id} className="card p-4">
                <div className="flex items-start gap-3">
                  {safeImageUrl(book.coverUrl) ? (
                    <img
                      src={safeImageUrl(book.coverUrl)}
                      alt=""
                      className="w-10 h-14 rounded-lg object-cover bg-ink-100 shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-14 rounded-lg bg-ink-100 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[15px] truncate">{book.name}</p>
                    <p className="text-[13px] text-ink-500 truncate">{book.author}</p>
                  </div>
                </div>

                <label className="block mt-3">
                  <span className="text-[12px] text-ink-500">{t.newHolder}</span>
                  <select
                    value={holders[book.id] ?? ""}
                    onChange={(e) => setHolders((prev) => ({ ...prev, [book.id]: e.target.value }))}
                    className="input mt-1"
                  >
                    <option value="">{t.chooseHolder}</option>
                    {candidates.map((m) => (
                      <option key={m.id} value={m.id}>{peerName(m)}</option>
                    ))}
                  </select>
                </label>

                {book.ownerId === userId ? (
                  <p className="text-[12px] text-ink-500 mt-1.5">{t.ownershipMovesToo}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </MobileShell>
  );
}

function Header({ onBack }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <button onClick={onBack} aria-label={t.back} className="icon-btn shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <h1 className="text-[18px] font-bold flex-1 truncate">{t.removeMemberTitle}</h1>
    </div>
  );
}
