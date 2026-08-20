import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MobileShell from "../../components/MobileShell.jsx";
import Avatar from "../../components/Avatar.jsx";
import FollowButton from "../../components/FollowButton.jsx";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { getUsersByIds, listFollowers, listFollowing } from "../../firebase/firestore.js";
import { qk } from "../../lib/queryKeys.js";
import { peerName } from "../../utils/chatPeer.js";
import { t } from "../../utils/i18n.js";

/**
 * The two lists behind the counters on a profile: who follows this person, and
 * who this person follows.
 *
 * One screen for both, chosen by `mode`, because they are the same list read
 * from opposite ends — same rows, same actions, same empty state, and the only
 * thing that differs is which end of the edge names the person to draw. Two
 * components would be one component and a copy of it.
 *
 * Whose profile it belongs to is in the URL, so this works for the reader's own
 * profile and for anybody else's without knowing which it is looking at. Each
 * row carries its own follow button — a list of people you follow is the
 * natural place to stop following one, and the button hides itself on the
 * reader's own row.
 */
export default function FollowList({ mode = "followers" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const followers = mode === "followers";

  // The edges. `createdAt` orders them, so the most recent follow is the first
  // row — the one somebody opening this screen came to see.
  //
  // Re-asked on every mount, and never treated as fresh. Both of the app's
  // global defaults are wrong for this screen: `refetchOnMount: false` plus a
  // cache persisted to IndexedDB for a day means a list that once came back
  // empty — or once failed — keeps drawing that answer for the rest of the
  // session, no matter what has happened since. This screen exists to answer
  // "who follows me *now*", and somebody opening it has usually just been told
  // that changed.
  const edgesQuery = useQuery({
    queryKey: followers ? qk.follows.followers(id) : qk.follows.following(id),
    enabled: !!id,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => (followers ? listFollowers(id) : listFollowing(id)),
  });

  // The person on the *other* end of each edge — the follower on a followers
  // list, the followed on a following one.
  const ids = useMemo(
    () => (edgesQuery.data ?? []).map((edge) => (followers ? edge.followerId : edge.followingId)).filter(Boolean),
    [edgesQuery.data, followers]
  );

  // One batch for the whole page rather than a query per row, keyed on the set
  // of ids — the same arrangement the chat list uses for its peers.
  const peopleQuery = useQuery({
    queryKey: qk.follows.people(ids.join(",")),
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: () => getUsersByIds(ids),
  });

  // Who the *viewer* follows, in one query, so the row buttons can be drawn
  // from it. Without this each row would ask the same question about itself and
  // a two-hundred-name list would cost two hundred reads to render. On the
  // reader's own "following" screen this is the very query above, under the
  // same key — React Query serves both from one fetch.
  const viewerFollowingQuery = useQuery({
    queryKey: qk.follows.following(user?.id),
    enabled: !!user?.id,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => listFollowing(user.id),
  });

  const viewerFollows = useMemo(
    () => new Set((viewerFollowingQuery.data ?? []).map((edge) => edge.followingId)),
    [viewerFollowingQuery.data]
  );

  const viewerListSettled = viewerFollowingQuery.isSuccess || viewerFollowingQuery.isError;

  const people = peopleQuery.data ?? {};
  const loading = edgesQuery.isLoading || (ids.length > 0 && peopleQuery.isLoading);

  return (
    <MobileShell withNav={false}>
      <div className="flex items-center gap-2 px-4 pb-3">
        <button onClick={() => navigate(-1)} aria-label={t.back} className="icon-btn shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h1 className="text-[18px] font-bold flex-1 truncate">
          {followers ? t.followersTitle : t.followingTitle}
        </h1>
      </div>

      {loading ? (
        <ul>
          {[1, 2, 3].map((i) => (
            <li key={i} className="flex gap-3 px-4 py-3 border-b border-ink-100 animate-pulse">
              <div className="w-11 h-11 rounded-full bg-ink-100 shrink-0" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3 w-28 rounded bg-ink-100" />
                <div className="h-3 w-20 rounded bg-ink-100" />
              </div>
            </li>
          ))}
        </ul>
      ) : edgesQuery.isError ? (
        // Not the same thing as an empty list, and it used to draw as one: a
        // refused read, a missing index or a dropped connection all left this
        // screen calmly reporting that nobody follows you. Say what happened,
        // and offer the one thing that might fix it.
        <div className="px-6 py-12 text-center">
          <p className="text-ink-500 text-[14px]">{t.loadFailed}</p>
          <button
            type="button"
            onClick={() => edgesQuery.refetch()}
            className="mt-3 pill bg-tint text-tintInk px-4 py-2"
          >
            {t.tryAgain}
          </button>
        </div>
      ) : ids.length === 0 ? (
        <p className="px-6 py-12 text-center text-ink-500 text-[14px]">
          {followers ? t.noFollowers : t.noFollowing}
        </p>
      ) : (
        <ul>
          {ids.map((personId) => {
            // A profile that has since been deleted still has an edge pointing
            // at it. The row draws with initials and a placeholder name rather
            // than disappearing, so the count and the list agree.
            const person = people[personId] ?? null;
            return (
              <li key={personId} className="flex items-center gap-3 px-4 py-3 border-b border-ink-100">
                <Link to={`/users/${personId}`} className="flex items-center gap-3 flex-1 min-w-0 active:opacity-70 transition">
                  <Avatar src={person?.photoURL} name={peerName(person)} size={44} />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-[15px] truncate">{peerName(person)}</span>
                    {person?.nickname ? (
                      <span className="block text-[13px] text-ink-500 truncate">@{person.nickname}</span>
                    ) : null}
                  </span>
                </Link>
                {/* No button until the viewer's own list has answered: drawn
                    from nothing it would say "follow" to people they already
                    follow, and a wrong label is worse than a late one.

                    An answer that failed still counts as one — the button is
                    handed no `knownFollowing` in that case and falls back to
                    asking about itself, rather than never appearing at all. */}
                {person && person.id !== user?.id && viewerListSettled ? (
                  <FollowButton
                    userId={person.id}
                    knownFollowing={
                      viewerFollowingQuery.isSuccess ? viewerFollows.has(person.id) : undefined
                    }
                    compact
                    className="w-[116px] shrink-0"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </MobileShell>
  );
}
