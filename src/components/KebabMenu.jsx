import { useEffect, useRef, useState } from "react";
import { t } from "../utils/i18n.js";

/**
 * The "⋮" and the short list of things it opens.
 *
 * It exists because a post's management controls had outgrown the place they
 * were drawn. Edit and delete used to be two coloured buttons sitting in the
 * post's own row, which works while a post is a line in a list and stops
 * working the moment it becomes a card with a name, a date and an action row:
 * two more buttons in that corner is four controls competing for the one place
 * a reader's eye goes first, and the destructive one was the loudest thing on
 * the page. Behind a menu they are one quiet control, and delete gets a colour
 * that means something again because it is the only red thing in the sheet.
 *
 * `items` is `{ label, onClick, danger }`. Closing happens on pick, on Escape,
 * and on a pointer down anywhere outside — `pointerdown` rather than `click`
 * so a tap that lands on something else does not both close this and press
 * that, which on touch is the difference between dismissing a menu and
 * accidentally opening whatever was underneath it.
 */
export default function KebabMenu({
  items = [], ariaLabel = t.moreActions,
  /**
   * The trigger's look. Defaults to the quiet grey that suits a card; the
   * profile banner passes the white-on-translucent one its own corner buttons
   * wear, so the "⋮" there is the same object as the back arrow opposite it
   * rather than a grey smudge on a blue field.
   */
  triggerClassName = "w-8 h-8 -mr-1.5 -my-1 rounded-lg text-ink-400",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (!ref.current?.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!items.length) return null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName + " flex items-center justify-center active:scale-90 transition"}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5"  r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 min-w-[9rem] rounded-xl bg-surface border border-ink-100 shadow-lg overflow-hidden"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onClick?.(); }}
              className={
                "w-full text-left px-4 py-2.5 text-[14px] font-medium transition active:bg-ink-100 " +
                (item.danger ? "text-bad" : "text-ink-900")
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
