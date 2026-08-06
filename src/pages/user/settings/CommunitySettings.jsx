import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { useCommunity } from "../../../contexts/CommunityContext.jsx";
import {
  getActiveBorrowingForUser,
  createLeaveRequest,
  getPendingLeaveRequest,
  createNotification,
} from "../../../firebase/firestore.js";
import { checkCommunityExit, exitBlockMessage } from "../../../utils/communityExit.js";
import { t } from "../../../utils/i18n.js";

/** Роль и сообщество — switching view mode, and asking to leave. */
export default function CommunitySettings() {
  const navigate = useNavigate();
  const { user, switchView } = useAuth();
  const { community } = useCommunity();

  // ── Role switch ─────────────────────────────────────────────────────────────
  const [roleSwitching, setRoleSwitching] = useState(false);
  const [roleError, setRoleError] = useState("");

  async function trySwitchRole() {
    if (roleSwitching || !user) return;
    setRoleSwitching(true);
    setRoleError("");
    try {
      if (user.role === "admin") {
        // An admin browsing as a user could otherwise strand a borrowed book in
        // a mode that has no way to return it.
        const active = await getActiveBorrowingForUser(user.id).catch(() => null);
        if (active) { setRoleError(t.returnBookFirst); return; }
        switchView();
        navigate("/", { replace: true });
      } else {
        navigate("/community/create");
      }
    } catch (err) {
      setRoleError(err?.message || t.error);
    } finally {
      setRoleSwitching(false);
    }
  }

  // ── Leave community ─────────────────────────────────────────────────────────
  const [leaveState, setLeaveState] = useState("idle"); // "idle" | "pending"
  const [leaveBusy, setLeaveBusy]   = useState(false);
  const [leaveError, setLeaveError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (user?.communityId) {
      getPendingLeaveRequest(user.id)
        .then((r) => { if (r && !cancelled) setLeaveState("pending"); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [user?.id, user?.communityId]);

  async function handleLeave() {
    if (leaveBusy || leaveState !== "idle" || !community) return;
    setLeaveBusy(true);
    setLeaveError("");
    try {
      // Asking to leave is held to the same rules as leaving: a request that
      // could never be honoured only puts the decision in the admin's lap.
      const verdict = await checkCommunityExit({
        userId: user.id,
        communityId: community.id,
      });
      if (!verdict.canLeave) {
        setLeaveError(exitBlockMessage(verdict.blockedBy));
        return;
      }

      const req = await createLeaveRequest({
        userId: user.id,
        userNickname: user.nickname,
        userName: `${user.firstName} ${user.lastName}`,
        communityId: community.id,
      });

      // Notify the user themselves
      await createNotification({
        recipientId: user.id,
        title: "Өтінішіңіз жіберілді",
        body: `«${community.name}» қоғамдастығынан шығу өтінішіңіз администраторға жіберілді. Жауап күтіңіз.`,
        read: false,
        type: "leave-request-sent",
        requestId: req.id,
        communityId: community.id,
        communityName: community.name,
      });

      // Notify the admin
      await createNotification({
        recipientId: community.ownerId,
        title: "Қоғамдастықтан шығу өтінімі",
        body: `@${user.nickname} қоғамдастықтан шығуға өтініш берді.`,
        read: false,
        type: "leave-request",
        requestId: req.id,
        communityId: community.id,
        userId: user.id,
        userNickname: user.nickname,
        userName: `${user.firstName} ${user.lastName}`,
      });

      setLeaveState("pending");
    } catch (err) {
      setLeaveError(err?.message || t.error);
    } finally {
      setLeaveBusy(false);
    }
  }

  return (
    <SettingsPage title={t.roleAndCommunity}>
      <div className="px-5 pt-4 space-y-7">
        {/* ── Role ─────────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-[15px] font-semibold mb-3">{t.role}</h2>
          <button onClick={trySwitchRole} disabled={roleSwitching} className="btn-secondary">
            {roleSwitching ? "…" : user?.role === "admin" ? t.switchToUser : t.switchToAdmin}
          </button>
          <p className="text-[12px] text-ink-500 mt-2">
            {user?.role === "admin" ? t.adminNote : t.userNote}
          </p>
          {roleError ? <p className="text-[13px] text-bad mt-2">{roleError}</p> : null}
        </section>

        {/* ── Community ────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-[15px] font-semibold mb-1">{t.community}</h2>

          {!community ? (
            <>
              <p className="text-[13px] text-ink-500 mb-3">{t.notInCommunity}</p>
              <button onClick={() => navigate("/community/join")} className="btn-primary">
                {t.findCommunity}
              </button>
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink-500 mb-4">{community.name}</p>

              {/* An admin doesn't leave their own community — they open it. */}
              {user?.role === "admin" ? (
                <button
                  onClick={() => navigate(`/community/${community.id}`)}
                  className="btn-secondary"
                >
                  {t.community}
                </button>
              ) : leaveState === "pending" ? (
                <div className="rounded-2xl bg-ink-100 px-4 py-3 text-[13px] text-ink-500 text-center">
                  {t.leavePending}
                </div>
              ) : (
                <>
                  <button
                    onClick={handleLeave}
                    disabled={leaveBusy}
                    className="w-full text-left rounded-xl bg-badSoft text-bad font-semibold py-3 px-4 disabled:opacity-60"
                  >
                    {leaveBusy ? "…" : t.leaveCommunity}
                  </button>
                  {leaveError ? (
                    <div className="mt-2 rounded-xl bg-badSoft px-4 py-2.5">
                      <p className="text-[13px] text-bad leading-relaxed">{leaveError}</p>
                      <button
                        onClick={() => navigate("/profile/owned")}
                        className="mt-1 text-[13px] font-semibold text-bad underline underline-offset-2"
                      >
                        {t.openHeldBooks}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </SettingsPage>
  );
}
