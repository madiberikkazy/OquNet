// Placeholders shaped like the thing that is coming.
//
// The screens used to answer a pending query with the word "Загрузка…" on an
// otherwise empty page. That reads as *nothing is here* rather than *this is
// filling in*, and it costs a full re-layout the moment the data lands: the
// list pushes the header, the header pushes the tab bar, and the reader's
// thumb ends up over a different row than the one they were aiming at.
//
// A skeleton fixes both halves. It occupies the same box the real row will,
// so nothing jumps, and its motion says the app is working rather than idle.
//
// Rules for anything added here:
//   - match the real component's box exactly (same paddings, same heights) —
//     a skeleton that is the wrong size is worse than no skeleton;
//   - `aria-hidden` on the shapes and one `role="status"` on the group, so a
//     screen reader hears "loading" once instead of reading out empty divs;
//   - respect `prefers-reduced-motion` — handled centrally by the
//     `.skeleton` class in index.css.

/** One shimmering block. Size it with Tailwind classes. */
export function Skeleton({ className = "" }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/**
 * A paragraph of `lines` bars. The last one is short, because real text
 * almost never fills its final line and a stack of equal bars reads as a
 * table rather than prose.
 */
export function SkeletonText({ lines = 2, className = "" }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={`h-3 rounded ${i === lines - 1 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </div>
  );
}

/** Mirrors BookCard's row: 68×88 cover, then title / author / badge line. */
export function BookCardSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-3 border-b border-ink-100 last:border-b-0">
      <Skeleton className="w-[68px] h-[88px] rounded-md shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4 rounded" />
          <Skeleton className="h-3 w-1/2 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/** Mirrors PostCard: avatar + name line, body, then the action row. */
export function PostCardSkeleton() {
  return (
    <div className="px-4 py-4 border-b border-ink-100">
      <div className="flex items-center gap-3 mb-3">
        <Skeleton className="w-10 h-10 rounded-full shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-32 rounded" />
          <Skeleton className="h-3 w-20 rounded" />
        </div>
      </div>
      <SkeletonText lines={3} />
      <div className="flex items-center gap-5 mt-3">
        <Skeleton className="h-4 w-10 rounded" />
        <Skeleton className="h-4 w-10 rounded" />
        <Skeleton className="h-4 w-10 rounded" />
      </div>
    </div>
  );
}

/** The cover grid on the genre screen and the "new books" rail. */
export function BookCoverSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="w-full aspect-[2/3] rounded-lg" />
      <Skeleton className="h-3 w-4/5 rounded" />
    </div>
  );
}

/**
 * The book page above the fold: the 110×145 cover, the title block beside it,
 * then the first slab of description. Everything below that (ratings, the
 * journey) is layered in as it arrives, so it is not drawn here.
 */
export function BookDetailSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <div className="px-4 pb-1">
        <Skeleton className="w-10 h-10 rounded-xl" />
      </div>
      <div className="px-4 pt-4 flex gap-3">
        <Skeleton className="w-[110px] h-[145px] rounded-lg shrink-0" />
        <div className="flex-1 flex flex-col gap-2 py-1">
          <Skeleton className="h-6 w-4/5 rounded" />
          <Skeleton className="h-4 w-1/2 rounded" />
          <Skeleton className="h-3 w-1/3 rounded" />
          <div className="mt-2 flex gap-2">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        </div>
      </div>
      <div className="px-4 pt-6">
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

/** A row in any people list — followers, members, chat candidates. */
export function PersonRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-100 last:border-b-0">
      <Skeleton className="w-11 h-11 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3 rounded" />
        <Skeleton className="h-3 w-1/4 rounded" />
      </div>
      <Skeleton className="h-8 w-20 rounded-full shrink-0" />
    </div>
  );
}

/**
 * `count` copies of one skeleton, wrapped in the single live region.
 *
 * `label` is what assistive tech announces; pass the translated "loading"
 * string. Everything visual inside stays `aria-hidden`.
 */
export function SkeletonList({ count = 6, label = "Loading", children, Item }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{Item ? <Item /> : children}</div>
      ))}
    </div>
  );
}
