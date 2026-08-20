import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import BookStatusBadge from "../../components/BookStatusBadge.jsx";
import Modal from "../../components/Modal.jsx";
import Fab from "../../components/Fab.jsx";
import BookFields from "../../components/BookFields.jsx";
import Leaderboard from "../../components/Leaderboard.jsx";
import CoverPicker from "../../components/CoverPicker.jsx";
import { uploadImage } from "../../firebase/storage.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  getCommunity, listUsersByCommunity, listPostsByCommunity, listBooks,
  createJoinRequest, createNotification, getActiveBorrowingForUser,
  createPost, updatePost, deletePost, deleteBook, updateUser,
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
  const { user, isAdmin, updateProfile } = useAuth();

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
    name: "", author: "", year: "", pages: "", genres: [], description: "", coverUrl: "",
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
    if (active) { setJoinError("Алдымен алған кітабыңызды қайтарыңыз."); return; }
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
        title: "Қоғамдастыққа кіруге ұсыныс",
        body: `@${user.nickname} өтініш берді. Кітап: «${bookForm.name}»`,
        read: false,
        type: "join-request",
        communityId: id,
        requestId: req.id,
      });

      // Notify the USER themselves — so they can track and cancel the request
      await createNotification({
        recipientId: user.id,
        title: "Өтінішіңіз жіберілді",
        body: `«${community.name}» қоғамдастығына қосылу өтінішіңіз администраторға жіберілді. Жауап күтіңіз.`,
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
  // A post, a book and a member are removed by three different calls, but they
  // are the same decision to the person making it: this row, gone, are you sure.
  // Keeping one dialog is what stops the three from drifting apart.
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
      } else if (kind === "book") {
        await deleteBook(item.id);
        setBooks((list) => list.filter((b) => b.id !== item.id));
      } else {
        // Ejecting a member is a write to *their* profile, which the rules
        // allow this community's admin to make for exactly this field.
        await updateUser(item.id, { communityId: null });
        setMembers((list) => list.filter((m) => m.id !== item.id));
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
        <p className="px-6 py-12 text-center text-ink-500">Қоғамдастық табылмады.</p>
      </MobileShell>
    );
  }

  return (
    <MobileShell>
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
              <p className="text-[11px] text-ink-500 mt-1">мүше</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : books.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">кітап</p>
            </div>
            <div>
              <p className="font-bold text-[20px] leading-none">
                {contentLoading ? <span className="inline-block w-6 h-5 rounded bg-ink-100 animate-pulse" /> : posts.length}
              </p>
              <p className="text-[11px] text-ink-500 mt-1">жазба</p>
            </div>
          </div>
        </div>

        {/* Name + nickname + privacy badge */}
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <p className="font-bold text-[16px]">{community.name}</p>
            {isPrivate ? (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">Жабық</span>
            ) : (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ok/10 text-ok">Ашық</span>
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
              ✓ Өтініш жіберілді
            </div>
          ) : (
            <button
              onClick={() => setJoinOpen(true)}
              className="w-full py-2 rounded-xl bg-brand-500 text-white text-[14px] font-semibold active:scale-[0.99] transition"
            >
              Қосылу
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
          <p className="font-semibold text-[16px]">Бұл жабық қоғамдастық</p>
          <p className="text-[14px] text-ink-500 leading-relaxed">
            Мүшелерді, кітаптарды және жазбаларды көру үшін қосылу өтінішін жіберіңіз.
          </p>
        </div>
      ) : (
        <>
          {/* ── Tabs ── */}
          <div className="px-4 mt-5 flex gap-1 border-b border-ink-100">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "flex-1 py-2.5 text-[13px] font-semibold transition border-b-2 -mb-px " +
                  (tab === t
                    ? "border-brand-500 text-brand-600"
                    : "border-transparent text-ink-400")
                }
              >
                {t === "posts" ? "Жазбалар" : t === "books" ? "Кітаптар" : "Мүшелер"}
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

            {/* Posts tab */}
            {!contentLoading && tab === "posts" && (
              posts.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">Жазба жоқ.</p>
              ) : (
                <div className="space-y-3">
                  {posts.map((p) => (
                    <div key={p.id} className="card p-4 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        {/* `title` only exists on posts written before the field
                            was dropped — nothing creates one now. */}
                        {p.title ? <h4 className="font-semibold text-[15px]">{p.title}</h4> : null}
                        <p className="text-[14px] text-ink-700 mt-1 whitespace-pre-wrap">{p.body}</p>
                        {/* Worth saying now that the board is not one person's:
                            any member can post here, so a notice without a name
                            on it is a notice from nobody in particular. */}
                        {p.authorName ? (
                          <p className="text-[12px] text-ink-500 mt-2">{p.authorName}</p>
                        ) : null}
                      </div>
                      {/* Two different permissions, drawn as two different rows
                          of buttons, and both are exactly what the rules allow:
                          the author may fix or remove what they wrote, and the
                          community's admin may remove — not rewrite — anybody's.
                          This is where a member manages their own post, which is
                          why it is drawn for members and not only for admins. */}
                      {p.authorId === user?.id ? (
                        <RowActions
                          onEdit={() => {
                            setEditingPost(p);
                            setEditBody(p.body || "");
                            setManageError("");
                          }}
                          onDelete={() => askRemove("post", p)}
                        />
                      ) : canManage ? (
                        <RowActions onDelete={() => askRemove("post", p)} />
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            )}

            {/* Books tab */}
            {!contentLoading && tab === "books" && (
              books.length === 0 ? (
                <p className="text-center text-ink-400 text-[14px] py-10">Кітап жоқ.</p>
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
                  canManage && m.id !== community.ownerId ? (
                    <RowActions onDelete={() => askRemove("member", m)} />
                  ) : null
                }
              />
            )}
          </div>
        </>
      )}

      {/* ── Adding — what the "+" adds depends on the tab under it ── */}
      {canManage && canSeeContent && tab !== "members" ? (
        <Fab
          onClick={() => {
            if (tab === "books") { navigate("/books/add"); return; }
            setManageError("");
            setPostBody("");
            setPostOpen(true);
          }}
          ariaLabel={tab === "books" ? t.addBookTitle : t.newPost}
        />
      ) : null}

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

      {/* ── Remove a post, a book or a member ── */}
      <Modal
        open={Boolean(removing)}
        onClose={() => !removeBusy && setRemoving(null)}
        title={
          removing?.kind === "post"  ? t.deletePostConfirm
          : removing?.kind === "book" ? t.deleteBookConfirm
          : t.removeMemberConfirm
        }
      >
        <p className="text-[13px] text-ink-700 mb-1 line-clamp-3">
          {removing?.kind === "post"  ? removing.item.body
           : removing?.kind === "book" ? `«${removing.item.name}» — ${removing.item.author}`
           : removing ? `${removing.item.firstName} ${removing.item.lastName} (@${removing.item.nickname})` : ""}
        </p>
        <p className="text-[13px] text-ink-500 leading-relaxed mb-4">
          {removing?.kind === "post"  ? t.deletePostWarning
           : removing?.kind === "book" ? t.deleteBookWarning
           : t.removeMemberWarning}
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
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Қосылу өтінішi" scrollable>
        {joinDone ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-16 h-16 rounded-full bg-ok/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="font-semibold text-[16px]">Өтініш жіберілді!</p>
            <p className="text-[14px] text-ink-500 text-center">Администратор жауап берген соң хабарлама аласыз.</p>
            <button onClick={() => setJoinOpen(false)} className="btn-primary">Жабу</button>
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
                Болдырмау
              </button>
              <button
                type="submit"
                disabled={joining}
                className="flex-1 py-3 rounded-xl text-[14px] font-semibold bg-brand-500 text-white disabled:opacity-60"
              >
                {joining ? "…" : "Жіберу"}
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
