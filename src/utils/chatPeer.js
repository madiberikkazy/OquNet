import { t } from "./i18n.js";

/**
 * The person on the other side of a conversation, as the screens name them.
 *
 * A chat outlives the people in it. An account that has been deleted still has
 * everything it ever said sitting in a thread the other person can open, and
 * that thread has to render — so "no profile" is a name here rather than a
 * missing one, and the row draws exactly like every other row with initials in
 * place of a photo.
 */
export function peerName(user) {
  if (!user) return t.deletedUser;
  const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  if (full) return full;
  return user.nickname ? `@${user.nickname}` : t.deletedUser;
}

/** True when there is nobody left to send to — a deleted or missing account. */
export function isMissingPeer(user) {
  return !user;
}
