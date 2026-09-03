import { useCallback, useState } from "react";
import { shareLink } from "../native/share.js";
import { publicUrl } from "../native/platform.js";
import { t } from "./i18n.js";

/**
 * Share the profile — the action, without the button around it.
 *
 * The OS share sheet where there is one — on a phone that is the whole point,
 * since it is the sheet the reader already knows. Everywhere else the link goes
 * to the clipboard and the caller says so for a moment, because a share button
 * that appears to do nothing is worse than no share button. Which of the three
 * happens is native/share.js's problem, not this hook's.
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
    // `publicUrl`, not `window.location.origin`: inside the store builds the
    // origin is the WebView's own scheme, and a `capacitor://localhost/users/…`
    // link pasted into a chat is dead on arrival for whoever receives it.
    const url = publicUrl(`/users/${user.id}`);
    const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || `@${user.nickname ?? ""}`;

    const result = await shareLink({ title: name, text: t.shareProfileText(name), url });
    // Only the clipboard needs saying out loud. A sheet that opened is its own
    // feedback, and a sheet the reader dismissed wanted nothing to happen.
    if (result === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }, [user]);

  return { share, copied };
}
