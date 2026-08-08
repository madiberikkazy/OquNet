import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Fab from "../../components/Fab.jsx";
import Modal from "../../components/Modal.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  createPost, listPostsByCommunity, searchUsers, createNotification,
  updatePost, deletePost,
} from "../../firebase/firestore.js";
import { formatPostDate } from "../../utils/time.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";
import { Link, useNavigate } from "react-router-dom";

/**
 * What to show the admin when a post write is refused.
 *
 * A SchemaError names the i18n key for the field it refused. Firestore's own
 * "Missing or insufficient permissions" is the message that matters most here
 * and the one a user can do least with, so it is translated: it means the rules
 * in the project do not yet allow what this build is asking for.
 */
function postWriteError(err) {
  if (err?.errorKey && t[err.errorKey]) return t[err.errorKey];
  if (err?.code === "permission-denied") return t.notAuthorized;
  return err?.message || t.error;
}

export default function AdminHome() {
  const { user } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [search, setSearch] = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  // A post is just its text now — no headline to invent before writing one.
  const [postBody, setPostBody] = useState("");
  const [posting, setPosting] = useState(false);

  // Editing and deleting live here, next to the posts themselves, rather than
  // on the profile: this is the screen that lists them in full.
  const [editing, setEditing] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [postError, setPostError] = useState("");

  useEffect(() => { if (community?.id) listPostsByCommunity(community.id).then(setPosts); }, [community?.id]);
  useEffect(() => {
    if (!search) { setFoundUsers([]); return; }
    searchUsers(search).then(setFoundUsers);
  }, [search]);

  async function submitPost(e) {
    e.preventDefault();
    if (posting || !postBody.trim()) return;
    setPosting(true);
    setPostError("");
    try {
      // No `createdAt`: the data layer stamps it server-side, which is why the
      // post prepended below carries no date until the next load.
      const p = await createPost({
        communityId: community.id, authorId: user.id,
        authorName: `${user.firstName} ${user.lastName}`,
        // Denormalised from the community so the Home discovery feed can query
        // posts directly — see listPublicPosts. A private community's notices
        // stay off that feed and readable only to its members.
        isPublic: !community.isPrivate,
        body: postBody.trim(),
      });
      setPosts([p, ...posts]);
      setPostBody("");
      setCreateOpen(false);
    } catch (err) {
      logger.error("adminHome.createPost", err?.message, { code: err?.code });
      setPostError(postWriteError(err));
    } finally {
      setPosting(false);
    }
  }

  function openEdit(post) {
    setEditing(post);
    setEditBody(post.body || "");
    setPostError("");
  }

  function openDelete(post) {
    // Clear whatever the last dialog complained about, so a fresh attempt does
    // not open under a stale error.
    setPostError("");
    setConfirmDelete(post);
  }

  async function saveEdit(e) {
    e.preventDefault();
    if (saving || !editing) return;
    if (!editBody.trim()) { setPostError(t.fillAllFields); return; }
    setSaving(true);
    setPostError("");
    try {
      const patch = { body: editBody.trim() };
      await updatePost(editing.id, patch);
      setPosts((list) => list.map((p) => (p.id === editing.id ? { ...p, ...patch } : p)));
      setEditing(null);
    } catch (err) {
      logger.error("adminHome.updatePost", err?.message, { postId: editing.id, code: err?.code });
      setPostError(postWriteError(err));
    } finally {
      setSaving(false);
    }
  }

  async function removePost() {
    if (deleting || !confirmDelete) return;
    setDeleting(true);
    try {
      await deletePost(confirmDelete.id);
      setPosts((list) => list.filter((p) => p.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (err) {
      logger.error("adminHome.deletePost", err?.message, {
        postId: confirmDelete.id, code: err?.code,
      });
      setPostError(postWriteError(err));
    } finally {
      setDeleting(false);
    }
  }

  async function inviteUser(targetId) {
    await createNotification({
      recipientId: targetId,
      title: "Қоғамдастыққа кіруге ұсыныс",
      body: `${community.nickname} қоғамдастығы сізге кіруге ұсыныс тастады.`,
      read: false, type: "invite", communityId: community.id,
    });
    alert("Приглашение отправлено");
  }

  if (!community) {
    return (
      <MobileShell>
        <div className="px-6 pt-10 text-center">
          <h2 className="text-xl font-bold">У вас ещё нет сообщества</h2>
          <button onClick={() => navigate("/community/create")} className="btn-primary mt-4">Создать сообщество</button>
        </div>
      </MobileShell>
    );
  }

  return (
    <MobileShell>
      <SearchBar value={search} onChange={setSearch} placeholder="Найти пользователя для приглашения" />

      {search ? (
        <ul className="card mx-4 mt-3 divide-y divide-ink-100">
          {foundUsers.length === 0 ? (
            <li className="px-4 py-6 text-center text-ink-500">Никого не найдено</li>
          ) : (
            foundUsers.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar src={u.photoURL} name={`${u.firstName} ${u.lastName}`} />
                <div className="flex-1 min-w-0">
                  <Link to={`/users/${u.id}`} className="font-medium block">{u.firstName} {u.lastName}</Link>
                  <p className="text-[13px] text-ink-500">@{u.nickname}</p>
                </div>
                <button onClick={() => inviteUser(u.id)} className="px-3 py-1.5 rounded-lg bg-brand-500 text-white text-[13px] font-medium">Пригласить</button>
              </li>
            ))
          )}
        </ul>
      ) : (
        <div className="px-4 mt-3">
          <div className="flex items-center gap-3 mb-4">
            <Avatar src={community.photoURL} name={community.name} size={48} />
            <div><h2 className="font-bold text-lg">{community.name}</h2><p className="text-[13px] text-ink-500">@{community.nickname}</p></div>
          </div>
          {posts.length === 0 ? (
            <p className="text-center text-ink-500 py-8">Пока что нет публикаций. Нажмите «+», чтобы создать первую.</p>
          ) : (
            <ul className="space-y-3">
              {posts.map((p) => (
                <li key={p.id} className="card p-4">
                  {/* `title` only exists on posts written before the field was
                      dropped — nothing creates one now. */}
                  {p.title ? <h4 className="font-semibold">{p.title}</h4> : null}
                  <p className="text-[14px] text-ink-700 mt-1 whitespace-pre-wrap">{p.body}</p>

                  <div className="flex items-center justify-between mt-3">
                    <span className="text-[12px] text-ink-500">
                      {formatPostDate(p.createdAt)}
                    </span>

                    {/* Only the author's own notices — the rules say the same,
                        so a button on somebody else's post would be refused. */}
                    {p.authorId === user?.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => openEdit(p)}
                          aria-label={t.edit}
                          className="w-8 h-8 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center active:scale-95 transition"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                            <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          onClick={() => openDelete(p)}
                          aria-label={t.delete}
                          className="w-8 h-8 rounded-lg bg-badSoft text-bad flex items-center justify-center active:scale-95 transition"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                            <path d="M5 7h14M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Fab onClick={() => setCreateOpen(true)} ariaLabel="Создать публикацию" />

      <Modal open={createOpen} onClose={() => !posting && setCreateOpen(false)} title="Новая публикация">
        <form onSubmit={submitPost} className="space-y-3">
          <textarea
            value={postBody}
            onChange={(e) => setPostBody(e.target.value)}
            placeholder={t.postBody}
            rows="6"
            className="input"
            autoFocus
          />
          {postError ? <p className="text-bad text-[13px]">{postError}</p> : null}
          <button disabled={posting || !postBody.trim()} className="btn-primary">
            {posting ? "…" : "Опубликовать"}
          </button>
        </form>
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={t.editPost}>
        <form onSubmit={saveEdit} className="space-y-3">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            placeholder={t.postBody}
            rows="6"
            className="input"
          />
          {postError ? <p className="text-bad text-[13px]">{postError}</p> : null}
          <div className="flex gap-3">
            <button type="button" onClick={() => setEditing(null)} disabled={saving} className="btn-secondary">
              {t.cancel}
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "…" : t.save}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => !deleting && setConfirmDelete(null)}
        title={t.deletePostConfirm}
      >
        <p className="text-[13px] text-ink-700 mb-1 line-clamp-3">{confirmDelete?.body}</p>
        <p className="text-[13px] text-ink-500 leading-relaxed mb-4">{t.deletePostWarning}</p>
        {/* A refused delete used to fail here in silence: the error was written
            to state that only the other two modals rendered, so the dialog just
            sat there. Whatever the server said belongs on the dialog that asked. */}
        {postError ? <p className="text-bad text-[13px] mb-3">{postError}</p> : null}
        <div className="flex gap-3">
          <button onClick={() => setConfirmDelete(null)} disabled={deleting} className="btn-secondary">
            {t.cancel}
          </button>
          <button
            onClick={removePost}
            disabled={deleting}
            className="w-full font-semibold rounded-xl py-3.5 bg-badSoft text-bad transition disabled:opacity-60"
          >
            {deleting ? "…" : t.delete}
          </button>
        </div>
      </Modal>
    </MobileShell>
  );
}
