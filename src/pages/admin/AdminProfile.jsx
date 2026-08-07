import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import AppIcon from "../../components/AppIcon.jsx";
import Modal from "../../components/Modal.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listPostsByCommunity, listUsersByCommunity, updatePost, deletePost } from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";
import { logger } from "../../utils/logger.js";

export default function AdminProfile() {
  const { user, switchView } = useAuth();
  const navigate = useNavigate();
  const { community } = useCommunity();
  const [posts, setPosts] = useState([]);
  const [members, setMembers] = useState([]);

  useEffect(() => {
    if (!community?.id) return;
    listPostsByCommunity(community.id).then(setPosts);
    listUsersByCommunity(community.id).then(setMembers);
  }, [community?.id]);

  // ── Editing a post ──────────────────────────────────────────────────────────
  // Only the author's own notices are editable — the rules say the same thing,
  // so offering the button on somebody else's post would only produce a write
  // the server refuses.
  const [editing, setEditing] = useState(null); // the post being edited
  const [form, setForm] = useState({ title: "", body: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function openEdit(post) {
    setEditing(post);
    setForm({ title: post.title || "", body: post.body || "" });
    setError("");
  }

  // ── Deleting a post ─────────────────────────────────────────────────────────
  // Behind a confirmation, because there is no undo: the rules refuse a create
  // that carries its own id, so a deleted notice cannot be put back where it was.
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  async function removePost() {
    if (deleting || !confirmDelete) return;
    setDeleting(true);
    try {
      await deletePost(confirmDelete.id);
      setPosts((list) => list.filter((p) => p.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (err) {
      logger.error("adminProfile.deletePost", err?.message, { postId: confirmDelete.id });
      setError(err?.message || t.error);
    } finally {
      setDeleting(false);
    }
  }

  async function savePost(e) {
    e.preventDefault();
    if (saving || !editing) return;
    if (!form.title.trim()) { setError(t.fillAllFields); return; }
    setSaving(true);
    setError("");
    try {
      const patch = { title: form.title.trim(), body: form.body };
      await updatePost(editing.id, patch);
      setPosts((list) => list.map((p) => (p.id === editing.id ? { ...p, ...patch } : p)));
      setEditing(null);
    } catch (err) {
      setError(t[err?.errorKey] || err?.message || t.error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <MobileShell>
      <div className="flex justify-end px-4">
        <Link to="/settings" className="icon-btn" aria-label="Settings">
          <AppIcon name="settings" size={22} />
        </Link>
      </div>

      <div className="flex flex-col items-center">
        <Avatar src={user?.photoURL} name={`${user?.firstName} ${user?.lastName}`} size={92} />
        <h2 className="font-bold text-xl mt-3">{user?.firstName} {user?.lastName}</h2>
        <p className="text-ink-500 text-[14px]">@{user?.nickname}</p>
        <span className="mt-2 pill bg-brand-50 text-brand-700">Админ</span>

        {/* Members button */}
        <button
          onClick={() => navigate("/admin/members")}
          className="mt-3 flex items-center gap-2 px-5 py-2 rounded-2xl bg-ink-100 hover:bg-ink-200 active:scale-[0.97] transition text-[14px] font-semibold text-ink-700"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-500">
            <circle cx="9" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M3 21c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M16 3.1a3 3 0 0 1 0 5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M21 21c0-2.7-1.7-5-4-5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Участники
          {members.length > 0 && (
            <span className="ml-0.5 text-[12px] text-ink-400 font-medium">({members.length})</span>
          )}
        </button>
      </div>

      {/* Role switcher — switch to user view */}
      <div className="px-4 mt-4">
        <button
          onClick={switchView}
          className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-ink-100 hover:bg-ink-100/70 transition active:scale-[0.99]"
        >
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl bg-surface flex items-center justify-center shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M5 20c.6-3.4 3.5-6 7-6s6.4 2.6 7 6" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </span>
            <div className="text-left">
              <p className="text-[14px] font-semibold text-ink-900">Переключиться на пользователя</p>
              <p className="text-[12px] text-ink-500">Просмотр в режиме обычного пользователя</p>
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-400 flex-shrink-0">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {community ? (
        <Link to={`/community/${community.id}`} className="mx-4 mt-5 flex items-center gap-3 border-2 border-brand-200 rounded-2xl px-3 py-3">
          <Avatar src={community.photoURL} name={community.name} size={44} />
          <div><p className="font-medium">{community.name}</p><p className="text-[13px] text-ink-500">@{community.nickname}</p></div>
        </Link>
      ) : null}

      <section className="px-4 mt-5">
        <h3 className="section-title mb-2">Публикации сообщества ({posts.length})</h3>
        {posts.length === 0 ? (
          <p className="text-ink-500 text-[13px]">Публикаций ещё нет.</p>
        ) : (
          <ul className="space-y-2">
            {posts.slice(0, 3).map((p) => (
              <li key={p.id} className="card p-3 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[14px]">{p.title}</p>
                  <p className="text-[12px] text-ink-500 truncate">{p.body}</p>
                </div>
                {/* Only the author's own notices — the rules say the same, so a
                    button on somebody else's post would only be refused. */}
                {p.authorId === user?.id ? (
                  <div className="flex items-center gap-1.5 shrink-0">
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
                      onClick={() => setConfirmDelete(p)}
                      aria-label={t.delete}
                      className="w-8 h-8 rounded-lg bg-badSoft text-bad flex items-center justify-center active:scale-95 transition"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                        <path d="M5 7h14M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-4 mt-5">
        <h3 className="section-title mb-2">Участники ({members.length})</h3>
        <ul className="space-y-2">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2 card">
              <Avatar src={m.photoURL} name={`${m.firstName} ${m.lastName}`} size={36} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[14px] truncate">{m.firstName} {m.lastName}</p>
                <p className="text-[12px] text-ink-500 truncate">@{m.nickname}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => !deleting && setConfirmDelete(null)}
        title={t.deletePostConfirm}
      >
        <p className="text-[14px] text-ink-700 mb-1 font-medium">{confirmDelete?.title}</p>
        <p className="text-[13px] text-ink-500 leading-relaxed mb-4">{t.deletePostWarning}</p>
        <div className="flex gap-3">
          <button
            onClick={() => setConfirmDelete(null)}
            disabled={deleting}
            className="btn-secondary"
          >
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

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={t.editPost}>
        <form onSubmit={savePost} className="space-y-3">
          <input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder={t.postTitle}
            className="input"
          />
          <textarea
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            placeholder={t.postBody}
            rows="5"
            className="input"
          />
          {error ? <p className="text-bad text-[13px]">{error}</p> : null}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setEditing(null)}
              disabled={saving}
              className="btn-secondary"
            >
              {t.cancel}
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "…" : t.save}
            </button>
          </div>
        </form>
      </Modal>
    </MobileShell>
  );
}
