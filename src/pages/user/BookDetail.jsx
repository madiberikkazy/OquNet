import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import BookStatusBadge from "../../components/BookStatusBadge.jsx";
import SaveButton from "../../components/SaveButton.jsx";
import Avatar from "../../components/Avatar.jsx";
import StarRating from "../../components/StarRating.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getBook, getUserById, listRatingsForBook, updateUser,
  getPickupRequest, getPendingPickupForUser,
  getActiveBorrowingByBook, createNotification,
  releaseBookAfterReading, updateBorrowing, submitRating, getUserRatingForBook, hasUserCompletedBook,
  toMillis,
} from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { t, genreLabel } from "../../utils/i18n.js";
import { isPageBand, pagesForBook, pagesRangeLabel } from "../../utils/bookPages.js";
import { ratingSummary, reviewsFromRatings, formatRating } from "../../utils/rating.js";
import { safeImageUrl } from "../../utils/validators.js";
import { holderIdOf, readerHolderIdOf } from "../../utils/bookHolder.js";
import { isReservedForReturn } from "../../utils/bookReturn.js";
import { invalidateHolderCaches } from "../../lib/bookCaches.js";
import { logger } from "../../utils/logger.js";

export default function BookDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, refresh } = useAuth();

  const [expand, setExpand] = useState(false);
  const [error, setError] = useState(null);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [returnStars, setReturnStars] = useState(0);
  const [returnReview, setReturnReview] = useState("");

  // Inline "your rating" editor. Both start as null meaning "not touched" —
  // they fall back to whatever the user's stored rating says.
  const [draftStars, setDraftStars] = useState(null);
  const [draftReview, setDraftReview] = useState(null);
  const [ratingSavedAt, setRatingSavedAt] = useState(0);

  // Every fetch below is its own cached query. Ownership: React Query holds
  // the truth, this component just reads slices. Back navigation re-mounts
  // this page but every query is already populated from cache — no spinner.
  const bookQuery = useQuery({
    queryKey: qk.books.detail(id),
    queryFn: () => getBook(id),
    // Who holds this book is the one fact on the page that changes on somebody
    // else's phone. A handoff is two people and two devices, and only the one
    // who typed the code runs invalidateHolderCaches — so under the app-wide
    // 60s staleTime with refetchOnMount:false, every other viewer kept reading
    // the old holder off the cache. That cache is persisted to IndexedDB, so it
    // survived app restarts too, and only a window-focus refetch corrected it.
    // This screen is where the holder is read, so it re-reads it on every mount.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const book = bookQuery.data ?? null;

  const ownerQuery = useQuery({
    queryKey: qk.users.byId(book?.ownerId),
    queryFn: () => getUserById(book.ownerId),
    enabled: !!book?.ownerId,
  });

  // The review texts. Read on every mount, for the same reason the book itself
  // is: a review is written on somebody else's phone, and the only thing that
  // drops this cache is the device that wrote one. Under the app-wide 60s
  // staleTime with refetchOnMount:false — and an IndexedDB-persisted cache that
  // outlives an app restart — a reader could open this page for a day and never
  // see a review anybody else had left.
  const ratingsQuery = useQuery({
    queryKey: qk.ratings.forBook(id),
    queryFn: () => listRatingsForBook(id),
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Rating is earned, not offered: you may only score a book you have borrowed
  // and returned.
  const canRateQuery = useQuery({
    queryKey: qk.borrowings.userCompletedBook(id, user?.id),
    queryFn: () => hasUserCompletedBook(id, user.id),
    enabled: !!user?.id,
  });
  const myRatingQuery = useQuery({
    queryKey: qk.ratings.byUser(id, user?.id),
    queryFn: () => getUserRatingForBook(id, user.id),
    enabled: !!user?.id,
  });

  const activeBorrowingQuery = useQuery({
    queryKey: qk.borrowings.activeByBook(id),
    queryFn: () => getActiveBorrowingByBook(id),
    enabled: book?.status === "unavailable",
    // The loan is the other half of the same handoff — it names the countdown
    // and the return date shown beside the holder card, so a stale one would
    // put the previous reader's dates under the new reader's name.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const activeBorrowing = activeBorrowingQuery.data ?? null;
  // The book document names its own holder, so the card paints as soon as the
  // book loads — no waiting on the borrowing query.
  const holderId = holderIdOf(book);

  const holderQuery = useQuery({
    queryKey: qk.users.byId(holderId),
    queryFn: () => getUserById(holderId),
    enabled: !!holderId,
  });

  const pickupRequestQuery = useQuery({
    queryKey: qk.pickupRequest.byBookAndUser(id, user?.id),
    queryFn: () => getPickupRequest(id, user.id),
    enabled: !!user?.id,
  });

  // Whether this reader already has a pickup running somewhere else. Collecting
  // a book is a physical errand and each one blocks a book for three days, so
  // there is only ever one in flight — and the page has to know that before it
  // offers a button that would be refused.
  const pendingPickupQuery = useQuery({
    queryKey: qk.pickupRequest.pendingForUser(user?.id),
    queryFn: () => getPendingPickupForUser(user.id),
    enabled: !!user?.id,
  });

  const ratings = ratingsQuery.data ?? [];
  const myRating = myRatingQuery.data ?? null;
  const owner = ownerQuery.data ?? null;
  const currentHolder = holderQuery.data ?? null;
  const pickupRequest = pickupRequestQuery.data ?? null;
  // A pickup open on some *other* book. A request for this one is not a blocker
  // — it is the thing the "continue" button resumes.
  const blockingPickup =
    pickupRequestQuery.isSuccess && !pickupRequest && pendingPickupQuery.data?.bookId !== id
      ? pendingPickupQuery.data ?? null
      : null;

  // Countdown + auto-return: when the borrowing period has expired, roll the
  // book back to available in one shot. The mutation writes both server-side
  // (Firestore) and to the query cache — no page-level state needed.
  const { daysLeft, borrowingMaxDays } = useMemo(() => {
    if (!activeBorrowing?.returnDate) return { daysLeft: null, borrowingMaxDays: null };
    const retTs = toMillis(activeBorrowing.returnDate, null);
    if (retTs == null) return { daysLeft: null, borrowingMaxDays: null };
    const startTs = toMillis(activeBorrowing.startDate, null) ?? Date.now();
    return {
      daysLeft: Math.ceil((retTs - Date.now()) / 86400000),
      borrowingMaxDays: Math.ceil((retTs - startTs) / 86400000),
    };
  }, [activeBorrowing]);

  useEffect(() => {
    if (!activeBorrowing || daysLeft == null || daysLeft > 0) return;
    // Only the reader closes their own lapsed loan. This used to fire from
    // whoever happened to open the page, which meant a stranger's browser wrote
    // somebody else's holder — and the security rules refuse that now, so the
    // write would fail and log on every view of an overdue book. The reader
    // reaches this screen soon enough, and nothing depends on the exact moment.
    const reader = activeBorrowing.borrowerId;
    if (!user?.id || reader !== user.id) return;
    (async () => {
      try {
        // The loan lapses, but the book doesn't teleport home: the reader still
        // has it, so they stay the holder until someone collects it from them.
        const [patch] = await Promise.all([
          releaseBookAfterReading({ bookId: id, holderId: reader }),
          updateBorrowing(activeBorrowing.id, { status: "completed" }),
        ]);
        queryClient.setQueryData(qk.books.detail(id), (b) => (b ? { ...b, ...patch } : b));
        queryClient.setQueryData(qk.borrowings.activeByBook(id), null);
        invalidateHolderCaches(id);
      } catch (err) {
        logger.error("bookDetail.autoReturn", err?.message, { code: err?.code, bookId: id });
      }
    })();
  }, [activeBorrowing, daysLeft, id, queryClient, user?.id]);

  const saved = (user?.savedBookIds || []).includes(id);

  // Optimistic save. Auth state is the source of truth, but React Query gets
  // the same treatment so any query that includes saved-book ids updates too.
  const saveMutation = useMutation({
    mutationFn: async (nextIds) => updateUser(user.id, { savedBookIds: nextIds }),
    onSuccess: () => refresh(),
    onError: (err) => {
      logger.error("bookDetail.toggleSaved", err?.message, { code: err?.code, bookId: id });
    },
  });

  function toggleSaved() {
    if (!user?.id || saveMutation.isPending) return;
    const set = new Set(user.savedBookIds || []);
    if (saved) set.delete(id); else set.add(id);
    saveMutation.mutate([...set]);
  }

  /**
   * User taps "Получить книгу" — this only opens the two-step pickup flow.
   * Nothing is written here: PickupBook's first step picks the loan length and
   * shows the holder's contacts, and only its "send code" button opens the
   * request. The book is marked "unavailable" later still, once the borrower
   * enters the correct code on step two.
   */
  function requestPickup() {
    if (!user || !book) return;
    if (!pickupRequest) {
      if (isCurrentHolder || holderId === user.id) return;
      if (book.communityId && user.communityId !== book.communityId) {
        setError(t.notCommunityMember);
        return;
      }
    }
    navigate(`/books/${id}/pickup`);
  }

  function openReturnModal() {
    setReturnStars(0);
    setReturnReview("");
    setReturnModalOpen(true);
  }

  // Writing a rating: upserts this user's single rating document and refreshes
  // the book's aggregate. Shared by the inline editor and the return sheet.
  const ratingMutation = useMutation({
    mutationFn: ({ stars, reviewText }) =>
      submitRating({
        bookId: id,
        userId: user.id,
        value: stars,
        review: reviewText || "",
        authorName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
        photoURL: user.photoURL || "",
      }),
    onSuccess: ({ rating, summary }) => {
      queryClient.setQueryData(qk.ratings.byUser(id, user.id), rating);
      queryClient.setQueryData(qk.books.detail(id), (b) =>
        b ? { ...b, rating: summary.average, ratingSum: summary.sum, ratingCount: summary.count } : b
      );
      queryClient.invalidateQueries({ queryKey: qk.ratings.forBook(id) });
      // The list screens read the denormalised counters off the book document.
      queryClient.invalidateQueries({ queryKey: qk.books.all });
      setDraftStars(null);
      setDraftReview(null);
      setRatingSavedAt(Date.now());
    },
    onError: (err) => {
      logger.error("bookDetail.rate", err?.message, { code: err?.code, bookId: id });
      setError(err?.message || t.saveFailed);
    },
  });

  function saveRating() {
    if (!user?.id || ratingMutation.isPending) return;
    const stars = draftStars ?? myRating?.value ?? 0;
    if (!stars) return;
    if (!canRate) return;
    ratingMutation.mutate({ stars, reviewText: draftReview ?? myRating?.review ?? "" });
  }

  const returnMutation = useMutation({
    mutationFn: async ({ stars, reviewText }) => {
      const now = Date.now();
      // Complete the borrowing first — the rating is only legitimate once the
      // book has actually been read and returned.
      await updateBorrowing(activeBorrowing.id, {
        status: "completed",
        returnDate: now,
        rating: stars || 0,
      });
      if (stars > 0) {
        // The rating is a nice-to-have; a failure here must not strand the book
        // in "unavailable" with its borrowing already closed.
        try {
          await ratingMutation.mutateAsync({ stars, reviewText });
        } catch (err) {
          logger.error("bookDetail.returnRating", err?.message, { code: err?.code, bookId: id });
        }
      }
      // Finishing frees the book for the next reader, but it is still on this
      // user's shelf — they remain its holder until someone collects it, and
      // they do not become its owner by having read it.
      await releaseBookAfterReading({ bookId: id, holderId: user.id });
      if (book.ownerId && book.ownerId !== user.id) {
        await createNotification({
          recipientId: book.ownerId,
          title: "Кітап оқылып бітті",
          body: `${user.firstName} ${user.lastName} сіздің «${book.name}» кітабыңызды оқып бітірді. Кітап келесі оқырман алғанша сонда қалады.`,
          read: false,
          type: "book-returned",
          bookId: id,
        });
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(qk.books.detail(id), (b) =>
        b ? { ...b, status: "available", borrowerId: null, holderId: user.id } : b
      );
      queryClient.setQueryData(qk.borrowings.activeByBook(id), null);
      queryClient.invalidateQueries({ queryKey: qk.ratings.forBook(id) });
      // The return just made this user eligible to rate the book.
      queryClient.setQueryData(qk.borrowings.userCompletedBook(id, user.id), true);
      invalidateHolderCaches(id);
    },
    onError: (err) => {
      logger.error("bookDetail.return", err?.message, { code: err?.code, bookId: id });
      setError(err?.message || t.saveFailed);
    },
  });

  function handleReturn(stars, reviewText) {
    if (!activeBorrowing || returnMutation.isPending) return;
    if (!user?.id) return;
    if (activeBorrowing.borrowerId !== user.id) {
      logger.warn("bookDetail.return", "non-borrower attempted return", {
        bookId: id, borrowerId: activeBorrowing.borrowerId, userId: user.id,
      });
      setError(t.notAuthorized);
      return;
    }
    setReturnModalOpen(false);
    returnMutation.mutate({ stars, reviewText });
  }

  // Only block on the *root* fetch (book itself). Everything else is layered
  // in as it arrives — this preserves LCP and lets cached details paint
  // immediately on return.
  if (bookQuery.isLoading) {
    return (
      <MobileShell>
        <p className="px-6 py-12 text-ink-500 text-center">{t.loading}</p>
      </MobileShell>
    );
  }

  if (bookQuery.isError || !book) {
    return (
      <MobileShell>
        <div className="px-4 py-12 text-center">
          <p className="text-ink-500 mb-4">{bookQuery.error?.message || t.bookNotFound}</p>
          <button
            onClick={() => navigate(-1)}
            className="btn-primary"
          >
            {t.goBack}
          </button>
        </div>
      </MobileShell>
    );
  }

  // The score comes off the book document, through the same helper BookCard
  // calls — so the number here and the number on the card are the same number,
  // not two answers that happen to agree.
  //
  // This page used to recompute it from the rating documents, on the grounds
  // that they are the source the counters mirror. They are; but the recompute
  // read a *cached* copy of those documents, and nothing on this device
  // invalidates that cache when somebody else rates the book on theirs. The
  // counters ride along with the book, which this screen re-reads on every
  // mount, so the card showed 4,5 (2) while the page under it still said 4,0
  // (1) — the same number disagreeing with itself one tap apart.
  //
  // `recalcBookRating` rewrites the counters after every rating write, so the
  // two cannot drift for longer than the next person to rate.
  const { count: ratingCount, average: ratingAvg } = ratingSummary(book);
  const reviews = reviewsFromRatings(ratings);

  const isOwner     = book.ownerId === user?.id;
  const isCurrentHolder =
    !!user?.id && readerHolderIdOf(book) === user.id;
  // Has the book but isn't reading it: they finished (or the loan lapsed) and
  // the next reader hasn't collected it yet.
  const isBookHolder = !isOwner && !isCurrentHolder && !!user?.id && holderId === user.id;
  const isCommunityMember =
    !!book.communityId && !!user?.communityId && book.communityId === user.communityId;

  // Only a reader who has returned this book may rate it — which is now every
  // member, an admin included: there is no read-only mode to browse in any more.
  const canRate = !!user?.id && canRateQuery.data === true;
  const pendingStars = draftStars ?? myRating?.value ?? 0;
  const pendingReview = draftReview ?? myRating?.review ?? "";
  const ratingDirty =
    pendingStars > 0 &&
    (pendingStars !== (myRating?.value ?? 0) || pendingReview.trim() !== (myRating?.review ?? "").trim());

  // Is there a real length to print? `pagesForBook` always answers — it falls
  // back to the smallest band so the loan arithmetic never divides by nothing —
  // and printing that answer for a book that carries neither a band nor a loan
  // length would be inventing "0–50 бет" out of a missing field. These are the
  // same two sources it reads, asked before it guesses.
  const hasPageCount = isPageBand(book.pages) || Number(book.maxDays) > 0;

  /**
   * The action for this book, whoever is looking at it.
   *
   * It lives in a bar pinned to the bottom of the screen rather than at the end
   * of the page. This screen is long — cover, description, ratings, the book's
   * journey — and the one thing a reader came to do was sitting below all of it,
   * reachable only by scrolling past everything first. A detail page's action
   * belongs where it can always be reached.
   *
   * Every state of it is here, not just the button: "your book", "you are
   * holding it", "finish the pickup you already started". They are all answers
   * to the same question — what can I do with this book — so they are drawn in
   * the same place, and the bar never appears empty or moves what is under it.
   */
  const actionBar = (
    isCurrentHolder ? (
      /* Current borrower — can return, cannot get again */
      <div className="space-y-2">
        <button
          onClick={openReturnModal}
          disabled={returnMutation.isPending}
          className="w-full py-3.5 rounded-2xl bg-ok text-white font-semibold text-[15px] active:scale-[0.99] transition disabled:opacity-60"
        >
          {returnMutation.isPending ? "…" : t.returnBook}
        </button>
        <p className="text-[12px] text-ink-500 text-center">
          {t.youHoldBook}
        </p>
      </div>
    ) : isOwner ? (
      <p className="text-center text-[13px] text-ink-500 py-3 bg-ink-100 rounded-xl">
        {t.yourBook}
      </p>
    ) : isBookHolder ? (
      /* Finished reading but nobody has collected it yet — the book is
         still on this user's shelf, so there is nothing to request. */
      <p className="text-center text-[13px] text-ink-500 py-3 bg-ink-100 rounded-xl">
        {t.bookOnYourShelf}
      </p>
    ) : !isCommunityMember ? (
      <p className="text-center text-[13px] text-ink-500 py-3 bg-ink-100 rounded-xl">
        {t.notCommunityMember}
      </p>
    ) : pickupRequest ? (
      /* Already requested — show a resume button, no new code is generated */
      <div className="space-y-2">
        <button
          onClick={() => navigate(`/books/${id}/pickup`)}
          className="btn-primary"
        >
          {t.continueGetBook}
        </button>
        <p className="text-[12px] text-ink-500 text-center">
          {t.codeAlreadySent}
        </p>
      </div>
    ) : blockingPickup ? (
      /* Mid-pickup on another book. Offering the request button here would
         only produce an error two screens later, so it offers the way out
         instead: finish or cancel the one already running. */
      <div className="space-y-2">
        <p className="text-center text-[13px] text-ink-500 py-3 bg-ink-100 rounded-xl">
          {t.pickupOtherPending}
        </p>
        <button
          onClick={() => navigate(`/books/${blockingPickup.bookId}/pickup`)}
          className="btn-secondary"
        >
          {t.pickupOpenBlockingBook}
        </button>
      </div>
    ) : (
      <button onClick={requestPickup} className="btn-primary">
        {book.status === "unavailable" ? t.getBook : t.borrowBook}
      </button>
    )
  );

  /**
   * The rating sheet, shown when the holder gives the book back.
   *
   * It goes through MobileShell's overlay slot rather than being dropped in
   * among the sections above. A `fixed` element rendered there is pinned to the
   * page content — which is a transformed element — so this sheet used to open
   * at the bottom of the *page* rather than the bottom of the screen, which on
   * a long book page means somewhere nobody can see.
   */
  const returnSheet = returnModalOpen && (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => setReturnModalOpen(false)}
      />
      <div className="relative bg-surface rounded-t-3xl px-6 pt-5 pb-10 space-y-5">
        <div className="w-10 h-1 rounded-full bg-ink-200 mx-auto" />
        <div className="text-center">
          <h2 className="text-[18px] font-bold">{t.rateBook}</h2>
          <p className="text-[13px] text-ink-500 mt-1">«{book.name}»</p>
        </div>
        <div className="flex justify-center">
          <StarRating value={returnStars} onChange={setReturnStars} size={40} label={t.rateBook} />
        </div>
        <textarea
          value={returnReview}
          onChange={(e) => setReturnReview(e.target.value)}
          placeholder={t.ratingPlaceholder}
          rows={3}
          className="input resize-none text-[14px]"
        />
        <div className="space-y-2">
          <button
            onClick={() => handleReturn(returnStars, returnReview)}
            disabled={returnMutation.isPending}
            className="btn-primary"
          >
            {returnMutation.isPending ? "…" : returnStars > 0 ? t.returnWithRating : t.returnBook}
          </button>
          <button
            onClick={() => handleReturn(0, "")}
            disabled={returnMutation.isPending}
            className="w-full py-3 text-[14px] text-ink-500 font-medium"
          >
            {t.returnWithoutRating}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <MobileShell bottomBar={actionBar} overlay={returnSheet}>
      <SearchBar value="" onChange={() => {}} onBack={() => navigate(-1)} placeholder={t.searchPlaceholder} />

      <div className="px-4 pt-4 flex gap-3">
        <img
          src={safeImageUrl(book.coverUrl) || undefined}
          alt={book.name || ""}
          onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
          className="w-[110px] h-[145px] rounded-lg object-cover bg-ink-100"
        />
        <div className="flex-1 flex flex-col">
          <h1 className="text-2xl font-bold leading-tight">{book.name}</h1>
          <p className="text-[15px] text-ink-500 mt-1">{book.author}</p>

          {/* Year and length — the two facts about the book itself, as opposed
              to the badges below, which are about this copy today.
              The length is the band the admin chose, not an exact count, and it
              is worth showing for a second reason: the loan is derived from it
              (one day per fifty pages), so it is also how long you get. */}
          {(book.year || hasPageCount) ? (
            <p className="text-[13px] text-ink-500 mt-1 flex items-center gap-1.5">
              {book.year ? <span className="tabular-nums">{book.year}</span> : null}
              {book.year && hasPageCount ? <span aria-hidden="true">·</span> : null}
              {hasPageCount ? (
                <span className="tabular-nums">
                  {pagesRangeLabel(pagesForBook(book))} {t.pagesUnit}
                </span>
              ) : null}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <BookStatusBadge
              status={book.status}
              daysLeft={daysLeft}
              reserved={isReservedForReturn(book)}
            />
            {book.genre ? (
              <span className="pill bg-ink-100 text-ink-700 text-[12px]">
                {genreLabel(book.genre)}
              </span>
            ) : null}
            {(book.genres || []).filter((g) => g !== book.genre).map((g) => (
              <span key={g} className="pill bg-ink-100 text-ink-700 text-[12px]">
                {genreLabel(g)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 mt-5">
        <button
          onClick={toggleSaved}
          className="w-full bg-ink-100 hover:bg-ink-100/80 rounded-xl py-3.5 font-medium flex items-center justify-center gap-2"
        >
          {t.saveBtn}
          <SaveButton saved={saved} onClick={(e) => e.preventDefault()} />
        </button>
      </div>

      <section className="px-4 mt-5">
        <h3 className="section-title">{t.bookDescription}</h3>
        <p className={"text-[14px] text-ink-700 mt-2 whitespace-pre-wrap " + (expand ? "" : "line-clamp-3")}>
          {book.description || "—"}
        </p>
        {book.description && book.description.length > 100 ? (
          <button onClick={() => setExpand((x) => !x)} className="text-brand-500 text-[13px] mt-1">
            {expand ? t.hide : t.showMore}
          </button>
        ) : null}
      </section>

      {/* Days left countdown */}
      {book.status === "unavailable" && daysLeft != null && (
        <section className="px-4 mt-5">
          <div className={"rounded-2xl px-4 py-4 flex items-center gap-4 " +
            (daysLeft <= 3 ? "bg-badSoft" : daysLeft <= 7 ? "bg-warnSoft" : "bg-brand-50")}>
            <div className={"w-14 h-14 rounded-xl flex items-center justify-center text-[22px] font-bold " +
              (daysLeft <= 3 ? "bg-bad text-white" : daysLeft <= 7 ? "bg-warn text-white" : "bg-brand-500 text-white")}>
              {daysLeft}
            </div>
            <div>
              <p className="font-semibold text-[15px]">
                {daysLeft} {t.daysLeft}
              </p>
              <p className="text-[13px] text-ink-500">
                {borrowingMaxDays ? `${borrowingMaxDays} / ` : ""}{t.daysLeftSubtitle}
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="px-4 mt-5">
        <h3 className="section-title">{t.rating}</h3>
        <div className="mt-2 flex items-center gap-3">
          <span className="text-[32px] font-bold leading-none">{formatRating(ratingAvg)}</span>
          <div>
            <StarRating value={ratingAvg} size={18} />
            <p className="text-[12px] text-ink-500 mt-0.5">
              {ratingCount > 0 ? `${ratingCount} ${t.ratingCount}` : `${t.noRatingsYet} · ${t.defaultRatingNote}`}
            </p>
          </div>
        </div>

        {/* Your rating — the write side of the same number above. */}
        <div className="card mt-3 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-ink-700">{t.yourRating}</p>
            <StarRating
              value={pendingStars}
              size={26}
              label={t.yourRating}
              onChange={canRate ? (v) => setDraftStars(v) : undefined}
            />
          </div>

          {canRate ? (
            <>
              <textarea
                value={pendingReview}
                onChange={(e) => setDraftReview(e.target.value)}
                placeholder={t.reviewOptional}
                rows={2}
                className="input resize-none text-[14px] mt-3"
              />
              <button
                onClick={saveRating}
                disabled={!ratingDirty || ratingMutation.isPending}
                className="btn-primary mt-2 disabled:opacity-50"
              >
                {ratingMutation.isPending ? "…" : myRating ? t.updateRating : t.sendRating}
              </button>
              {ratingSavedAt && !ratingDirty ? (
                <p className="text-[12px] text-ok text-center mt-2">{t.ratingSaved}</p>
              ) : null}
            </>
          ) : (
            <p className="text-[12px] text-ink-500 mt-2">
              {isCurrentHolder ? t.rateAfterReturn : t.rateOnlyReaders}
            </p>
          )}
        </div>
      </section>

      <section className="px-4 mt-5">
        <h3 className="section-title mb-2">{t.reviews}</h3>
        {reviews.length === 0 ? (
          <p className="text-[13px] text-ink-500">{t.noReviews}</p>
        ) : (
          <ul className="space-y-2">
            {reviews.map((r) => (
              <li key={r.id} className="bg-ink-100/60 rounded-xl p-3 flex gap-2">
                <Avatar src={r.photoURL} name={r.authorName} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-medium text-ink-700 truncate">
                      {r.authorName || "—"}
                      {r.userId === user?.id ? <span className="text-[12px] text-ink-500 ml-1">{t.youMark}</span> : null}
                    </p>
                    <StarRating value={r.value} size={12} />
                  </div>
                  <p className="text-[13px] text-ink-700 mt-1 whitespace-pre-wrap break-words">{r.review}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Owner — who added the book, never changes. Shown to all users. */}
      {owner && (
        <section className="px-4 mt-5">
          <h3 className="section-title mb-2">{t.ownerLabel}</h3>
          <Link to={`/users/${owner.id}`} className="card flex items-center gap-3 px-3 py-3">
            <Avatar src={owner.photoURL} name={`${owner.firstName} ${owner.lastName}`} />
            <div className="flex-1">
              <p className="font-medium">
                {owner.firstName} {owner.lastName}
                {owner.id === user?.id ? <span className="text-[12px] text-ink-500 ml-1">{t.youMark}</span> : null}
              </p>
              <p className="text-[13px] text-ink-500">@{owner.nickname}</p>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </Link>
        </section>
      )}

      {/* Holder — who physically has the book right now. Shown to all users,
          always, and always alongside the owner above: when the two are the
          same person both cards name them, which is the point — the book is
          with its owner *at the moment*, not permanently. */}
      {(() => {
        const holder = currentHolder;
        if (!holder) return null;
        return (
          <section className="px-4 mt-5">
            <h3 className="section-title mb-2">{t.holderLabel}</h3>
            <Link to={`/users/${holder.id}`} className="card flex items-center gap-3 px-3 py-3">
              <Avatar src={holder.photoURL} name={`${holder.firstName} ${holder.lastName}`} />
              <div className="flex-1">
                <p className="font-medium">
                  {holder.firstName} {holder.lastName}
                  {holder.id === user?.id ? <span className="text-[12px] text-ink-500 ml-1">{t.youMark}</span> : null}
                </p>
                <p className="text-[13px] text-ink-500">@{holder.nickname}</p>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </Link>
          </section>
        );
      })()}

      {/* Where the book has been. Sits under the two cards that say where it is
          *now* — owner and holder — because that is the question it extends: a
          shared book has a past, and the loans have always recorded it. Shown
          to everyone who can see the book; it adds the history, not a new
          audience. */}
      <section className="px-4 mt-5">
        <Link
          to={`/books/${book.id}/journey`}
          className="card flex items-center gap-3 px-4 py-3.5 active:opacity-70 transition"
        >
          <span className="w-9 h-9 rounded-full bg-tint flex items-center justify-center shrink-0">
            {/* A route with two stops — the shape of the screen it opens. */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-tintInk" aria-hidden="true">
              <circle cx="6" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="18" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M8.4 7.6c3 .5 4 2 4.2 3.6.2 1.7 1 3.4 3.2 4.5"
                stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeDasharray="2.5 2.5"
              />
            </svg>
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-medium text-[15px]">{t.bookJourney}</span>
            <span className="block text-[12px] text-ink-500">{t.bookJourneyHint}</span>
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </Link>
      </section>

      {/* Return date — visible to all users when the book is borrowed */}
      {book.status === "unavailable" && activeBorrowing?.returnDate && (
        <section className="px-4 mt-5">
          <h3 className="section-title mb-2">{t.returnDate}</h3>
          <div className="card px-4 py-3 flex items-center justify-between">
            <span className="text-[14px] text-ink-700">{t.returnDateNote}</span>
            <span className="font-semibold text-[14px]">
              {new Date(toMillis(activeBorrowing.returnDate))
                .toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })}
            </span>
          </div>
        </section>
      )}

      {error && book ? (
        <div className="px-4 mt-4">
          <div className="rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2 flex items-start justify-between gap-2">
            <span className="flex-1 break-words">{error}</span>
            <button onClick={() => setError(null)} className="text-bad/70 text-[16px] leading-none px-1">×</button>
          </div>
        </div>
      ) : null}
    </MobileShell>
  );
}
