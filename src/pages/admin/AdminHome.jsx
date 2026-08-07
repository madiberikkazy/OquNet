import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Fab from "../../components/Fab.jsx";
import Modal from "../../components/Modal.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  createPost, listPostsByCommunity, searchUsers, createNotification, toMillis,
} from "../../firebase/firestore.js";
import { Link, useNavigate } from "react-router-dom";

export default function AdminHome() {
  const { user } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [search, setSearch] = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [postForm, setPostForm] = useState({ title: "", body: "" });

  useEffect(() => { if (community?.id) listPostsByCommunity(community.id).then(setPosts); }, [community?.id]);
  useEffect(() => {
    if (!search) { setFoundUsers([]); return; }
    searchUsers(search).then(setFoundUsers);
  }, [search]);

  async function submitPost(e) {
    e.preventDefault();
    if (!postForm.title.trim()) return;
    // No `createdAt`: the data layer stamps it server-side, which is why the
    // post prepended below carries no date until the next load.
    const p = await createPost({
      communityId: community.id, authorId: user.id,
      authorName: `${user.firstName} ${user.lastName}`,
      // Denormalised from the community so the Home discovery feed can query
      // posts directly — see listPublicPosts. A private community's notices
      // stay off that feed and readable only to its members.
      isPublic: !community.isPrivate,
      ...postForm,
    });
    setPosts([p, ...posts]);
    setPostForm({ title: "", body: "" });
    setCreateOpen(false);
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
                  <h4 className="font-semibold">{p.title}</h4>
                  <p className="text-[14px] text-ink-700 mt-1 whitespace-pre-wrap">{p.body}</p>
                  {p.createdAt ? (
                    <p className="text-[12px] text-ink-500 mt-2">
                      {new Date(toMillis(p.createdAt)).toLocaleString("ru-RU")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Fab onClick={() => setCreateOpen(true)} ariaLabel="Создать публикацию" />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Новая публикация">
        <form onSubmit={submitPost} className="space-y-3">
          <input value={postForm.title} onChange={(e) => setPostForm({ ...postForm, title: e.target.value })} placeholder="Заголовок" className="input" />
          <textarea value={postForm.body} onChange={(e) => setPostForm({ ...postForm, body: e.target.value })} placeholder="Текст публикации" rows="4" className="input" />
          <button className="btn-primary">Опубликовать</button>
        </form>
      </Modal>
    </MobileShell>
  );
}
