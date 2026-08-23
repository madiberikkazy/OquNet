import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { useCommunity } from "../../../contexts/CommunityContext.jsx";
import {
  createLeaveRequest,
  getPendingLeaveRequest,
  createNotification,
} from "../../../firebase/firestore.js";
import { checkCommunityExit, exitBlockMessage } from "../../../utils/communityExit.js";
import { t } from "../../../utils/i18n.js";

/**
 * Рөл және қоғамдастық — where a reader founds a community, and where a member
 * asks to leave one.
 *
 * There is no view switch here any more. An admin uses the same four tabs as
 * everyone else and manages their community on the community's own page, so the
 * only thing "role" still means on this screen is whether founding one is on
 * offer.
 */
export default function CommunitySettings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { community } = useCommunity();

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
        title: t.requestSentNotifTitle,
        body: t.leaveRequestSentNotifBody(community.name),
        read: false,
        type: "leave-request-sent",
        requestId: req.id,
        communityId: community.id,
        communityName: community.name,
      });

      // Notify the admin
      await createNotification({
        recipientId: community.ownerId,
        title: t.leaveRequestNotifTitle,
        body: t.leaveRequestNotifBody(user.nickname),
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
        {/* Nothing to switch — only, for a reader, an invitation to found one. */}
        {user?.role !== "admin" ? (
          <section>
            <h2 className="text-[15px] font-semibold mb-3">{t.role}</h2>
            <button onClick={() => navigate("/community/create")} className="btn-secondary">
              {t.becomeCommunityAdmin}
            </button>
            <p className="text-[12px] text-ink-500 mt-2">{t.becomeCommunityAdminNote}</p>
          </section>
        ) : null}

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

              {/* An admin doesn't leave their own community — they manage it,
                  and the community's own page is where that happens. */}
              {user?.role === "admin" ? (
                <button
                  onClick={() => navigate(`/community/${community.id}`)}
                  className="btn-secondary"
                >
                  {t.manageCommunity}
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
