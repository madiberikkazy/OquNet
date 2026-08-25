import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import BookStatusBadge from "../../components/BookStatusBadge.jsx";
import Modal from "../../components/Modal.jsx";
import Fab from "../../components/Fab.jsx";
import BookFields from "../../components/BookFields.jsx";
import Leaderboard from "../../components/Leaderboard.jsx";
import CoverPicker from "../../components/CoverPicker.jsx";
import PostCard from "../../components/PostCard.jsx";
import KebabMenu from "../../components/KebabMenu.jsx";
import { uploadImage } from "../../firebase/storage.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getCommunity, listUsersByCommunity, listPostsByCommunity, listBooks,
  createJoinRequest, createNotification, getActiveBorrowingForUser,
  createPost, updatePost, deletePost, deleteBook, togglePostLike,
} from "../../firebase/firestore.js";
import { hasVerifiedPhone } from "../../firebase/phoneVerify.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";
import { writeError } from "../../utils/writeError.js";
import { clampText, isAddress, LIMITS } from "../../utils/validators.js";

const TABS = ["posts", "books", "members"];

export default function CommunityProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, setUser, isAdmin, updateProfile } = useAuth();

  const [community, setCommunity]   = useState(null);
  const [members, setMembers]       = useState([]);
  const [posts, setPosts]           = useState([]);
  const [books, setBooks]           = useState([]);
  const [tab, setTab]               = useState("posts");
  const [headerLoading, setHeaderLoading] = useState(true); // only blocks the header
  const [contentLoading, setContentLoading] = useState(true);

  // Join modal. The book is the price of admission, so the form asks for all of
  // it — the same fields the admin fills in on Add Book, because this is the
  // document they will be approving.
  const [joinOpen, setJoinOpen]     = useState(false);
  const [bookForm, setBookForm]     = useState({
    name: "", author: "", year: "", pages: "", language: "", genres: [], description: "", coverUrl: "",
  });
  const [coverFile, setCoverFile]   = useState(null);
  // Contacts are collected here rather than on the book screens: joining is the
  // moment a user becomes reachable, and every handoff afterwards needs them.
  const [contactForm, setContactForm] = useState({ address: "" });
  const [joinError, setJoinError]   = useState("");
  const [joining, setJoining]       = useState(false);
  const [joinDone, setJoinDone]     = useState(false);

  // ── Management state — only ever reachable for the community's own admin ──
  // Everything below drives the controls that appear on top of the page the
  // members already see; none of it renders when `canManage` is false.
  const [postOpen, setPostOpen]         = useState(false);  // compose
  const [postBody, setPostBody]         = useState("");
  const [postBusy, setPostBusy]         = useState(false);
  const [editingPost, setEditingPost]   = useState(null);
  const [editBody, setEditBody]         = useState("");
  const [removing, setRemoving]         = useState(null);   // { kind, item }
  const [removeBusy, setRemoveBusy]     = useState(false);
  const [manageError, setManageError]   = useState("");

  useEffect(() => {
    setHeaderLoading(true);
    setContentLoading(true);

    // Step 1 — load community doc first so the page opens instantly
    getCommunity(id).then((c) => {
      setCommunity(c);
      setHeaderLoading(false);

      // Step 2 — load the rest in the background; errors are swallowed gracefully.
      //
      // The shelf belongs to the community and is readable only from inside it,
      // so a visitor gets the header, the member list and the noticeboard and
      // nothing else. Skipping a query rather than letting it be refused keeps a
      // perfectly ordinary page view out of the error log.
      //
      // The noticeboard is *not* members-only, and withholding it here was the
      // page contradicting both the security rule and the Home feed: a public
      // community's posts are readable by anyone signed in, and they are already
      // shown to strangers in discovery. A visitor who followed one of those
      // posts here used to arrive at "Жазба жоқ".
      //
      // The query still asks by `communityId`, so it is refused wholesale if any
      // one post of a public community is missing its `isPublic` flag — posts
      // written before the flag existed. That is what
      // `scripts/backfill-post-visibility.mjs` is for; until it has run, a
      // visitor loses the tab rather than the page.
      const isMember = user?.communityId === id;
      const canReadPosts = isMember || c?.isPrivate !== true;
      Promise.allSettled([
        listUsersByCommunity(id),
        isMember ? listBooks({ communityId: id }) : Promise.resolve({ items: [] }),
        canReadPosts ? listPostsByCommunity(id) : Promise.resolve([]),
      ]).then(([m, b, p]) => {
        if (m.status === "fulfilled") setMembers(m.value);
        if (b.status === "fulfilled") setBooks(b.value.items);
        if (p.status === "fulfilled") setPosts(p.value);
        setContentLoading(false);
      });
    }).catch(() => setHeaderLoading(false));
  }, [id, user?.communityId]);

  // Seed the address from whatever the profile already knows, so a user who
  // filled it in at registration just confirms it. The phone is not seeded —
  // it is not a field here any more, only a verified fact about the account.
  useEffect(() => {
    setContactForm({ address: user?.address || "" });
  }, [user?.address]);

  const isMember  = user?.communityId === id;
  const isOwner   = community?.ownerId === user?.id;
  const isPrivate = community?.isPrivate;
  // Non-members can't see content of private communities
  const canSeeContent = !isPrivate || isMember || isOwner;

  /**
   * Whether this visitor may manage what they are looking at.
   *
   * Deliberately the same three conditions the security rules check — an admin
   * of *this* community, which means the role, the membership and the ownership
   * all pointing at the same place. A button the server was always going to
   * refuse is worse than no button.
   */
  const canManage = isAdmin && isOwner && isMember;

  /**
   * The noticeboard, as this page shows it: the admin's notices and nobody
   * else's.
   *
   * The compose button here has always been `canManage`-only — this board was
   * never meant to be a group chat. What it could not stop was a member writing
   * a post from the Home feed, which lands in the same collection with the same
   * `communityId` and turned up here beside the announcements, indistinguishable
   * from them. Filtering on the owner is the same rule the "+" already applies,
   * finally applied to what is drawn as well as to what can be written.
   *
   * `authorId` is required by the post schema, so there is no era of unattributed
   * posts to make an exception for. Members' posts are not lost — they are still
   * on the feed, where they were written.
   */
  const adminPosts = useMemo(
    () => (community?.ownerId ? posts.filter((p) => p.authorId === community.ownerId) : []),
    [posts, community?.ownerId],
  );

  // ── Likes ───────────────────────────────────────────────────────────────────
  // The same contract PostDetail uses: `user.likedPostIds` is the truth, the
  // write hands back the array it stored, and what is held locally is only that
  // fact drawn a frame early. One write per post at a time, so a double tap
  // cannot ask the server to like and unlike the same post at once.
  const [likedIds, setLikedIds] = useState(() => new Set(user?.likedPostIds || []));
  useEffect(() => { setLikedIds(new Set(user?.likedPostIds || [])); }, [user?.likedPostIds]);
  const likeWriting = useRef(new Set());

  async function onLike(post) {
    if (!user?.id || !post?.id || likeWriting.current.has(post.id)) return;
    const current  = user.likedPostIds || [];
    const wasLiked = current.includes(post.id);

    likeWriting.current.add(post.id);
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(post.id); else next.add(post.id);
      return next;
    });
    setPosts((list) => list.map((p) => (p.id === post.id
      ? { ...p, likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? -1 : 1)) }
      : p)));

    try {
      const { likedPostIds } = await togglePostLike({
        postId: post.id, userId: user.id, likedPostIds: current, liked: !wasLiked,
      });
      setUser((prev) => (prev && prev.id === user.id ? { ...prev, likedPostIds } : prev));
    } catch (err) {
      logger.error("community.like", err?.message, { postId: post.id, code: err?.code });
      setLikedIds(new Set(current));
      setPosts((list) => list.map((p) => (p.id === post.id
        ? { ...p, likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? 1 : -1)) }
        : p)));
    } finally {
      likeWriting.current.delete(post.id);
    }
  }

  async function handleJoin(e) {
    e.preventDefault();
    setJoinError("");
    // The book is checked by the same validator Add Book uses — it runs inside
    // createJoinRequest — so these three are only here to name the field that
    // is wrong before a round trip does it less kindly.
    if (!bookForm.name.trim() || !bookForm.author.trim()) { setJoinError(t.addBookErrName); return; }
    if ((bookForm.genres || []).length < 1) { setJoinError(t.addBookErrGenre); return; }
    if (!bookForm.pages) { setJoinError(t.addBookErrPages); return; }

    // Contacts gate — a member nobody can reach cannot hand a book over.
    //
    // The phone half of it is not a field any more: it is a number somebody
    // proved, once, by messaging our bot from it — asked for on its own screen.
    // Checked here as well as at the button that opens that screen, because the
    // modal can have been sitting open since before the profile was reloaded.
    const address = clampText(contactForm.address, LIMITS.ADDRESS_MAX);
    if (!hasVerifiedPhone(user)) { setJoinError(t.phoneVerifyToJoin); return; }
    if (!isAddress(address)) { setJoinError(t.addressRequiredError); return; }

    const active = await getActiveBorrowingForUser(user.id);
    if (active) { setJoinError(t.returnBookFirst); return; }
    setJoining(true);
    try {
      // Save first: the admin approving this request is agreeing to a member
      // other people can actually reach. Only the address — the number is the
      // verification webhook's to write, and the rules refuse it from here.
      if (address !== (user.address || "")) {
        await updateProfile({ address });
      }

      // Uploaded here rather than at pick time, for the same reason Add Book
      // waits: an abandoned application leaves nothing behind.
      let coverUrl = bookForm.coverUrl;
      if (coverFile) {
        coverUrl = await uploadImage(coverFile, `join/${id}_${user.id}_${Date.now()}`);
      }

      const req = await createJoinRequest({
        userId: user.id,
        userNickname: user.nickname,
        userName: `${user.firstName} ${user.lastName}`.trim(),
        communityId: id,
        book: { ...bookForm, coverUrl },
      });

      // Notify the admin about the request
      await createNotification({
        recipientId: community.ownerId,
        title: t.joinRequestNotifTitle,
        body: t.joinRequestNotifBody(user.nickname, bookForm.name),
        read: false,
        type: "join-request",
        communityId: id,
        requestId: req.id,
      });

      // Notify the USER themselves — so they can track and cancel the request
      await createNotification({
        recipientId: user.id,
        title: t.requestSentNotifTitle,
        body: t.joinRequestSentNotifBody(community.name),
        read: false,
        type: "join-request-sent",
        communityId: id,
        communityName: community.name,
        requestId: req.id,
        requestStatus: "pending",
      });

      setJoinDone(true);
    } catch (err) {
      logger.error("community.join", err?.message, { code: err?.code, communityId: id });
      setJoinError(writeError(err));
    } finally {
      setJoining(false);
    }
  }

  // ── Posts ───────────────────────────────────────────────────────────────────

  async function submitPost(e) {
    e.preventDefault();
    if (postBusy || !postBody.trim()) return;
    setPostBusy(true);
    setManageError("");
    try {
      // No `createdAt`: the data layer stamps it server-side, which is why the
      // post prepended below carries no date until the next load.
      const p = await createPost({
        communityId: id,
        authorId: user.id,
        authorName: `${user.firstName} ${user.lastName}`,
        // Denormalised from the community so the Home discovery feed can query
        // posts directly — a private community's notices stay off that feed.
        isPublic: !community.isPrivate,
        body: postBody.trim(),
      });
      setPosts((list) => [p, ...list]);
      setPostBody("");
      setPostOpen(false);
    } catch (err) {
      logger.error("community.createPost", err?.message, { code: err?.code });
      setManageError(writeError(err));
    } finally {
      setPostBusy(false);
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    if (postBusy || !editingPost) return;
    if (!editBody.trim()) { setManageError(t.fillAllFields); return; }
    setPostBusy(true);
    setManageError("");
    try {
      const patch = { body: editBody.trim() };
      await updatePost(editingPost.id, patch);
      setPosts((list) => list.map((p) => (p.id === editingPost.id ? { ...p, ...patch } : p)));
      setEditingPost(null);
    } catch (err) {
      logger.error("community.updatePost", err?.message, { postId: editingPost.id, code: err?.code });
      setManageError(writeError(err));
    } finally {
      setPostBusy(false);
    }
  }

  // ── Removal — one dialog for all three kinds of row ──────────────────────────
  //
  // A post and a book are removed by two different calls, but they are the same
  // decision to the person making it: this row, gone, are you sure. Keeping one
  // dialog is what stops the two from drifting apart.
  //
  // Removing a *member* used to be the third kind here and is a screen of its
  // own now — /community/:id/members/:userId/remove. It stopped fitting: a
  // member can be holding books, and "are you sure" is the wrong question to
  // ask about them. See RemoveMember.jsx.
  function askRemove(kind, item) {
    setManageError("");
    setRemoving({ kind, item });
  }

  async function confirmRemove() {
    if (removeBusy || !removing) return;
    const { kind, item } = removing;
    setRemoveBusy(true);
    setManageError("");
    try {
      if (kind === "post") {
        await deletePost(item.id);
        setPosts((list) => list.filter((p) => p.id !== item.id));
      } else {
        await deleteBook(item.id);
        setBooks((list) => list.filter((b) => b.id !== item.id));
      }
      setRemoving(null);
    } catch (err) {
      logger.error(`community.remove.${kind}`, err?.message, { targetId: item.id, code: err?.code });
      setManageError(writeError(err));
    } finally {
      setRemoveBusy(false);
    }
  }

  if (headerLoading) {
    return (
      <MobileShell>
        <div className="flex items-center gap-3 px-4 mb-4">
          <button onClick={() => navigate(-1)} className="icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-4 pt-4 flex items-center gap-5 animate-pulse">
          <div className="w-20 h-20 rounded-full bg-ink-100 shrink-0" />
          <div className="flex-1 grid grid-cols-3 gap-2">
            <div className="h-8 rounded-lg bg-ink-100" />
            <div className="h-8 rounded-lg bg-ink-100" />
            <div className="h-8 rounded-lg bg-ink-100" />
          </div>
        </div>
      </MobileShell>
    );
  }

  if (!community) {
    return (
      <MobileShell>
        <p className="px-6 py-12 text-center text-ink-500">{t.communityNotFound}</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell
      /* ── Adding — what the "+" adds depends on the tab under it ──

         In the shell's slot and `fixed`, which is what a screen you scroll
         needs. It used to be an `absolute` child of the page, and nothing in
         MobileShell is positioned, so it anchored to the document's first
         screenful instead of the window: on a short members list it happened to
         land in the corner, and on a shelf of fifteen books it sat in the middle
         of the list with a row underneath it. The `fixed` variant pins to the
         centred content column and is click-through except for the button
         itself, so the list keeps every tap that is not on the "+". */
      fab={canManage && canSeeContent ? (
        <Fab
          fixed
          onClick={() => {
            if (tab === "books")   { navigate("/books/add"); return; }
            // The members tab invites rather than adds: nobody can put a person
            // into a community, only ask them.
            if (tab === "members") { navigate(`/community/${id}/invite`); return; }
            setManageError("");
            setPostBody("");
            setPostOpen(true);
          }}
          ariaLabel={
            tab === "books" ? t.addBookTitle : tab === "members" ? t.inviteMemberTitle : t.newPost
          }
        />
      ) : null}
    >
      {/* Back */}
      <div className="flex items-center gap-2 px-4 mb-2">
        <button onClick={() => navigate(-1)} className="icon-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <p className="font-semibold text-[16px] truncate">{community.name}</p>
        {isPrivate && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-400 shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </div>

      {/* ── Instagram-style header ── */}
      <div className="px-4 pt-2">
        <div className="flex items-center gap-5">
          <Avatar src={community.photoURL} name={community.name} size={80} />
          {/* Stats */}
          <div className="flex-1 grid grid-cols-3 text-center">
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : members.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">{t.statMembers}</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : books.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">{t.statBooks}</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : adminPosts.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">{t.statPosts}</p>
            </div>
          </div>
        </div>

        {/* Name + nickname + privacy badge */}
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <p className="font-bold text-[16px]">{community.name}</p>
            {isPrivate ? (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">{t.privateCommunity}</span>
            ) : (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ok/10 text-ok">{t.publicCommunity}</span>
            )}
          </div>
          <p className="text-[13px] text-ink-500">@{community.nickname}</p>
        </div>

        {/* Action button */}
        <div className="mt-3">
          {isOwner ? (
            /* The admin's own community: the header is where editing it starts. */
            <button
              onClick={() => navigate(`/community/${id}/edit`)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-ink-100 text-[14px] font-semibold text-ink-700 active:scale-[0.99] transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
              {t.editCommunity}
            </button>
          ) : isMember ? (
            <button
              onClick={() => navigate(`/community/${id}/leave`)}
              className="w-full py-2 rounded-xl bg-badSoft text-bad text-[14px] font-semibold active:scale-[0.99] transition"
            >
              {t.exitCommunity}
            </button>
          ) : joinDone ? (
            <div className="w-full py-2 rounded-xl bg-ok/10 text-center text-[14px] font-semibold text-ok">
              ✓ {t.requestSentBadge}
            </div>
          ) : (
            <button
              onClick={() => setJoinOpen(true)}
              className="w-full py-2 rounded-xl bg-brand-500 text-white text-[14px] font-semibold active:scale-[0.99] transition"
            >
              {t.joinAction}
            </button>
          )}
        </div>
      </div>

      {/* ── Privacy gate ── */}
      {!canSeeContent ? (
        <div className="flex flex-col items-center px-8 mt-12 text-center gap-4">
          <div className="w-20 h-20 rounded-full bg-ink-100 flex items-center justify-center">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" className="text-ink-400">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <p className="font-semibold text-[16px]">{t.privateCommunityTitle}</p>
          <p className="text-[14px] text-ink-500 leading-relaxed">
            {t.privateCommunityHint}
          </p>
        </div>
      ) : (
        <>
          {/* ── Tabs ── */}
          <div className="px-4 mt-5 flex gap-1 border-b border-ink-100">
            {TABS.map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={
                  "flex-1 py-2.5 text-[13px] font-semibold transition border-b-2 -mb-px " +
                  (tab === key
                    ? "border-brand-500 text-brand-600"
                    : "border-transparent text-ink-400")
                }
              >
                {key === "posts" ? t.postsLabel : key === "books" ? t.booksTab : t.members}
              </button>
            ))}
          </div>

          <div className="px-4 mt-3 pb-4">
            {contentLoading && (
              <div className="space-y-3 mt-2">
                {[1,2,3].map(i => (
                  <div key={i} className="h-16 rounded-2xl bg-ink-100 animate-pulse" />
                ))}
              </div>
            )}

            {/* Posts tab — the same card the Home feed draws, because it is the
                same post. It used to be a stripped-down box with a body, a name
                and two loud buttons, so a notice a reader had already seen on
                the feed arrived here looking like a different object, with no
                heart, no reply count and no way through to its thread.

                `asCommunity` is what makes it right for *this* screen rather
                than merely consistent with the other one: the board is the
                admin's, so every card would otherwise carry the same personal
                name under a header that already says whose community this is. */}
            {!contentLoading && tab === "posts" && (
              adminPosts.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">{t.noPostsYet}</p>
              ) : (
                <ul className="-mx-4">
                  {adminPosts.map((p) => (
                    <li key={p.id}>
                      <PostCard
                        post={p}
                        community={community}
                        asCommunity
                        liked={likedIds.has(p.id)}
                        likeCount={p.likeCount || 0}
                        onLike={() => onLike(p)}
                        likeDisabled={!user?.id}
                        // Only the admin sees it, and only the admin can be
                        // here: every post drawn on this tab is theirs, so the
                        // old split between "your post" and "somebody else's,
                        // which you may only delete" has nothing left to
                        // separate. Both actions, one corner.
                        menu={canManage ? (
                          <KebabMenu
                            items={[
                              {
                                label: t.edit,
                                onClick: () => {
                                  setEditingPost(p);
                                  setEditBody(p.body || "");
                                  setManageError("");
                                },
                              },
                              { label: t.delete, danger: true, onClick: () => askRemove("post", p) },
                            ]}
                          />
                        ) : null}
                      />
                    </li>
                  ))}
                </ul>
              )
            )}

            {/* Books tab */}
            {!contentLoading && tab === "books" && (
              books.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">{t.noBooksYet}</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {books.map((b) => (
                    <li key={b.id} className="flex items-center gap-2">
                      <Link
                        to={`/books/${b.id}`}
                        className="flex items-center gap-3 flex-1 min-w-0 py-3 active:bg-ink-100/40 transition rounded-xl px-1"
                      >
                        {b.coverUrl ? (
                          <img src={b.coverUrl} alt={b.name} className="w-10 h-14 rounded-lg object-cover bg-ink-100 shrink-0" />
                        ) : (
                          <div className="w-10 h-14 rounded-lg bg-ink-100 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-[15px] truncate">{b.name}</p>
                          <p className="text-[13px] text-ink-500 truncate">{b.author}</p>
                          <div className="mt-1"><BookStatusBadge status={b.status} /></div>
                        </div>
                        {!canManage ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-300 shrink-0">
                            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        ) : null}
                      </Link>
                      {canManage ? (
                        <RowActions
                          onEdit={() => navigate(`/books/${b.id}/edit`)}
                          onDelete={() => askRemove("book", b)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )
            )}

            {/* Members tab — the community's reading leaderboard.
                The list is still the member list: every row opens that member,
                and the admin's remove button rides along on it. It is simply
                ordered by who has actually been reading, which is the one thing
                a community of readers can rank itself by. */}
            {!contentLoading && tab === "members" && (
              <Leaderboard
                members={members}
                currentUserId={user?.id}
                ownerId={community.ownerId}
                renderRowAction={(m) =>
                  // The admin cannot eject themselves — leaving their own
                  // community is a different decision, made elsewhere.
                  //
                  // A screen, not the dialog the other two rows open: this
                  // member may be holding community books, and the admin has to
                  // say where each of them goes before the member can leave.
                  canManage && m.id !== community.ownerId ? (
                    <RowActions onDelete={() => navigate(`/community/${id}/members/${m.id}/remove`)} />
                  ) : null
                }
              />
            )}
          </div>
        </>
      )}

      {/* ── Compose a notice ── */}
      <Modal open={postOpen} onClose={() => !postBusy && setPostOpen(false)} title={t.newPost}>
        <form onSubmit={submitPost} className="space-y-3">
          <textarea
            value={postBody}
            onChange={(e) => setPostBody(e.target.value)}
            placeholder={t.postBody}
            rows="6"
            className="input"
            autoFocus
          />
          {manageError ? <p className="text-bad text-[13px]">{manageError}</p> : null}
          <button disabled={postBusy || !postBody.trim()} className="btn-primary">
            {postBusy ? "…" : t.publish}
          </button>
        </form>
      </Modal>

      {/* ── Edit a notice ── */}
      <Modal
        open={Boolean(editingPost)}
        onClose={() => !postBusy && setEditingPost(null)}
        title={t.editPost}
      >
        <form onSubmit={saveEdit} className="space-y-3">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            placeholder={t.postBody}
            rows="6"
            className="input"
          />
          {manageError ? <p className="text-bad text-[13px]">{manageError}</p> : null}
          <div className="flex gap-3">
            <button type="button" onClick={() => setEditingPost(null)} disabled={postBusy} className="btn-secondary">
              {t.cancel}
            </button>
            <button type="submit" disabled={postBusy} className="btn-primary">
              {postBusy ? "…" : t.save}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Remove a post or a book ── */}
      <Modal
        open={Boolean(removing)}
        onClose={() => !removeBusy && setRemoving(null)}
        title={removing?.kind === "post" ? t.deletePostConfirm : t.deleteBookConfirm}
      >
        <p className="text-[13px] text-ink-700 mb-1 line-clamp-3">
          {removing?.kind === "post"
            ? removing.item.body
            : removing ? `«${removing.item.name}» — ${removing.item.author}` : ""}
        </p>
        <p className="text-[13px] text-ink-500 leading-relaxed mb-4">
          {removing?.kind === "post" ? t.deletePostWarning : t.deleteBookWarning}
        </p>
        {/* Whatever the server said belongs on the dialog that asked. */}
        {manageError ? <p className="text-bad text-[13px] mb-3">{manageError}</p> : null}
        <div className="flex gap-3">
          <button onClick={() => setRemoving(null)} disabled={removeBusy} className="btn-secondary">
            {t.cancel}
          </button>
          <button
            onClick={confirmRemove}
            disabled={removeBusy}
            className="w-full font-semibold rounded-xl py-3.5 bg-badSoft text-bad transition disabled:opacity-60"
          >
            {removeBusy ? "…" : t.delete}
          </button>
        </div>
      </Modal>

      {/* ── Join modal ── */}
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title={t.joinRequestSection} scrollable>
        {joinDone ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-16 h-16 rounded-full bg-ok/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="font-semibold text-[16px]">{t.requestSentTitle}</p>
            <p className="text-[14px] text-ink-500 text-center">{t.requestSentHint}</p>
            <button onClick={() => setJoinOpen(false)} className="btn-primary">{t.close}</button>
          </div>
        ) : (
          <form onSubmit={handleJoin} className="space-y-4">
            <p className="text-[13px] text-ink-600 leading-relaxed">
              {t.joinBookIntro}
            </p>

            <BookFields
              form={bookForm}
              onChange={(k, v) => setBookForm((f) => ({ ...f, [k]: v }))}
            />

            <CoverPicker
              coverUrl={bookForm.coverUrl}
              file={coverFile}
              onFile={setCoverFile}
              onUrlChange={(v) => setBookForm((f) => ({ ...f, coverUrl: v }))}
            />

            <div className="pt-2">
              <p className="text-[14px] font-semibold">{t.contactsRequiredTitle}</p>
              <p className="text-[13px] text-ink-500 leading-relaxed mt-1">
                {t.contactsRequiredNote}
              </p>
            </div>
            {/* The phone is a proven number, not a field. Proven once — by a
                message to our bot from that number — it is never asked for
                again, including when joining somewhere else later, so this row
                is a statement on every subsequent visit. */}
            {hasVerifiedPhone(user) ? (
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-ink-100/60 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[12px] text-ink-500">{t.phone}</p>
                  <p className="text-[15px] font-medium truncate">{user.phone}</p>
                </div>
                <span className="pill bg-ok/10 text-ok text-[12px] shrink-0">✓ {t.phoneVerified}</span>
              </div>
            ) : (
              <div className="rounded-2xl bg-warnSoft px-4 py-3">
                <p className="text-[13px] text-ink-900 leading-relaxed">{t.phoneVerifyToJoin}</p>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/settings/phone?next=${encodeURIComponent(`/community/${id}`)}`)
                  }
                  className="mt-2 text-[13px] font-semibold text-brand-500 underline underline-offset-2"
                >
                  {t.phoneVerifyCta} →
                </button>
              </div>
            )}
            <input
              value={contactForm.address}
              onChange={(e) => setContactForm({ ...contactForm, address: e.target.value })}
              placeholder={`${t.address} * — ${t.addressPlaceholder}`}
              autoComplete="street-address"
              className="input"
            />

            {joinError && <p className="text-bad text-[13px]">{joinError}</p>}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setJoinOpen(false)}
                className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-ink-100 text-ink-700"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={joining}
                className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-brand-500 text-white disabled:opacity-60"
              >
                {joining ? "…" : t.submit}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </MobileShell>
  );
}

/**
 * The pencil-and-bin pair that sits at the right edge of a manageable row.
 *
 * One component for all three tabs so a post, a book and a member offer the
 * same affordance in the same place. `onEdit` is optional — a member has
 * nothing to edit here, only to be removed.
 */
function RowActions({ onEdit, onDelete }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {onEdit ? (
        <button
          onClick={onEdit}
          aria-label={t.edit}
          className="w-8 h-8 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center active:scale-95 transition"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <button
        onClick={onDelete}
        aria-label={t.delete}
        className="w-8 h-8 rounded-lg bg-badSoft text-bad flex items-center justify-center active:scale-95 transition"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path d="M5 7h14M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
