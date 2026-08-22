/**
 * Virtual list component - renders only visible items
 * Dramatically improves performance when dealing with hundreds/thousands of items
 *
 * Three variants, and picking the wrong one is the usual reason this file gets
 * blamed for a broken layout:
 *
 *   VirtualList          — fixed row height, inside its OWN scrollport. Needs a
 *                          `containerHeight`, and the page around it must not
 *                          scroll, or you get two nested scrollbars.
 *   VirtualListVariable  — as above, with a per-row height array.
 *   WindowVirtualList    — fixed row height, scrolled by the DOCUMENT. This is
 *                          the one almost every screen in this app wants: see
 *                          MobileShell, which deliberately has no inner
 *                          scrollport so that its header can be `sticky`.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

export function VirtualList({
  items = [],
  itemHeight = 100,
  containerHeight = 400,
  renderItem,
  overscan = 3,
  keyExtractor = (item, idx) => idx,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef(null);

  // Calculate visible range
  const visibleRange = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(
      items.length,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
    );
    return { startIndex, endIndex };
  }, [scrollTop, itemHeight, containerHeight, items.length, overscan]);

  const visibleItems = useMemo(
    () =>
      items.slice(visibleRange.startIndex, visibleRange.endIndex).map((item, idx) => ({
        item,
        index: visibleRange.startIndex + idx,
      })),
    [items, visibleRange]
  );

  const offsetY = visibleRange.startIndex * itemHeight;
  const spacerHeight = (items.length - visibleRange.endIndex) * itemHeight;

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        height: containerHeight,
        overflow: "auto",
        position: "relative",
      }}
    >
      <div style={{ transform: `translateY(${offsetY}px)` }}>
        {visibleItems.map(({ item, index }) => (
          <div key={keyExtractor(item, index)} style={{ height: itemHeight }}>
            {renderItem(item, index)}
          </div>
        ))}
      </div>
      {spacerHeight > 0 && <div style={{ height: spacerHeight }} />}
    </div>
  );
}

/**
 * Virtual list variant for variable height items
 * Requires itemHeights array for accurate calculations
 */
export function VirtualListVariable({
  items = [],
  itemHeights = [],
  containerHeight = 400,
  renderItem,
  overscan = 3,
  keyExtractor = (item, idx) => idx,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef(null);

  // Calculate cumulative heights
  const cumulativeHeights = useMemo(() => {
    const heights = [0];
    let total = 0;
    itemHeights.forEach((h) => {
      total += h;
      heights.push(total);
    });
    return heights;
  }, [itemHeights]);

  // Find visible range
  const visibleRange = useMemo(() => {
    let startIndex = 0;
    let endIndex = items.length;

    for (let i = 0; i < cumulativeHeights.length - 1; i++) {
      if (cumulativeHeights[i] >= scrollTop - itemHeights[i] * overscan) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
    }

    for (let i = startIndex; i < cumulativeHeights.length; i++) {
      if (cumulativeHeights[i] > scrollTop + containerHeight + itemHeights[i] * overscan) {
        endIndex = Math.min(items.length, i + overscan);
        break;
      }
    }

    return { startIndex, endIndex };
  }, [scrollTop, cumulativeHeights, containerHeight, itemHeights, items.length, overscan]);

  const visibleItems = useMemo(
    () =>
      items.slice(visibleRange.startIndex, visibleRange.endIndex).map((item, idx) => ({
        item,
        index: visibleRange.startIndex + idx,
      })),
    [items, visibleRange]
  );

  const offsetY = cumulativeHeights[visibleRange.startIndex] || 0;
  const spacerHeight = (cumulativeHeights[items.length] || 0) - (cumulativeHeights[visibleRange.endIndex] || 0);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        height: containerHeight,
        overflow: "auto",
        position: "relative",
      }}
    >
      <div style={{ transform: `translateY(${offsetY}px)` }}>
        {visibleItems.map(({ item, index }) => (
          <div key={keyExtractor(item, index)}>
            {renderItem(item, index)}
          </div>
        ))}
      </div>
      {spacerHeight > 0 && <div style={{ height: spacerHeight }} />}
    </div>
  );
}

/**
 * The window-scrolled virtualiser.
 *
 * ── Why the other two do not fit this app ───────────────────────────────────
 *
 * Both of them own a scrollport: a fixed-height div with `overflow: auto`.
 * MobileShell has none, on purpose — `<main>` carried `overflow-y-auto` once
 * and it silently broke every sticky header in the app, which is documented at
 * length in MobileShell.jsx. Dropping either variant into a screen would put
 * that scrollport back, one list at a time.
 *
 * So this one measures against the viewport instead. It renders a plain block
 * in normal flow, works out which slice of the list currently intersects the
 * window, and reserves the space above and below with padding.
 *
 * ── Padding, not transform ──────────────────────────────────────────────────
 *
 * The offset is `paddingTop`, not `translateY`. A transform — even an identity
 * one — makes an element the containing block for every `position: fixed`
 * descendant, which in this app means the action bar, the FAB and every modal
 * rendered from a row. That trap has already been paid for twice here; see the
 * note on `.page-transition` in index.css.
 *
 * ── Measurement ─────────────────────────────────────────────────────────────
 *
 * `itemHeight` must be the real rendered height including borders and margins.
 * Too small and the list under-renders, leaving a blank strip at the bottom of
 * the viewport during a fast scroll; too large only costs extra rows. When in
 * doubt, round up.
 *
 * Rows are measured from the container's own position on the page rather than
 * from `window.scrollY`, so it does not care what is above it — a sticky
 * header, a genre bar, a horizontal rail — or whether any of that changes
 * height while the reader is scrolling.
 */
export function WindowVirtualList({
  items = [],
  itemHeight,
  renderItem,
  keyExtractor = (item, idx) => idx,
  // Six rows of slack above and below the viewport. Enough that a flick does
  // not outrun the next frame's measurement, small enough that the DOM stays
  // a fraction of the list.
  overscan = 6,
  className = "",
}) {
  const containerRef = useRef(null);
  const [range, setRange] = useState(() => ({
    start: 0,
    // A first render wide enough to fill any phone, so the list is not
    // visibly empty for the frame before the first measurement lands.
    end: Math.min(items.length, 20),
  }));

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el || items.length === 0) return;

    const rect = el.getBoundingClientRect();
    // How far the top of the list is above the top of the viewport. Zero while
    // the list starts below the fold, which is the case that must render from
    // index 0 rather than from a negative one.
    const scrolledPast = Math.max(0, -rect.top);
    const viewport = window.innerHeight || 0;

    const start = Math.max(0, Math.floor(scrolledPast / itemHeight) - overscan);
    const visible = Math.ceil(viewport / itemHeight) + overscan * 2;
    const end = Math.min(items.length, start + visible);

    // Bail out when nothing moved. Without this every scroll frame sets state
    // and re-renders the slice, which costs more than the virtualisation saves.
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [items.length, itemHeight, overscan]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      // One measurement per frame. A scroll listener fires far more often than
      // that, and every extra call reads layout — which forces a synchronous
      // reflow in the middle of the browser's own scrolling.
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [measure]);

  const visibleItems = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.start, range.end]
  );

  // Clamped because `items` can shrink between a measurement and this render —
  // a filter applied, a page invalidated — and a negative padding would drag
  // the list up over whatever is above it.
  const padTop = Math.max(0, range.start) * itemHeight;
  const padBottom = Math.max(0, items.length - range.end) * itemHeight;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ paddingTop: padTop, paddingBottom: padBottom }}
    >
      {visibleItems.map((item, i) => {
        const index = range.start + i;
        return (
          <div key={keyExtractor(item, index)} style={{ height: itemHeight }}>
            {renderItem(item, index)}
          </div>
        );
      })}
    </div>
  );
}
