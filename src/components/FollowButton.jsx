import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext.jsx";
import {
  createNotification, followUser, isFollowing, unfollowUser,
} from "../firebase/firestore.js";
import { qk } from "../lib/queryKeys.js";
import { logger } from "../utils/logger.js";
import { t } from "../utils/i18n.js";

/**
 * Follow / unfollow one person.
 *
 * Two states of one button rather than two buttons: filled while you are not
 * following — the thing to do — and outlined once you are, where it becomes the
 * way to undo. A separate "unfollow" control would have to be drawn somewhere
 * even when it means nothing.
 *
 * The state is one read at a known path (`follows/{me}__{them}`), so a profile
 * pays a single document for the button. It is held in local state on top of
 * that query and flipped *before* the write: following is a one-tap gesture and
 * a button that waits for a round trip to change reads as a button that didn't
 * work. A refused write puts the state back and says so.
 *
 * `onChange({ following, delta })` fires after a write that actually changed
 * something, so the screen around it can move the follower counter it is already
 * showing without refetching the whole profile. The counters on the two profile
 * *documents* are maintained by the data layer either way — this is only about
 * what is on screen right now.
 *
 * `compact` is the row-sized version, for a list of people where the button is
 * one of many; the default is the full-width one a profile has room for.
 *
 * `knownFollowing` is for exactly that case: a screen drawing many of these
 * already knows the whole answer — the viewer's own following list is one
 * query — and passing it in is what keeps a list of two hundred people from
 * costing two hundred reads to draw two hundred buttons. Left undefined, the
 * button asks for itself.
 */
export default function FollowButton({
  userId, onChange, compact = false, knownFollowing = undefined, className = "",
}) {
  const { user, setUser } = useAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // null until the query answers: an unknown state must not draw as "not
  // following", which is a button inviting a tap that may do nothing.
  const [optimistic, setOptimistic] = useState(null);

  const viewerId = user?.id ?? null;
  const selfProfile = !userId || !viewerId || viewerId === userId;

  const edgeQuery = useQuery({
    queryKey: qk.follows.edge(viewerId, userId),
    enabled: !selfProfile && knownFollowing === undefined,
    // Asked again every time the button appears. The app's default is to trust
    // the cache on mount, and that cache survives in IndexedDB for a day — long
    // enough for this button to open saying "follow" about somebody the reader
    // followed from another device yesterday.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => isFollowing(viewerId, userId),
  });

  // Nobody follows themselves — the data layer refuses it and the rules refuse
  // it, so the button that would ask is not drawn.
  if (selfProfile) return null;

  // Local state first, then whatever the screen already knew, then this
  // button's own read. Local state outranks the other two for good: it is the
  // result of a write this button made, and the list it came from may not have
  // caught up yet.
  const following = optimistic ?? knownFollowing ?? edgeQuery.data ?? false;

  // What the button waits for is an *answer*, not a successful one. A refused
  // or failed read used to leave it disabled forever — which is exactly what a
  // database whose follow rules have not been deployed yet looks like from
  // here, and it made the whole feature appear broken rather than
  // unauthorised. Reading whether you follow somebody and being allowed to
  // follow them are two different permissions; only the second one decides
  // whether the tap can work, and the only way to find that out is to let the
  // tap happen and report what comes back.
  const known = optimistic !== null
    || knownFollowing !== undefined
    || edgeQuery.isSuccess
    || edgeQuery.isError;

  async function toggle() {
    if (pending || !known) return;
    const next = !following;
    setOptimistic(next);
    setPending(true);
    setError("");
    try {
      const result = next
        ? await followUser({ followerId: viewerId, followingId: userId })
        : await unfollowUser({ followerId: viewerId, followingId: userId });

      if (result.changed) {
        // The reader's own profile is in context, not in the query cache, and
        // its `followingCount` is on screen the moment they navigate back to
        // it. Moved here rather than refetched: the data layer has already
        // written the same delta.
        setUser?.((prev) => (prev && prev.id === viewerId
          ? { ...prev, followingCount: Math.max(0, (prev.followingCount ?? 0) + (next ? 1 : -1)) }
          : prev));
        onChange?.({ following: next, delta: next ? 1 : -1 });

        if (next) await notifyFollowed({ user, userId });
      }

      // The lists behind both counters now have a row more or a row less.
      queryClient.invalidateQueries({ queryKey: qk.follows.followers(userId) });
      queryClient.invalidateQueries({ queryKey: qk.follows.following(viewerId) });
      queryClient.setQueryData(qk.follows.edge(viewerId, userId), result.following);
      // Held rather than cleared: what was written is now the truth, and
      // dropping back to a prop or a cached read here is how a button that
      // worked flickers back to its old label a moment later.
      setOptimistic(result.following);
    } catch (err) {
      logger.error("followButton.toggle", err?.message, { userId, code: err?.code });
      setOptimistic(null);
      setError(t.followFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        disabled={pending || !known}
        aria-pressed={following}
        className={
          "w-full font-semibold transition active:scale-[0.98] disabled:opacity-60 " +
          (compact ? "px-3 py-2 rounded-xl text-[13px] " : "py-3 rounded-2xl text-[15px] ") +
          (following
            ? "border border-brand-200 text-tintInk bg-tint"
            : "bg-brand-500 text-white")
        }
      >
        {following ? t.following : t.follow}
      </button>
      {error ? <p className="text-[12px] text-bad mt-1.5 text-center">{error}</p> : null}
    </div>
  );
}

/**
 * Tell somebody they have a new follower.
 *
 * Best-effort on purpose, and never in the way: the follow itself has already
 * happened by the time this runs, and a refused notification — a recipient who
 * has since deleted their account, an offline moment — is not a reason to tell
 * the reader their tap failed.
 */
async function notifyFollowed({ user, userId }) {
  const name = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim() || `@${user?.nickname ?? ""}`;
  await createNotification({
    recipientId: userId,
    title: t.followNotifTitle,
    body: t.followNotifBody(name),
    read: false,
    type: "follow",
    // The rules allow a sender to be named only when it is the caller, which is
    // what lets the notification screen link back to the person who followed.
    senderId: user?.id,
  }).catch((err) => logger.warn("followButton.notify", err?.message, { userId }));
}
