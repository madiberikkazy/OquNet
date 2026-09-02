import { useSearchParams } from "react-router-dom";
import CoReadTabs from "../../components/CoReadTabs.jsx";
import ReadTogetherOnline from "./ReadTogetherOnline.jsx";
import ReadTogetherOffline from "./ReadTogetherOffline.jsx";

/**
 * Reading with other people, in the two places it can happen.
 *
 *   online  — a room on a screen: a circle of avatars, a shared clock, and
 *             minutes that count towards the same total the solo timer feeds.
 *   offline — an arrangement to be in the same real place at the same time,
 *             which ends in a chat and a chair rather than in a timer.
 *
 * One route with a tab rather than two routes, because they are two answers to
 * one question — "who can I read with right now?" — and a reader who finds
 * nobody online should be one tap from the other kind, not one Back and a
 * different menu.
 *
 * ── Why the tab lives in the URL ────────────────────────────────────────────
 * `?tab=offline` rather than a `useState`. This screen is left constantly and
 * on purpose: joining a meet-up opens a chat, and tapping a face opens a
 * profile. Coming back has to land on the tab that was left, and the browser's
 * own Back button is what is doing the coming back — so the tab has to be part
 * of the entry it restores. `replace` keeps switching tabs out of the history:
 * a tab is a view of one screen, and three taps between them should not be
 * three presses of Back to get out.
 *
 * Each half renders its own MobileShell rather than this file rendering one
 * around them. The two need different chrome — one has a search field in a
 * sticky header and an avatar picker in a bottom bar, the other has a sheet and
 * a single button — and a shell with every slot passed up through props would
 * be a component that exists only to be configured out of the way.
 */
export default function ReadTogether() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "offline" ? "offline" : "online";

  const tabs = (
    <CoReadTabs
      value={tab}
      onChange={(next) => {
        const updated = new URLSearchParams(params);
        if (next === "offline") updated.set("tab", "offline");
        else updated.delete("tab");
        setParams(updated, { replace: true });
      }}
    />
  );

  return tab === "offline"
    ? <ReadTogetherOffline tabs={tabs} />
    : <ReadTogetherOnline tabs={tabs} />;
}
