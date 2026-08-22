import { useQuery } from "@tanstack/react-query";
import {
  getBooksByIds, getCommunity, getUserById,
  listBooksHeldBy, listBorrowingsForUser, listPostsByAuthor,
} from "../firebase/firestore.js";
import { qk } from "../lib/queryKeys.js";
import { logger } from "./logger.js";

export const EMPTY_LISTS = Object.freeze({ held: [], reading: [], completed: [], saved: [], posts: [] });

/**
 * Fill in whatever a stored answer is missing.
 *
 * This exists because of a bug worth keeping the guard for. The query cache is
 * persisted to IndexedDB for a day, so a screen does not only read what *this*
 * build wrote — it reads what the build before it wrote, too. When this entry
 * gained a `posts` list and lost an `owned` one, every reader with a day-old
 * profile in their cache got an entry of the previous shape, and a screen that
 * did `lists.posts.length` on it threw before it drew anything. A crash on the
 * one screen you were trying to open, for a day, with nothing in the interface
 * to explain it.
 *
 * The buster in main.jsx is the blunt instrument for that and has been bumped.
 * This is the sharp one, and the reason to have both: a cache older than the
 * code is a normal condition, not an emergency, and the screen should survive
 * it whether or not somebody remembered to bump a constant.
 */
export function withCompleteLists(data) {
  if (!data) return data;
  return { ...data, lists: { ...EMPTY_LISTS, ...(data.lists || {}) } };
}

/**
 * Everything one member's profile shows, in one query.
 *
 * A hook rather than a block inside a screen because two screens need exactly
 * this: the profile itself and the list behind each of its counters. They share
 * the cache key as well as the code, so opening a counter draws instantly from
 * what the profile already fetched — and the count and the list it opens cannot
 * disagree, because they are the same array.
 *
 * The shelves are only asked for when the viewer is in the same community: what
 * somebody has on their shelf is their community's business, the rules say so,
 * and asking anyway is a denied query rather than a shorter answer. What they
 * have *published* is not community business in the same way — a post carries
 * its own audience — so from outside the query falls back to the public ones,
 * which is what this caller is allowed to see and therefore the honest thing to
 * show them.
 */
export function useMemberProfile(id, viewer) {
  return useQuery({
    queryKey: qk.profile.member(id, viewer?.communityId),
    enabled: !!id,
    // Show whatever was cached at once, then correct it. The app's default is
    // not to refetch on mount at all, and the cache outlives the session in
    // IndexedDB — which is fine for shelves and wrong for the follower count,
    // a number other people move while this reader is not looking.
    staleTime: 0,
    refetchOnMount: "always",
    // Runs over cached data as well as freshly fetched, which is the point:
    // what comes back from IndexedDB was written by whichever build was
    // installed yesterday.
    select: withCompleteLists,
    queryFn: async () => {
      const user = await getUserById(id);
      if (!user) return null;

      const community = user.communityId ? await getCommunity(user.communityId) : null;
      const sameCommunity = !!user.communityId && viewer?.communityId === user.communityId;

      if (!sameCommunity) {
        const posts = await listPostsByAuthor({ authorId: user.id }).catch((err) => {
          logger.error("memberProfile.posts", err?.message, { code: err?.code });
          return [];
        });
        return { user, community, sameCommunity, lists: { ...EMPTY_LISTS, posts } };
      }

      // One indexed query per question. This used to ask for a single page of
      // the community's books and sift it here, so a member whose books all sat
      // past the first thirty appeared to own nothing at all.
      const results = await Promise.allSettled([
        listBooksHeldBy({ communityId: user.communityId, userId: user.id }),
        listBorrowingsForUser(user.id, "active"),
        listBorrowingsForUser(user.id, "completed"),
        // Saved ids can outlive the community they were saved in, and a book is
        // readable only to members of its own — getBooksByIds drops the misses
        // rather than failing the batch.
        getBooksByIds(user.savedBookIds || []),
        listPostsByAuthor({ authorId: user.id, communityId: user.communityId }),
      ]);
      const sources = ["held", "reading", "completed", "saved", "posts"];
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error("memberProfile.lists", r.reason?.message, {
            code: r.reason?.code, source: sources[i],
          });
        }
      });
      const [held, reading, completed, saved, posts] = results.map((r) =>
        r.status === "fulfilled" ? r.value : []
      );
      return { user, community, sameCommunity, lists: { held, reading, completed, saved, posts } };
    },
  });
}
