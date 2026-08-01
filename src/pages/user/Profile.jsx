import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import {
  listBorrowingsForUser, listBooks,
} from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";

export default function Profile() {
  const { user, isAdmin, isViewingAsUser, switchView } = useAuth();
  const { community } = useCommunity();
  const navigate = useNavigate();

  const [stats, setStats]                         = useState({ owned: 0, reading: 0, completed: 0, saved: 0 });
  const [activeBorrowing, setActiveBorrowing]     = useState(null);

  useEffect(() => {
    (async () => {
      if (!user) return;
      const readingList = await listBorrowingsForUser(user.id, "active");
      const completed   = await listBorrowingsForUser(user.id, "completed");
      const allBooksResult = community?.id ? await listBooks({ communityId: community.id }) : { items: [] };
      const allBooks = allBooksResult?.items || allBooksResult || [];
      // Same logic as OwnedBooks.jsx — books you physically hold right now
      const owned = allBooks.filter(
        (b) =>
          (b.ownerId === user.id && b.status !== "unavailable") ||
          (b.borrowerId === user.id && b.status === "unavailable")
      );

      setActiveBorrowing(readingList[0] || null);

      const savedIds = user.savedBookIds || [];
      setStats({
        owned:     owned.length,
        reading:   readingList.length,
        completed: completed.length,
        saved:     savedIds.length,
      });
    })();
  }, [user?.id, community?.id]);

  return (
    <MobileShell>
      {/* Settings icon */}
      <div className="flex justify-end px-4">
        <Link to="/settings" className="icon-btn" aria-label="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 4.43 16.96l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.62.99 1 1.65 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </Link>
      </div>

      {isViewingAsUser && (
        <div className="mx-4 mb-1 px-4 py-2.5 bg-brand-50 border border-brand-200 rounded-2xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-500 flex-shrink-0">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span className="text-[13px] text-brand-700 font-medium">Режим просмотра пользователя</span>
          </div>
          <button onClick={switchView} className="text-[12px] font-semibold text-brand-600 underline underline-offset-2 whitespace-nowrap">
            Выйти
          </button>
        </div>
      )}

      {/* Avatar + name */}
      <div className="flex flex-col items-center pt-2">
        <Avatar src={user?.photoURL} name={`${user?.firstName} ${user?.lastName}`} size={92} />
        <h2 className="font-bold text-xl mt-3">{user?.firstName} {user?.lastName}</h2>
        <p className="text-ink-500 text-[14px]">@{user?.nickname}</p>
        {isAdmin && (
          <span className="mt-2 pill bg-brand-50 text-brand-700">Администратор сообщества</span>
        )}
      </div>

      {/* Community link */}
      <div className="px-4 mt-5">
        {community ? (
          <Link to={`/community/${community.id}`} className="flex items-center gap-3 border-2 border-brand-200 rounded-2xl px-3 py-3">
            <Avatar src={community.photoURL} name={community.name} size={44} />
            <div><p className="font-medium">{community.name}</p><p className="text-[13px] text-ink-500">@{community.nickname}</p></div>
          </Link>
        ) : (
          <Link to="/community/join" className="btn-primary block text-center">Найти сообщество</Link>
        )}
      </div>

      {/* ── Stats grid — all 4 cards are tappable ── */}
      <div className="px-4 mt-5 grid grid-cols-2 gap-3">
        <Card
          color="bg-statPurple" icon="user"
          title={t.ownedBooks}
          value={stats.owned}
          onClick={() => navigate("/profile/owned")}
        />
        <Card
          color="bg-statGreen" icon="calendar"
          title={t.readingNow}
          desc={activeBorrowing ? activeBorrowing.bookName : undefined}
          value={stats.reading}
          onClick={() => navigate("/profile/reading")}
        />
        <Card
          color="bg-statRed" icon="check"
          title={t.completed}
          value={stats.completed}
          onClick={() => navigate("/profile/completed")}
        />
        <Card
          color="bg-statPink" icon="heart"
          title={t.saved}
          value={stats.saved}
          onClick={() => navigate("/profile/saved")}
        />
      </div>

      {/* Admin switch-back banner */}
      {isViewingAsUser && (
        <div className="px-4 mt-4">
          <button
            onClick={switchView}
            className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-brand-50 border border-brand-200 hover:bg-brand-100 transition active:scale-[0.99]"
          >
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-xl bg-surface flex items-center justify-center shadow-sm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-500">
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              <div className="text-left">
                <p className="text-[14px] font-semibold text-brand-900">Переключиться на администратора</p>
                <p className="text-[12px] text-brand-600">Вернуться к управлению сообществом</p>
              </div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-brand-400 flex-shrink-0">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div className="h-4" />
    </MobileShell>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function Card({ color, icon, title, desc, value, onClick }) {
  return (
    <div
      onClick={onClick}
      className={
        "rounded-2xl p-4 cursor-pointer active:scale-[0.98] transition-all " + color
      }
    >
      <div className="text-ink-700 mb-2">{renderIcon(icon)}</div>
      <h4 className="font-semibold text-[14px] leading-tight">{title}</h4>
      {desc ? <p className="text-[12px] text-ink-500 mt-1 line-clamp-2">{desc}</p> : null}
      <p className="text-[20px] font-bold mt-2">{value}</p>
    </div>
  );
}


function renderIcon(icon) {
  if (icon === "user")     return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" /><path d="M5 20c.6-3.4 3.5-6 7-6s6.4 2.6 7 6" stroke="currentColor" strokeWidth="1.6" /></svg>;
  if (icon === "calendar") return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M4 10h16M8 4v4M16 4v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
  if (icon === "check")    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (icon === "heart")    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
  return null;
}
