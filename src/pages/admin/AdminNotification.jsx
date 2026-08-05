import { useEffect, useState } from "react";
import MobileShell from "../../components/MobileShell.jsx";
import SearchBar from "../../components/SearchBar.jsx";
import Fab from "../../components/Fab.jsx";
import Modal from "../../components/Modal.jsx";
import NotificationItem from "../../components/NotificationItem.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { useNotifications } from "../../contexts/NotificationContext.jsx";
import {
  createNotification,
  listJoinRequests, listLeaveRequests,
  listUsersByCommunity,
  updateJoinRequest, updateLeaveRequest, updateUser,
  toMillis,
} from "../../firebase/firestore.js";
import { t } from "../../utils/i18n.js";
import { checkCommunityExit, exitBlockMessage } from "../../utils/communityExit.js";

export default function AdminNotification() {
  const { user } = useAuth();
  const { community } = useCommunity();
  const { notifications, loadNotifications, loading } = useNotifications();

  const [joinRequests, setJoinRequests] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [search, setSearch]             = useState("");
  const [sendOpen, setSendOpen]         = useState(false);
  const [members, setMembers]           = useState([]);
  const [form, setForm]                 = useState({ recipientId: "", title: "", body: "" });
  const [busy, setBusy]                 = useState(null); // requestId being processed
  const [leaveBlocked, setLeaveBlocked] = useState(null); // { id, message } — refused approval

  useEffect(() => {
    loadNotifications();
    if (community?.id) {
      listJoinRequests(community.id).then((rows) =>
        setJoinRequests(rows.filter((r) => r.status === "pending"))
      );
      listLeaveRequests(community.id).then(setLeaveRequests);
      listUsersByCommunity(community.id).then(setMembers);
    }
  }, [community?.id, loadNotifications]);

  // Lookup maps: requestId → request object
  const joinMap  = {};  joinRequests.forEach((r)  => { joinMap[r.id]  = r; });
  const leaveMap = {};  leaveRequests.forEach((r) => { leaveMap[r.id] = r; });

  // ── Join: approve ───────────────────────────────────────────────────────────
  async function approveJoin(req) {
    setBusy(req.id);
    try {
      await updateJoinRequest(req.id, { status: "approved" });
      await createNotification({
        recipientId: req.userId,
        title: "Заявка одобрена 🎉",
        body: `Администратор сообщества «${community.name}» одобрил вашу заявку. Хотите вступить?`,
        read: false,
        type: "join-approved",
        // The member's own "yes" is what actually writes their membership, and
        // the security rules will only accept that write if it names the
        // request that authorised it — so the id has to travel with the offer.
        requestId: req.id,
        communityId: community.id,
        communityName: community.name,
        bookName: req.bookName || "",
        bookAuthor: req.bookAuthor || "",
        bookDescription: req.bookDescription || "",
        bookCoverUrl: req.bookCoverUrl || "",
        confirmed: "pending",
      });
      setJoinRequests((prev) => prev.filter((r) => r.id !== req.id));
    } finally {
      setBusy(null);
    }
  }

  // ── Join: reject ────────────────────────────────────────────────────────────
  async function rejectJoin(req) {
    setBusy(req.id);
    try {
      await updateJoinRequest(req.id, { status: "rejected" });
      await createNotification({
        recipientId: req.userId,
        title: "Заявка отклонена",
        body: `К сожалению, ваша заявка в сообщество «${community?.name}» была отклонена.`,
        read: false,
        type: "join-rejected",
      });
      setJoinRequests((prev) => prev.filter((r) => r.id !== req.id));
    } finally {
      setBusy(null);
    }
  }

  // ── Leave: approve ──────────────────────────────────────────────────────────
  async function approveLeave(req) {
    setBusy(req.id);
    setLeaveBlocked(null);
    try {
      // The final gate, and the one that matters most: a request can sit here
      // for days, and in the meantime the member may have picked up a book.
      // Approval is what actually drops their membership, so the rules are
      // re-checked against live data right before that write.
      const verdict = await checkCommunityExit({
        userId: req.userId,
        communityId: req.communityId || community?.id,
      });
      if (!verdict.canLeave) {
        setLeaveBlocked({ id: req.id, message: exitBlockMessage(verdict.blockedBy) });
        await createNotification({
          recipientId: req.userId,
          title: t.leaveTitle,
          body: exitBlockMessage(verdict.blockedBy),
          read: false,
          type: "leave-blocked",
          communityId: community?.id,
        });
        return;
      }

      await updateLeaveRequest(req.id, { status: "approved" });
      await updateUser(req.userId, { communityId: null });
      await createNotification({
        recipientId: req.userId,
        title: "Өтінішіңіз қабылданды",
        body: `Администратор сіздің «${community.name}» қоғамдастығынан шығу өтінішіңізді қабылдады.`,
        read: false,
        type: "leave-approved",
      });
      setLeaveRequests((prev) => prev.filter((r) => r.id !== req.id));
    } finally {
      setBusy(null);
    }
  }

  // ── Leave: reject ───────────────────────────────────────────────────────────
  async function rejectLeave(req) {
    setBusy(req.id);
    try {
      await updateLeaveRequest(req.id, { status: "rejected" });
      await createNotification({
        recipientId: req.userId,
        title: "Өтінішіңіз қабылданбады",
        body: `Администратор сіздің «${community?.name}» қоғамдастығынан шығу өтінішіңізді қабылдамады.`,
        read: false,
        type: "leave-rejected",
      });
      setLeaveRequests((prev) => prev.filter((r) => r.id !== req.id));
    } finally {
      setBusy(null);
    }
  }

  async function send(e) {
    e.preventDefault();
    // The data layer refuses a titleless notification, so stop here rather than
    // throwing out of an unguarded submit.
    if (!form.recipientId || !form.title.trim()) return;
    await createNotification({
      recipientId: form.recipientId,
      title: form.title,
      body: form.body,
      read: false,
      type: "message",
      senderId: user.id,
    });
    setForm({ recipientId: "", title: "", body: "" });
    setSendOpen(false);
    await loadNotifications();
    alert("Отправлено");
  }

  const filtered = notifications.filter(
    (n) =>
      !search ||
      n.title?.toLowerCase().includes(search.toLowerCase()) ||
      n.body?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <MobileShell>
      <SearchBar value={search} onChange={setSearch} placeholder="Поиск" />

      <section className="mt-2">
        {loading ? (
          <p className="px-6 py-12 text-center text-ink-500">Загрузка...</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={t.noNotifications}
            subtitle={t.noNotificationsHint}
            icon={
              <svg width="120" height="120" viewBox="0 0 24 24" className="text-brand-500" fill="currentColor">
                <path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 15a.75.75 0 0 0 .53 1.28h13.94A.75.75 0 0 0 19.5 15L18 12.5V9a6 6 0 0 0-6-6Zm0 18a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 21Z" />
              </svg>
            }
          />
        ) : (
          <ul>
            {filtered.map((n) => {
              const joinReq  = n.type === "join-request"  ? joinMap[n.requestId]  : null;
              const leaveReq = n.type === "leave-request" ? leaveMap[n.requestId] : null;
              const actionReq = joinReq || leaveReq;

              if (actionReq) {
                const isBusy = busy === actionReq.id;
                const isLeave = Boolean(leaveReq);
                const date = n.createdAt
                  ? new Date(toMillis(n.createdAt))
                      .toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" })
                  : "";

                return (
                  <li key={n.id} className="px-4 py-4 border-b border-ink-100 last:border-b-0">
                    <div className="flex items-start justify-between gap-2 mb-0.5">
                      <p className="font-semibold text-[15px] leading-snug">{n.title}</p>
                      {date ? <span className="text-[11px] text-ink-500 shrink-0 mt-0.5">{date}</span> : null}
                    </div>
                    <p className="text-[13px] text-ink-500 mb-3 leading-relaxed">{n.body}</p>
                    {/* Approval was refused: the member still has books out.
                        The request stays pending — nothing to decide until
                        they settle up. */}
                    {leaveBlocked?.id === actionReq.id ? (
                      <div className="mb-3 rounded-xl bg-badSoft text-bad text-[13px] px-3 py-2 leading-relaxed">
                        {leaveBlocked.message}
                      </div>
                    ) : null}
                    <div className="flex gap-2">
                      <button
                        disabled={isBusy}
                        onClick={() => isLeave ? approveLeave(actionReq) : approveJoin(actionReq)}
                        className="flex-1 py-2.5 rounded-xl bg-brand-500 text-white text-[13px] font-semibold active:scale-[0.98] transition disabled:opacity-60"
                      >
                        {isBusy ? "…" : "Қабылдау"}
                      </button>
                      <button
                        disabled={isBusy}
                        onClick={() => isLeave ? rejectLeave(actionReq) : rejectJoin(actionReq)}
                        className="flex-1 py-2.5 rounded-xl bg-badSoft text-bad text-[13px] font-semibold active:scale-[0.98] transition disabled:opacity-60"
                      >
                        {isBusy ? "…" : "Бас тарту"}
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li key={n.id}>
                  <NotificationItem notification={n} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Fab onClick={() => setSendOpen(true)} ariaLabel="Send notification" />

      <Modal open={sendOpen} onClose={() => setSendOpen(false)} title="Отправить сообщение">
        <form onSubmit={send} className="space-y-3">
          <select
            value={form.recipientId}
            onChange={(e) => setForm({ ...form, recipientId: e.target.value })}
            className="input"
          >
            <option value="">Кому?</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                @{m.nickname} — {m.firstName} {m.lastName}
              </option>
            ))}
          </select>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Тема"
            className="input"
          />
          <textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Сообщение"
            rows="4"
            className="input"
          />
          <button className="btn-primary">Отправить</button>
        </form>
      </Modal>
    </MobileShell>
  );
}
