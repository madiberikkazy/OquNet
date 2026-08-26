import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import SettingsPage from "../../../components/SettingsPage.jsx";
import Modal from "../../../components/Modal.jsx";
import { useAuth } from "../../../contexts/AuthContext.jsx";
import { auth, isFirebaseConfigured } from "../../../firebase/config.js";
import { checkCommunityExit, exitBlockMessage } from "../../../utils/communityExit.js";
import { t } from "../../../utils/i18n.js";
import Loading from "../../../components/Loading.jsx";

/**
 * Удалить аккаунт.
 *
 * Deletion is gated by the same settlement the community exit is: someone who
 * still holds another member's book cannot make themselves unreachable by
 * deleting the account. Admins are refused outright — their community's
 * ownerId would point at nobody.
 */
export default function DeleteAccount() {
  const navigate = useNavigate();
  const { user, deleteAccount } = useAuth();

  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(null); // null = still checking

  const isAdmin = user?.role === "admin";
  // A Google account has no password to type; re-auth happens in the popup.
  const usesPassword =
    !isFirebaseConfigured ||
    (auth?.currentUser?.providerData || []).some((p) => p.providerId === "password");

  // The books check is read fresh — a cached list minutes old is not a basis
  // for an irreversible action.
  useEffect(() => {
    let cancelled = false;
    if (isAdmin) { setBlocked(t.deleteAccountAdminBlocked); return; }
    if (!user?.communityId) { setBlocked(""); return; }

    checkCommunityExit({ userId: user.id, communityId: user.communityId })
      .then((verdict) => {
        if (cancelled) return;
        setBlocked(verdict.canLeave ? "" : exitBlockMessage(verdict.blockedBy));
      })
      .catch(() => { if (!cancelled) setBlocked(""); });

    return () => { cancelled = true; };
  }, [user?.id, user?.communityId, isAdmin]);

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteAccount({ password });
      setConfirming(false);
      navigate("/auth/login", { replace: true });
    } catch (err) {
      setConfirming(false);
      setError(err?.message || t.error);
    } finally {
      setBusy(false);
    }
  }

  const checking = blocked === null;
  const canDelete = blocked === "" && (!usesPassword || password.length > 0);

  return (
    <SettingsPage title={t.deleteAccount}>
      <div className="px-5 pt-4">
        <div className="rounded-2xl bg-badSoft px-4 py-3.5 mb-5">
          <p className="text-[13px] text-bad leading-relaxed">{t.deleteAccountWarning}</p>
        </div>

        {checking ? (
          <Loading size={64} className="py-4" />
        ) : blocked ? (
          <>
            <p className="text-[14px] text-ink-700 leading-relaxed">{blocked}</p>
            {!isAdmin ? (
              <button
                onClick={() => navigate("/profile/owned")}
                className="btn-secondary mt-4"
              >
                {t.openHeldBooks}
              </button>
            ) : null}
          </>
        ) : (
          <>
            {usesPassword ? (
              <label className="block mb-4">
                <span className="text-[12px] text-ink-500 mb-1 block">
                  {t.deleteAccountPasswordLabel}
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="input"
                />
              </label>
            ) : null}

            {error ? <p className="text-[13px] text-bad mb-3">{error}</p> : null}

            <button
              onClick={() => setConfirming(true)}
              disabled={!canDelete || busy}
              className="w-full font-semibold rounded-xl py-3.5 bg-badSoft text-bad transition disabled:opacity-50"
            >
              {t.deleteAccountConfirm}
            </button>
          </>
        )}
      </div>

      <Modal
        open={confirming}
        onClose={() => (busy ? null : setConfirming(false))}
        title={t.deleteAccountConfirm}
      >
        <p className="text-[13px] text-ink-500 leading-relaxed mb-4">
          {t.deleteAccountWarning}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="btn-secondary"
          >
            {t.cancel}
          </button>
          <button
            onClick={confirmDelete}
            disabled={busy}
            className="w-full font-semibold rounded-xl py-3.5 bg-badSoft text-bad transition disabled:opacity-60"
          >
            {busy ? "…" : t.delete}
          </button>
        </div>
      </Modal>
    </SettingsPage>
  );
}
