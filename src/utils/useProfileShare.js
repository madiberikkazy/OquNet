import { useCallback, useState } from "react";
import { logger } from "./logger.js";
import { t } from "./i18n.js";

/**
 * Share the profile — the action, without the button around it.
 *
 * `navigator.share` where it exists — on a phone that is the whole point, since
 * it opens the OS sheet the reader already knows. Everywhere else the link goes
 * to the clipboard and the caller says so for a moment, because a share button
 * that appears to do nothing is worse than no share button.
 *
 * A hook rather than a component because the same act is drawn two ways: a
 * full-width button on the reader's own profile, where it stands in the place a
 * message button takes on somebody else's, and a row in the "⋮" menu on theirs.
 * How it is drawn is a styling question — sharing is one behaviour, and two
 * copies of the clipboard fallback would be two places for it to drift apart.
 *
 * It lives in utils/ rather than beside those buttons because the menu that
 * needs it is built by the screen, not by the header: a slot the header renders
 * cannot also decide what goes in it.
 */
export function useProfileShare(user) {
  const [copied, setCopied] = useState(false);

  const share = useCallback(async () => {
    if (!user?.id) return;
    const url = `${window.location.origin}/users/${user.id}`;
    const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: name, text: t.shareProfileText(name), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // A cancelled share sheet rejects exactly like a failure does, and it is
      // by far the more common of the two — so this is logged, never surfaced.
      logger.warn("profile.share", err?.message);
    }
  }, [user]);

  return { share, copied };
}
