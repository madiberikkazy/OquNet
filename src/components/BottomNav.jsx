import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext.jsx";
import { useChats } from "../contexts/ChatContext.jsx";
import { useNotifications } from "../contexts/NotificationContext.jsx";
import { navIconSrc } from "../utils/icons.js";
import { t } from "../utils/i18n.js";

/**
 * The four tabs, under a bead of glass.
 *
 * The icons are files under public/drawable, two per tab — one for the selected
 * state and one for the rest — rather than inline SVG tinted by `currentColor`.
 * Artwork stops being code: replacing an icon everywhere is overwriting one
 * file, and a selected tab is free to be a different drawing rather than the
 * same drawing in a different colour. The label keeps its colour from the
 * theme, so the two halves of a tab still agree without the icon knowing
 * anything about the palette.
 *
 * ── The lens ────────────────────────────────────────────────────────────────
 * What marks the selected tab is a lens that slides, and the two words are both
 * load-bearing.
 *
 * *Lens*, because it is drawn over the tabs rather than behind them. A pill
 * behind the icon is a highlight; glass in front of it refracts what it covers,
 * and that is the effect being copied here — the icon brightens and the label
 * goes soft under the rim. See `.nav-lens` in index.css for how the three
 * layers build that up.
 *
 * *Slides*, because the movement carries the meaning. Selection is a thing that
 * travelled from one tab to another, and a highlight that blinks out here and
 * on again there makes the reader find it twice. It overshoots very slightly
 * and stretches along the way — a blob of liquid does both, and the stretch is
 * what stops a fast tap across three tabs looking like a teleport.
 *
 * ── Dragging ────────────────────────────────────────────────────────────────
 * The lens can also be dragged. It is a small thing to implement and it is what
 * makes the bar feel like an object rather than four buttons: the glass follows
 * the finger, and lets go onto whichever tab it is nearest.
 *
 * Deliberately scoped to the bar itself and not to the page. A horizontal swipe
 * anywhere on a screen would fight the shelf rails and the coverflow, which
 * scroll sideways on purpose; here there is nothing to fight.
 */
/**
 * Where the lens was last left, in tab units.
 *
 * Module level, and it has to be: every screen renders its own MobileShell, so
 * every navigation tears this component down and builds a new one. A position
 * held in state would be born equal to the tab that was just opened, the lens
 * would be painted at its destination on the very first frame, and there would
 * be nothing left to animate — which is exactly what it did before this
 * existed. Kept out here, a fresh tab bar knows where the old one's lens was
 * and can travel from it.
 */
let lastLensIndex = 0;

/** How long the lens takes to cross, and how far a finger must move to count. */
const TRAVEL_MS = 420;
const DRAG_SLOP = 6;

export default function BottomNav() {
  useLang(); // subscribe to language changes so labels re-render
  const { unreadTotal } = useChats();
  // Notifications are counted here as well as on Home, and that is the point.
  // The bell lives in the Home header, so it says nothing at all while you are
  // on Books or in a chat — which is exactly when something arriving needs to
  // be visible. The tab bar is on every screen, so the count goes there too and
  // Home is the tab that carries it, because Home is where the bell is.
  const { unreadCount } = useNotifications();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // One `count` per tab rather than a boolean and a single shared total: two
  // tabs carry a badge now, and they are counting different things.
  const items = [
    { to: "/", icon: "home", label: t.navHome, count: unreadCount },
    { to: "/books", icon: "books", label: t.navBooks },
    { to: "/chats", icon: "chats", label: t.navChats, count: unreadTotal },
    { to: "/profile", icon: "profile", label: t.navProfile },
  ];

  // Which tab the lens belongs over. Read from the path rather than from a
  // click, so it is right after a back gesture, a redirect, or a link followed
  // from somewhere else — all three of which change the tab without going
  // anywhere near this component.
  const activeIndex = Math.max(0, items.findIndex((it) =>
    it.to === "/" ? pathname === "/" : pathname.startsWith(it.to)
  ));

  const railRef = useRef(null);
  const lensRef = useRef(null);
  // Set for the instant between a drag ending and the click it synthesises.
  const suppressClick = useRef(false);
  // While a finger is down this is where the lens actually is, in tab units —
  // 1.5 means "half way between Books and Chats". Null the rest of the time,
  // when the lens simply belongs over `activeIndex`.
  const [dragAt, setDragAt] = useState(null);

  /**
   * The travel, as one explicit animation rather than a CSS transition.
   *
   * A transition needs two painted values to interpolate between, and this
   * component never has them: it is built fresh on every navigation, so its
   * first frame is already the destination. The obvious repair — render the old
   * position, wait a frame, then set the new one — turns out to rest on
   * `requestAnimationFrame`, which does not run at all while the page is
   * hidden. That leaves the lens stranded at the old tab until the reader comes
   * back to the app, at which point it slides for no reason.
   *
   * Keyframes have no such dependency. Both ends are stated outright, the
   * element's own style stays at the destination the whole time, and the
   * compositor runs it. `fill` is not needed and not used: when the animation
   * finishes the style underneath is already correct.
   */
  useLayoutEffect(() => {
    const lens = lensRef.current;
    const from = lastLensIndex;
    lastLensIndex = activeIndex;
    if (!lens || from === activeIndex || typeof lens.animate !== "function") return;
    // Honour the OS switch. The lens still ends up on the right tab — it is the
    // travel that is decoration, not the destination — it simply gets there
    // without the overshoot and the stretch.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    lens.animate(
      [
        // Stretched along the direction of travel and thinned across it, which
        // is what a drop of liquid does when it is pulled — round again by the
        // time it lands.
        { transform: `translate3d(${from * 100}%, -50%, 0) scale(1, 1)` },
        { transform: `translate3d(${(from + activeIndex) / 2 * 100}%, -50%, 0) scale(1.18, 0.92)`, offset: 0.45 },
        { transform: `translate3d(${activeIndex * 100}%, -50%, 0) scale(1, 1)` },
      ],
      { duration: TRAVEL_MS, easing: "cubic-bezier(0.34, 1.42, 0.5, 1)" },
    );
  }, [activeIndex]);

  // Pointer capture, so a finger that slides off the bar mid-drag keeps being
  // this element's finger rather than being handed to whatever is underneath.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    let dragging = false;
    let moved = false;
    let downX = 0;

    const positionOf = (clientX) => {
      const box = rail.getBoundingClientRect();
      const unit = box.width / items.length;
      const raw = (clientX - box.left) / unit - 0.5;
      return Math.min(items.length - 1, Math.max(0, raw));
    };

    function onDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true;
      moved = false;
      downX = e.clientX;
      rail.setPointerCapture?.(e.pointerId);
    }
    function onMove(e) {
      if (!dragging) return;
      // Only once the finger has actually travelled. Without the threshold
      // every tap is a one-pixel drag, and the lens twitches out from under the
      // thumb before the tap it belongs to has even been decided.
      if (!moved && Math.abs(e.clientX - downX) < DRAG_SLOP) return;
      moved = true;
      setDragAt(positionOf(e.clientX));
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      const landed = Math.round(positionOf(e.clientX));
      setDragAt(null);
      // A tap is left to the link underneath it. That is not laziness — it is
      // the only way Enter on a focused tab, a long-press "open in new tab" and
      // a screen reader's activation keep working, all three of which go
      // through the anchor and never through a pointer at all.
      if (!moved) return;

      // A drag has already carried the lens to where it is going, so the tab
      // bar that replaces this one should start there rather than flying back
      // to where the gesture began and travelling again.
      if (items[landed]) lastLensIndex = landed;
      // …and the click the browser is about to synthesise on whatever the
      // finger came up over has to be swallowed, or a drag would navigate twice
      // — once here, once to whichever tab happened to be under the release.
      suppressClick.current = true;
      if (items[landed] && landed !== activeIndex) navigate(items[landed].to);
    }
    function onCancel() {
      dragging = false;
      moved = false;
      setDragAt(null);
    }

    rail.addEventListener("pointerdown", onDown);
    rail.addEventListener("pointermove", onMove);
    rail.addEventListener("pointerup", onUp);
    rail.addEventListener("pointercancel", onCancel);
    return () => {
      rail.removeEventListener("pointerdown", onDown);
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerup", onUp);
      rail.removeEventListener("pointercancel", onCancel);
    };
  }, [activeIndex, items.length, navigate]);

  const shownAt = dragAt ?? activeIndex;
  const dragging = dragAt !== null;
  // Pulled out of round only while a finger has hold of it. The travel between
  // tabs does its own stretching, in the keyframes above.
  const stretch = dragging ? 1.16 : 1;
  const squash = dragging ? 0.94 : 1;

  return (
    // Not `fixed` itself: MobileShell pins the whole bottom stack, and this is
    // the bottom of it. That is what lets a screen put an action bar directly on
    // top of these tabs — the two are adjacent boxes in normal flow, so they
    // meet exactly, with no offset for anybody to compute and get wrong.
    //
    // The padding below the pill is the home-indicator strip. The bar floats
    // clear of it rather than painting over it, which is the point of a bar that
    // floats: the page runs underneath and out to all four edges.
    <nav
      className="px-3 pt-2 w-full mx-auto sm:max-w-xl lg:max-w-2xl"
      style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}
    >
      <div
        ref={railRef}
        className="nav-glass relative rounded-[30px] touch-none select-none"
      >
        <ul className="grid grid-cols-4 py-2.5">
          {items.map((it, i) => (
            <li key={it.to}>
              <NavLink
                to={it.to}
                end={it.to === "/"}
                // Taps navigate through the link, exactly as they always did.
                // Only the click a *drag* leaves behind is swallowed — see the
                // pointer handlers above.
                onClick={(e) => {
                  if (!suppressClick.current) return;
                  suppressClick.current = false;
                  e.preventDefault();
                }}
                draggable={false}
                // "Home (3)" rather than the "Home 3" that the badge's bare
                // number would otherwise be read as — the same shape LikeButton
                // uses for a count beside a label. The truncated "9+" is
                // deliberately not what is announced: the real number is useful
                // to somebody who cannot see how big the dot is.
                aria-label={it.count > 0 ? `${it.label} (${it.count})` : undefined}
                className={({ isActive }) =>
                  "flex flex-col items-center gap-1 py-1 text-[11px] font-medium " +
                  "transition-colors duration-200 " +
                  (isActive ? "text-brand-500" : "text-ink-500")
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className="relative block transition-transform duration-300"
                      // Magnified under the glass. The lens cannot scale the
                      // backdrop it refracts — no filter does that — so the tab
                      // beneath does the growing, and the two together read as
                      // one piece of glass with something enlarged inside it.
                      style={{ transform: `scale(${i === activeIndex ? 1.14 : 1})` }}
                    >
                      <img
                        src={navIconSrc(it.icon, isActive)}
                        alt=""
                        aria-hidden="true"
                        width={22}
                        height={22}
                        style={{ width: 22, height: 22 }}
                        className="shrink-0 select-none"
                        draggable={false}
                      />
                      {it.count > 0 ? (
                        <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                          {it.count > 9 ? "9+" : it.count}
                        </span>
                      ) : null}
                    </span>
                    <span>{it.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Last in the box so it paints over the tabs — see the note above on
            why a lens has to be in front of what it refracts. */}
        <div
          ref={lensRef}
          className="nav-lens"
          aria-hidden="true"
          style={{
            width: `${100 / items.length}%`,
            height: "84%",
            transform:
              `translate3d(${shownAt * 100}%, -50%, 0) scale(${stretch}, ${squash})`,
            // Only the drag transitions; the tab-to-tab travel is the keyframed
            // animation above, and a transition on the same property would
            // fight it for the last few pixels.
            transition: dragging ? "transform 90ms linear" : "none",
          }}
        />
      </div>
    </nav>
  );
}
