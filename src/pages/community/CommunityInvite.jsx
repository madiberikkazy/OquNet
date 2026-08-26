import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { useLang } from "../../contexts/LanguageContext.jsx";
import {
  acceptCommunityInvite, declineCommunityInvite,
  getActiveBorrowingForUser, getCommunity, getRequestById,
} from "../../firebase/firestore.js";
import { evaluateExit, exitBlockMessage, loadExitBooks } from "../../utils/communityExit.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../utils/i18n.js";
import Loading from "../../components/Loading.jsx";

/**
 * Where an invitation link lands.
 *
 * The link in the chat does not join anybody. It opens this, and this joins —
 * one tap, on a screen that has said which community and what it costs. That
 * distinction is the whole design: accepting an invitation moves a person out
 * of the community they are in, and this app allows exactly one at a time, so
 * a tap that joined on arrival would be an irreversible move made by a tap on a
 * message. A chat is somewhere people tap things to read them.
 *
 * It is also where the invitation is *checked*. The rules already refuse an
 * invitation that names somebody else, one that has been spent, and one that
 * was not written by an admin — but a rule can only refuse, and "permission
 * denied" is not an answer to "why can I not join?". Each of those cases gets
 * its own sentence here.
 */
export default function CommunityInvite() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { community, setCommunity } = useCommunity();
  useLang();

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // "accepted" | "declined"
  const [error, setError] = useState("");

  const inviteQuery = useQuery({
    queryKey: ["invite", requestId],
    enabled: !!requestId,
    queryFn: async () => {
      const request = await getRequestById(requestId);
      if (!request) return null;
      // The community is read separately rather than trusted from the copy on
      // the invitation: the name on a document written days ago is the name it
      // had then, and joining under an old one is a small lie on the one screen
      // where the reader is deciding.
      const target = await getCommunity(request.communityId);
      return { request, target };
    },
  });

  // What the reader would have to settle before they could leave where they
  // are. Only asked when they are somewhere — an invitee with no community has
  // nothing to settle, and this is a pair of queries not worth making.
  const exitQuery = useQuery({
    queryKey: ["invite", "exit", user?.id, community?.id],
    enabled: !!user?.id && !!community?.id,
    queryFn: async () => {
      const [books, activeBorrowing] = await Promise.all([
        loadExitBooks({ userId: user.id, communityId: community.id }),
        getActiveBorrowingForUser(user.id),
      ]);
      return evaluateExit({ activeBorrowing, books, userId: user.id });
    },
  });

  const invite = inviteQuery.data?.request;
  const target = inviteQuery.data?.target;

  // Every reason this invitation cannot be acted on, in the order they matter.
  // Computed rather than branched in the markup so the button and the sentence
  // can never disagree about whether joining is possible.
  const refusal = (() => {
    if (inviteQuery.isLoading) return null;
    if (!invite || invite.type !== "invite") return t.inviteNotFound;
    if (invite.userId !== user?.id) return t.inviteNotForYou;
    if (invite.status !== "approved") return t.inviteSpent;
    if (community?.id === invite.communityId) return t.inviteAlreadyMember;
    // Leaving is a settlement, and it is the same settlement the leave screen
    // enforces — an invitation is not a way around returning the books you are
    // holding.
    if (community?.id && exitQuery.data && !exitQuery.data.canLeave) {
      return exitBlockMessage(exitQuery.data.blockedBy);
    }
    return null;
  })();

  async function accept() {
    setBusy(true);
    setError("");
    try {
      await acceptCommunityInvite({
        userId: user.id,
        requestId,
        communityId: invite.communityId,
      });
      await refresh();
      setCommunity(await getCommunity(invite.communityId));
      setDone("accepted");
    } catch (err) {
      logger.error("communityInvite.accept", err?.message, { code: err?.code });
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError("");
    try {
      await declineCommunityInvite(requestId);
      setDone("declined");
    } catch (err) {
      logger.error("communityInvite.decline", err?.message, { code: err?.code });
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="flex items-center gap-2 pb-2">
      <button onClick={() => navigate(-1)} className="icon-btn shrink-0" aria-label={t.back}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <h1 className="text-lg font-semibold flex-1 truncate">{t.inviteScreenTitle}</h1>
    </div>
  );

  if (inviteQuery.isLoading) {
    return (
      <MobileShell withNav={false} header={header}>
        <Loading />
      </MobileShell>
    );
  }

  if (done) {
    return (
      <MobileShell withNav={false} header={header}>
        <div className="px-6 py-12 text-center space-y-4">
          <p className="text-[16px] font-semibold">
            {done === "accepted" ? t.inviteAccepted : t.inviteDeclined}
          </p>
          <button onClick={() => navigate("/", { replace: true })} className="btn-primary">
            {t.goHome}
          </button>
        </div>
      </MobileShell>
    );
  }

  if (!invite || invite.type !== "invite") {
    return (
      <MobileShell withNav={false} header={header}>
        <EmptyState title={t.inviteNotFound} />
      </MobileShell>
    );
  }

  const canAccept = !refusal;

  return (
    <MobileShell withNav={false} header={header}>
      <div className="px-4 pt-2 space-y-5">
        <div className="card px-4 py-5 flex flex-col items-center text-center gap-3">
          <Avatar src={target?.photoUrl} name={target?.name || invite.communityName} size={72} />
          <div>
            <p className="text-[18px] font-bold">{target?.name || invite.communityName}</p>
            {invite.invitedByName ? (
              <p className="text-[13px] text-ink-500 mt-1">{t.inviteFrom(invite.invitedByName)}</p>
            ) : null}
          </div>
        </div>

        {/* Said before the button, not after it: leaving the community you are
            in is the part of accepting that nobody expects, and a warning that
            appears once the move is made is not a warning. */}
        {canAccept && community?.id ? (
          <p className="text-[13px] text-ink-500 px-1">
            {t.inviteLeaveWarning(community.name)}
          </p>
        ) : null}

        {refusal ? (
          <p className="text-[14px] text-ink-700 bg-ink-100 rounded-2xl px-4 py-3">{refusal}</p>
        ) : null}

        {error ? <p className="text-bad text-[13px] px-1">{error}</p> : null}

        <div className="space-y-2 pt-1">
          <button
            onClick={accept}
            disabled={!canAccept || busy}
            className="btn-primary disabled:opacity-60"
          >
            {busy ? t.loading : t.inviteAcceptAction}
          </button>
          <button onClick={decline} disabled={busy} className="btn-secondary">
            {t.inviteDeclineAction}
          </button>
        </div>
      </div>
    </MobileShell>
  );
}
