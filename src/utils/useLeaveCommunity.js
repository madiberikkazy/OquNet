import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  deleteBook, listBooksOwnedBy, updateUser,
} from "../firebase/firestore.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useCommunity } from "../contexts/CommunityContext.jsx";
import { qk } from "../lib/queryKeys.js";
import { invalidateReturnRequest } from "../lib/bookCaches.js";
import { checkCommunityExit, exitBlockMessage } from "./communityExit.js";
import { logger } from "./logger.js";

/**
 * The exit itself, in one place — because there is more than one screen that
 * can be standing at the door.
 *
 * A member reaches this from the leave screen, and also from the moment they
 * collect the last of their books, which is a different screen entirely. Both
 * have to do exactly the same three things in exactly the same order, and a
 * second copy of them is how one of the two ends up leaving a book behind:
 *
 *   1. re-check the rules against the server. The screen's verdict is drawn
 *      from queries that may be seconds or minutes old, and the whole point of
 *      `communityExit.js` is that it holds at the moment of the write;
 *   2. delete every book the member owns *here* — read fresh, for the same
 *      reason, and not taken from whatever list the screen happened to render;
 *   3. drop the membership, then push both contexts so the profile re-renders
 *      without waiting on a round-trip.
 *
 * Books are deleted before the membership is dropped, so the deletes still pass
 * the security rules that ask the caller to be a member of the book's community.
 */
export function useLeaveCommunity(communityId) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, setUser } = useAuth();
  const { setCommunity } = useCommunity();

  return useMutation({
    mutationFn: async () => {
      const verdict = await checkCommunityExit({ userId: user.id, communityId });
      if (!verdict.canLeave) {
        const err = new Error(exitBlockMessage(verdict.blockedBy));
        err.blockedBy = verdict.blockedBy;
        throw err;
      }

      const owned = await listBooksOwnedBy({ communityId, userId: user.id });
      await Promise.all(owned.map((b) => deleteBook(b.id).catch((err) => {
        logger.error("leave.deleteBook", err?.message, { bookId: b.id });
      })));
      await updateUser(user.id, { communityId: null });
    },
    onSuccess: () => {
      setUser({ ...user, communityId: null });
      setCommunity(null);

      queryClient.removeQueries({ queryKey: ["community", communityId] });
      queryClient.invalidateQueries({ queryKey: qk.books.all });
      queryClient.invalidateQueries({ queryKey: qk.profile.stats(user.id) });
      invalidateReturnRequest();

      navigate("/community/join", { replace: true });
    },
  });
}
