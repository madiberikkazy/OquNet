// Who may see somebody else's phone number.
//
// The number is the one piece of a profile that reaches into the physical
// world: it is not a way to say something, it is a way to be called, and it
// outlives the loan that produced it. A handoff needs the two people to be able
// to talk — it does not need either of them to walk away holding the other's
// number for good, and the app now has a chat for exactly that conversation.
//
// So the handoff screens ask here instead of printing what is on the document.
// One rule, one place: three screens showed a number, and three screens would
// have drifted.

/**
 * True when `viewer` is entitled to see `person`'s phone number.
 *
 * Yourself, always. Otherwise the community's admin, and only over their own
 * members: `role` is a global field whose effective scope is the admin's own
 * `communityId` — the security rules read it the same way — so an admin of one
 * community has no more claim on another's members than any reader does.
 */
export function canSeePhone(viewer, person) {
  if (!viewer?.id || !person) return false;
  if (viewer.id === person.id) return true;
  return (
    viewer.role === "admin" &&
    !!viewer.communityId &&
    viewer.communityId === person.communityId
  );
}
