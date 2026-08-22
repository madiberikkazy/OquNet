import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import { t } from "../utils/i18n.js";

/**
 * The way to reach the other person in a handoff.
 *
 * It replaced a printed phone number on the three screens where two members
 * arrange to meet — see utils/contactVisibility.js — so it has to be at least
 * as reachable as the thing it replaced: one tap, from the same block, landing
 * in a thread with that person rather than in a list of threads.
 *
 * The self-chat guard lives here rather than at each call site. A chat needs
 * two people, the data layer refuses one with itself outright, and a button
 * that leads to a refusal should not be drawn at all.
 *
 * `compact` is the icon on its own, for a row that already says who it is
 * about; the default is the full-width button a profile has room for.
 */
export default function MessageButton({ userId, compact = false, className = "" }) {
  const { user } = useAuth();
  if (!userId || !user?.id || user.id === userId) return null;

  const icon = (
    <svg width={compact ? 20 : 18} height={compact ? 20 : 18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );

  if (compact) {
    return (
      <Link
        to={`/chats/${userId}`}
        aria-label={t.message}
        title={t.message}
        className={
          "shrink-0 w-10 h-10 rounded-full bg-brand-500 text-white flex items-center justify-center active:scale-95 transition " +
          className
        }
      >
        {icon}
      </Link>
    );
  }

  return (
    // Grey rather than brand-coloured: on a profile it now sits beside the
    // follow button, and two filled buttons of equal weight ask the reader to
    // choose between them. Following is the thing to do on a profile you have
    // just found; writing to a stranger is the quieter, rarer one.
    <Link
      to={`/chats/${userId}`}
      className={
        "w-full btn-secondary flex items-center justify-center gap-2 py-3 rounded-2xl font-semibold " + className
      }
    >
      {icon}
      {t.message}
    </Link>
  );
}
