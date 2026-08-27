import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { LiquidGlass } from "liquid-glass-web-react";
import { useLang } from "../contexts/LanguageContext.jsx";
import { useChats } from "../contexts/ChatContext.jsx";
import { useNotifications } from "../contexts/NotificationContext.jsx";
import { navIconSrc } from "../utils/icons.js";
import { t } from "../utils/i18n.js";

/**
 * The four tabs, under a lens of liquid glass.
 *
 * The icons are files under public/drawable, two per tab — one for the selected
 * state and one for the rest — rather than inline SVG tinted by `currentColor`.
 * Artwork stops being code: replacing an icon everywhere is overwriting one
 * file, and a selected tab is free to be a different drawing rather than the
 * same drawing in a different colour.
 *
 * ── The lens ────────────────────────────────────────────────────────────────
 * `liquid-glass-web-react` does the optics, and the reason to take a dependency
 * for this rather than write it is that the effect is not a *look*, it is a
 * simulation. Apple's glass refracts: a displacement map bends the pixels
 * underneath, harder near the rim than at the centre, with red, green and blue
 * bent by slightly different amounts so the edge splits into colour the way a
 * real lens does. CSS cannot express any of that — `backdrop-filter` blurs,
 * brightens and saturates, and the result reads as frosted plastic laid on top.
 *
 * The library builds an SVG `feDisplacementMap` chain over the live DOM and
 * applies it with `filter` on the content rather than `backdrop-filter` behind
 * it, which is also what makes it work in Safari, where `backdrop-filter: url()`
 * does not exist.
 *
 * So the tabs are its children: the lens refracts them, and they stay live —
 * still links, still tappable, still readable by a screen reader.
 *
 * ── Movement ────────────────────────────────────────────────────────────────
 * Position is driven imperatively through the engine handle rather than by
 * re-rendering with a new `x`. That is the library's own advice and it is the
 * difference between one composited filter update and a React render per frame.
 *
 * The lens can also be dragged along the bar, which is what makes it feel like
 * an object rather than four buttons. Deliberately scoped to the bar and not to
 * the page: a horizontal swipe anywhere on a screen would fight the shelf rails
 * and the coverflow, which scroll sideways on purpose.
 */

/**
 * Where the lens was last left, in tab units.
 *
 * Module level, and it has to be: every screen renders its own MobileShell, so
 * every navigation tears this component down and builds a new one. A position
 * held in state would be born equal to the tab that was just opened, the lens
 * would be drawn at its destination on the very first frame, and there would be
 * nothing left to animate. Kept out here, a fresh tab bar knows where the old
 * one's lens was and can travel from it.
 */
let lastLensIndex = 0;
/**
 * False until the first tab bar of the session has mounted.
 *
 * The very first one must not travel. `lastLensIndex` starts at zero, so
 * opening the app straight onto Books — a deep link, a refresh, a shortcut —
 * would otherwise slide the lens over from Home on load, animating a move that
 * never happened.
 */
let lensPlaced = false;

/** How long the lens takes to cross, and how far a finger must move to count. */
const TRAVEL_MS = 420;
const DRAG_SLOP = 6;

/** Ease-out with a small overshoot — the settle a blob of liquid has. */
function easeOutBack(x) {
  const c1 = 1.15;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

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
  const tabs = items.length;

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
  // Where the lens starts life, so the travel below has somewhere to come from.
  // On the session's first bar that is wherever we already are, so it is simply
  // drawn in place.
  const [startIndex] = useState(() => {
    if (!lensPlaced) { lensPlaced = true; lastLensIndex = activeIndex; }
    return lastLensIndex;
  });

  /** A tab index as the fraction of the bar's width the engine wants. */
  const fractionFor = (index) => (index + 0.5) / tabs;

  // The lens is sized in pixels, so the bar has to be measured.
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const measure = () => {
      const box = rail.getBoundingClientRect();
      setSize((prev) => (
        Math.round(prev.w) === Math.round(box.width) &&
        Math.round(prev.h) === Math.round(box.height)
          ? prev
          : { w: box.width, h: box.height }
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  // ── The travel ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const handle = lensRef.current;
    const from = lastLensIndex;
    lastLensIndex = activeIndex;
    if (!handle || from === activeIndex) return undefined;

    // Honour the OS switch. The lens still ends up on the right tab — it is the
    // travel that is decoration, not the destination.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      handle.setPosition(fractionFor(activeIndex), 0.5);
      return undefined;
    }

    let frame = 0;
    let startedAt = null;
    const step = (now) => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / TRAVEL_MS);
      const at = from + (activeIndex - from) * easeOutBack(progress);
      handle.setPosition(fractionFor(at), 0.5);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, tabs]);

  // ── Dragging ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    let dragging = false;
    let moved = false;
    let downX = 0;

    /** Where along the bar a clientX is, in tab units, clamped to the ends. */
    const positionOf = (clientX) => {
      const box = rail.getBoundingClientRect();
      const raw = (clientX - box.left) / (box.width / tabs) - 0.5;
      return Math.min(tabs - 1, Math.max(0, raw));
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
      lensRef.current?.setPosition(fractionFor(positionOf(e.clientX)), 0.5);
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      // A tap is left to the link underneath it. That is not laziness — it is
      // the only way Enter on a focused tab, a long-press "open in new tab" and
      // a screen reader's activation keep working, all three of which go
      // through the anchor and never through a pointer at all.
      if (!moved) return;

      const landed = Math.round(positionOf(e.clientX));
      lensRef.current?.setPosition(fractionFor(landed), 0.5);
      // A drag has already carried the lens to where it is going, so the tab
      // bar that replaces this one starts there rather than flying back to
      // where the gesture began and travelling again.
      lastLensIndex = landed;
      // …and the click the browser is about to synthesise on whatever the
      // finger came up over has to be swallowed, or a drag would navigate twice.
      suppressClick.current = true;
      if (items[landed] && landed !== activeIndex) navigate(items[landed].to);
    }
    function onCancel() {
      dragging = false;
      moved = false;
      lensRef.current?.setPosition(fractionFor(activeIndex), 0.5);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, tabs, navigate]);

  // The bead is one tab wide and most of the bar tall — the proportions of the
  // one in iOS, where it reads as a single button's worth of glass rather than
  // a moving panel.
  const measured = size.w > 0 && size.h > 0;

  /**
   * The bar itself: the painted surface and the four tabs.
   *
   * A variable because it is rendered two ways — bare on the first pass, and
   * inside the lens once the bar has been measured. Rendering nothing until
   * then would mean a frame with an empty bar, which is far worse than a frame
   * without the bead.
   */
  const bar = (
    <div className="nav-surface rounded-[30px]">
      <ul className="grid grid-cols-4 py-2.5">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.to === "/"}
              // Taps navigate through the link, exactly as they always did.
              // Only the click a *drag* leaves behind is swallowed.
              onClick={(e) => {
                if (!suppressClick.current) return;
                suppressClick.current = false;
                e.preventDefault();
              }}
              draggable={false}
              // "Home (3)" rather than the "Home 3" that the badge's bare number
              // would otherwise be read as — the same shape LikeButton uses for
              // a count beside a label. The truncated "9+" is deliberately not
              // what is announced: the real number is useful to somebody who
              // cannot see how big the dot is.
              aria-label={it.count > 0 ? `${it.label} (${it.count})` : undefined}
              className={({ isActive }) =>
                "flex flex-col items-center gap-1 py-1 text-[11px] font-medium " +
                "transition-colors duration-200 " +
                (isActive ? "text-brand-500" : "text-ink-500")
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative block">
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
    </div>
  );

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
      {/* `overflow-hidden`, and it is not tidiness. An SVG filter paints into a
          region larger than the element it is applied to — the default is 10%
          of the box in every direction — and a displacement map pushes real
          pixels out there: a smear of the bar's surface and a torn-off piece of
          the selected icon, floating above and below the pill where nothing is
          meant to be. Clipping to the pill's own rounded box is what keeps the
          bead of glass inside the bar it is riding on. */}
      <div
        ref={railRef}
        className="relative rounded-[30px] overflow-hidden touch-none select-none"
      >
        {/* Mounted only once the bar has been measured, and rebuilt from
            scratch when that measurement changes.

            The engine is constructed in a layout effect from the props of the
            render that created it, and a later size reaches it through a
            regeneration scheduled on `requestAnimationFrame`. Both halves of
            that matter here. The bar cannot be measured until it exists, so the
            first render has no honest number to give — and a guess is what the
            lens then keeps, because the correction is one frame away and a
            frame is not guaranteed: on a backgrounded page it never comes. The
            symptom is a bead sized for one bar sitting on a bar of another
            width, which is not subtle.

            Waiting a render costs nothing visible, and the `key` handles the
            rest: a breakpoint change or a rotation replaces the lens outright
            rather than asking it to resize. */}
        {measured ? (
          <LiquidGlass
            key={`${Math.round(size.w)}x${Math.round(size.h)}`}
            ref={lensRef}
            x={fractionFor(startIndex)}
            y={0.5}
            width={size.w / tabs}
            height={size.h * 0.86}
            radius="auto"
            // Close to the library's defaults, which are already tuned for this
            // effect; only the rim is thinned, because the bead here is one tab
            // wide and a 10px edge on it leaves almost no flat centre. The
            // chromatic aberration is the default 0.2 and is left alone — the
            // colour split at the rim is the detail that reads as glass.
            depth={8}
            glow={0.35}
            edgeHighlight={0.5}
            shadow="0 2px 8px rgba(0, 0, 0, 0.14)"
          >
            {bar}
          </LiquidGlass>
        ) : bar}
      </div>
    </nav>
  );
}
