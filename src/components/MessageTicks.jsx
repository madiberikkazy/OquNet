import { MESSAGE_STATUS } from "../firebase/firestore.js";
import { t } from "../utils/i18n.js";

/**
 * The tick beside one of the reader's own messages.
 *
 * Four states, and the difference between the last two is the whole point:
 * `delivered` says the message is on the other person's device, `read` says
 * they have opened the thread since it arrived. Where those facts come from —
 * two watermarks on the chat document, written by the other device and nobody
 * else — is in the receipts note in firebase/schema.js.
 *
 * Drawn as one glyph rather than one-or-two ticks in a row so the bubble's
 * width does not jump as a message settles: the pair occupies the same box as
 * the single, with the second tick simply absent.
 *
 * Never drawn on an incoming message. A tick reports what happened to something
 * you sent; on the other person's message it would be reporting on yourself.
 */
export default function MessageTicks({ status, className = "" }) {
  const label = {
    [MESSAGE_STATUS.pending]: t.chatStatusSending,
    [MESSAGE_STATUS.sent]: t.chatStatusSent,
    [MESSAGE_STATUS.delivered]: t.chatStatusDelivered,
    [MESSAGE_STATUS.read]: t.chatStatusRead,
  }[status] ?? "";

  if (status === MESSAGE_STATUS.pending) {
    return (
      <span className={"inline-flex items-center " + className} role="img" aria-label={label} title={label}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" opacity="0.7" />
          <path d="M12 8.5V12l2.5 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  const double = status === MESSAGE_STATUS.delivered || status === MESSAGE_STATUS.read;

  return (
    <span
      className={
        "inline-flex items-center " +
        // Read is the one state that gets a colour of its own. It has to survive
        // being drawn on the brand-blue bubble, where a mid-blue tick would be
        // invisible — hence a light cyan rather than the usual accent.
        (status === MESSAGE_STATUS.read ? "text-[#7fe3ff] " : "") +
        className
      }
      role="img"
      aria-label={label}
      title={label}
    >
      <svg width="16" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
        <path
          d="M1 7.5 4.5 11 11.5 3"
          stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
        />
        {double ? (
          <path
            d="M8.5 7.5 12 11 19 3"
            stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
          />
        ) : null}
      </svg>
    </span>
  );
}
