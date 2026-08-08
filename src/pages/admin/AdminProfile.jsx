import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import AppIcon from "../../components/AppIcon.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { listUsersByCommunity } from "../../firebase/firestore.js";

export default function AdminProfile() {
  const { user, switchView } = useAuth();
  const navigate = useNavigate();
  const { community } = useCommunity();
  const [members, setMembers] = useState([]);

  useEffect(() => {
    if (!community?.id) return;
    listUsersByCommunity(community.id).then(setMembers);
  }, [community?.id]);

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

    </MobileShell>
  );
}
