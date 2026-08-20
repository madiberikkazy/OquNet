import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MobileShell from "../../components/MobileShell.jsx";
import EmptyState from "../../components/EmptyState.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useCommunity } from "../../contexts/CommunityContext.jsx";
import { createPost } from "../../firebase/firestore.js";
import { logger } from "../../utils/logger.js";
import { writeError } from "../../utils/writeError.js";
import { t } from "../../utils/i18n.js";

/**
 * Writing a post — a screen, not a dialog.
 *
 * It began as a modal over the feed and that was wrong twice over. Writing is
 * the one thing on this app you do at length: a box you can only see half of,
 * with the feed showing around it, is a worse place to compose than a page of
 * your own. And a modal here is fragile in a way that is invisible until it
 * breaks — `MobileShell` wraps its children in a transformed element, so a
 * `position: fixed` overlay rendered among them is pinned to the feed's box
 * rather than to the window, which is exactly how this one ended up hanging off
 * the top of the screen.
 *
 * A route also means the back gesture cancels it, the keyboard has the screen to
 * itself, and a half-written post survives a mis-tap the way any other page does.
 */
export default function CreatePost() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { community, loading } = useCommunity();

  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (busy || !body.trim() || !community?.id || !user?.id) return;
    setBusy(true);
    setError("");
    try {
      await createPost({
        communityId: community.id,
        authorId: user.id,
        authorName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`,
        // Denormalised from the community, and checked against it by the rules:
        // a private community's posts stay off the discovery feed, and a member
        // cannot decide otherwise by sending a different value.
        isPublic: !community.isPrivate,
        body: body.trim(),
      });
      // Home rather than back: the post is on the feed now, and the feed is a
      // live subscription, so landing there shows the thing that was just
      // written instead of whatever screen happened to be underneath.
      navigate("/", { replace: true });
    } catch (err) {
      logger.error("createPost", err?.message, { code: err?.code });
      setError(writeError(err));
      setBusy(false);
    }
  }

  // A post is addressed to a community, so there has to be one. The "+" is not
  // drawn without one — this is for somebody who arrived by URL, and for the
  // moment between signing in and the community loading.
  if (!loading && !community?.id) {
    return (
      <MobileShell withNav={false}>
        <Header onBack={() => navigate(-1)} />
        <EmptyState title={t.newPost} subtitle={t.postNeedsCommunity} />
        <div className="px-4">
          <Link to="/community/join" className="btn-primary block text-center">{t.findCommunity}</Link>
        </div>
      </MobileShell>
    );
  }

  return (
    <MobileShell withNav={false}>
      <Header onBack={() => !busy && navigate(-1)} />

      <form onSubmit={submit} className="px-4 mt-2 space-y-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t.postBody}
          rows="10"
          className="input"
          autoFocus
        />

        {/* Which community this is going to, said out loud. The feed mixes
            several, so "post" started from there is ambiguous in a way it never
            was on a community's own page. */}
        <p className="text-[12px] text-ink-500">
          {t.postingTo(community?.nickname ? `@${community.nickname}` : community?.name ?? "")}
        </p>

        {error ? <p className="text-bad text-[13px]">{error}</p> : null}

        <button disabled={busy || !body.trim()} className="btn-primary">
          {busy ? "…" : t.publish}
        </button>
      </form>
    </MobileShell>
  );
}

function Header({ onBack }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <button onClick={onBack} aria-label={t.back} className="icon-btn shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <h1 className="text-[18px] font-bold flex-1 truncate">{t.newPost}</h1>
    </div>
  );
}
