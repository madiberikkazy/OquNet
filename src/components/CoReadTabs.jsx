import { t } from "../utils/i18n.js";

/**
 * Online / Offline — the two ways of reading with somebody else.
 *
 * A segmented control rather than two links, because these are two views of one
 * question ("who can I read with right now?") and not two places to go. The
 * difference between them is where the other person is: online is a circle of
 * avatars and a shared clock, offline is a real chair in a real room.
 *
 * The selected half is marked by a pane that *slides* between the two. That is
 * the whole animation and it is doing a job: a highlight that simply appears on
 * the other side leaves the eye to work out that something moved, while one that
 * travels tells you where it went from and where it got to. It is a transform on
 * a single absolutely-positioned element — the labels never move, so nothing
 * reflows, and the two texts stay exactly where they were while it passes under
 * them.
 */
export default function CoReadTabs({ value, onChange, className = "" }) {
  const tabs = [
    { key: "online", label: t.coReadOnlineTab },
    { key: "offline", label: t.coReadOfflineTab },
  ];
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === value));

  return (
    <div
      role="tablist"
      aria-label={t.coReadTitle}
      className={"relative flex p-1 rounded-2xl bg-ink-100 " + className}
    >
      {/* The travelling pane. Sized as a fraction of the track less the
          padding, and moved by whole multiples of its own width, so it lands
          exactly under a label however wide the screen is — no measuring, and
          nothing to re-measure when the language changes the label lengths. */}
      <span
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-1 rounded-xl bg-surface shadow-soft"
        style={{
          width: `calc((100% - 0.5rem) / ${tabs.length})`,
          transform: `translateX(${index * 100}%)`,
          transition: "transform 320ms cubic-bezier(0.22, 0.9, 0.32, 1)",
        }}
      />

      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange?.(tab.key)}
            className={
              "relative flex-1 rounded-xl py-2 text-[14px] font-semibold transition-colors duration-200 " +
              (selected ? "text-ink-900" : "text-ink-500")
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
