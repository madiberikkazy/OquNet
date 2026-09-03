/**
 * Who is calling.
 *
 * The registration endpoints take a Firebase ID token in the Authorization
 * header and verify it here, which is the whole security model: a device can
 * only ever be filed against the account that actually holds the session. The
 * client does not get to say whose token it is registering.
 *
 * Returns null rather than throwing — every route treats "no verifiable
 * identity" as 401 and nothing else.
 */

import { getAuth } from "firebase-admin/auth";

export async function callerUid(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid || null;
  } catch {
    return null;
  }
}
