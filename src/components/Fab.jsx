import { Link } from "react-router-dom";

/**
 * The round "+" in the bottom-right corner.
 *
 * `fixed` is the variant for a screen you scroll: the button stays where it is
 * while the list moves under it. The default stays absolute, which is what a
 * short, self-contained screen wants — and is how this was used before the Home
 * feed needed one, so that behaviour is left exactly where it was.
 *
 * The fixed variant is pinned to the *content column* rather than to the window,
 * because on a wide screen the app is a centred phone-width column and a button
 * glued to the far right edge of a desktop monitor belongs to nothing. The
 * full-width strip that positions it is click-through — only the button itself
 * takes a tap — so it cannot swallow taps on the feed behind it.
 */
export default function Fab({ to, onClick, ariaLabel = "Add", fixed = false }) {
  const inner = (
    <span className="bg-brand-500 hover:bg-brand-600 text-white w-14 h-14 rounded-2xl flex items-center justify-center shadow-soft transition active:scale-95">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
  const button = to
    ? <Link to={to} aria-label={ariaLabel}>{inner}</Link>
    : <button onClick={onClick} aria-label={ariaLabel}>{inner}</button>;

  if (!fixed) {
    return <div className="absolute right-4 bottom-24 z-10">{button}</div>;
  }

  return (
    // Clear of the tab bar, which is `fixed` at the bottom and z-50 — this sits
    // under it in the stack and above it on the screen, so the two never meet.
    <div className="fixed inset-x-0 bottom-24 z-40 pointer-events-none">
      <div className="w-full mx-auto sm:max-w-xl lg:max-w-2xl flex justify-end pr-4">
        <span className="pointer-events-auto">{button}</span>
      </div>
    </div>
  );
}
